// ==UserScript==
// @name         YouTube Watched Indicator
// @namespace    https://github.com/azrobbins/YouTube-Watched-Indicator
// @version      0.4.0
// @description  Local watched-state icons on YouTube thumbnails. Measures how much of each video you watch (no reliance on YouTube watch history) and stores it in Tampermonkey only. Empty / half / full circle = unseen / partially / fully watched.
// @author       VitaKaninen
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/YouTube-Watched-Indicator/main/youtube-watched-indicator.user.js
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/YouTube-Watched-Indicator/main/youtube-watched-indicator.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const STORE_KEY      = 'ywi.watched.v1';   // GM storage key: { videoId: maxFraction }
  const SAMPLE_MS      = 2000;               // safety-net re-sample interval (events are the primary capture path)
  const FLUSH_MS       = 1500;               // debounce before persisting to GM storage
  const SWEEP_MS       = 200;                // debounce before re-decorating after DOM changes
  const T_PARTIAL      = 0.05;               // >= this fraction -> "half" (red)
  const T_FULL         = 0.50;               // >  this fraction -> "full" (green)
  const ICON_SIZE      = 22;                 // px icon size
  const AVATAR_GAP     = 16;                 // px gap below the channel avatar (grid cards)
  const GUTTER_OFFSET  = 20;                 // px left of the metadata row (fallback for list cards, e.g. search)
  const SHORTS_ICON    = 18;                 // px icon size for the inline Shorts badge (sized to the 14px view-count text)
  const SHORTS_GAP     = 5;                  // px gap between the Shorts badge and the view count

  // ---------------------------------------------------------------------------
  // Storage  (in-memory map, debounced flush; monotonic max-fraction per video)
  // ---------------------------------------------------------------------------
  let watched = {};
  let dirty = false;
  let flushTimer = null;

  function loadStore() {
    try { watched = JSON.parse(GM_getValue(STORE_KEY, '{}')) || {}; }
    catch (e) { watched = {}; }
  }
  function flush() {
    if (!dirty) return;
    GM_setValue(STORE_KEY, JSON.stringify(watched));
    dirty = false;
  }
  // Throttle, NOT debounce. A debounce here (clear + reset on every call) gets STARVED during
  // playback: timeupdate fires ~4x/s, so a 1.5s timer that resets every ~250ms never fires until
  // playback stops — silently dropping every video you don't pause for >1.5s. This schedules at most
  // one flush per FLUSH_MS and lets it fire, guaranteeing periodic persistence while watching.
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
  }
  function record(id, frac) {
    if (!id || !(frac > 0)) return;
    const prev = watched[id] || 0;
    if (frac > prev) {
      const crossed = stateFor(frac) !== stateFor(prev);  // empty->half or half->full?
      watched[id] = Math.round(frac * 1000) / 1000;       // 0.001 precision is plenty
      dirty = true;
      scheduleFlush();
      if (crossed) scheduleSweep();                        // only redraw badges when the icon would change
    }
  }
  // Persist promptly when we might lose the player. Sample FIRST so the latest position is captured
  // before it goes away. SPA navigation away from a video does NOT fire pagehide/visibilitychange,
  // so yt-navigate-start is the one that matters for click-to-next-video.
  function sampleAndFlush() { sampleNow(); flush(); }
  // visibilitychange is dispatched on `document`; some browsers (incl. Firefox/LibreWolf) don't fire
  // it on `window`, so listen on document or the tab-switch flush is silently skipped there.
  document.addEventListener('visibilitychange', () => { if (document.hidden) sampleAndFlush(); });
  window.addEventListener('pagehide', sampleAndFlush);
  window.addEventListener('beforeunload', sampleAndFlush);
  window.addEventListener('yt-navigate-start', sampleAndFlush);

  // ---------------------------------------------------------------------------
  // Capture  (EVENT-DRIVEN: every playback tick AND every manual seek updates the stored max
  // fraction. No dependence on a polling window or on reaching a particular spot — moving the
  // slider past a threshold by any means, even with the video paused/never-played, is enough.)
  // ---------------------------------------------------------------------------
  function currentVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  function isAdShowing() {
    const p = document.querySelector('#movie_player, #shorts-player, .html5-video-player');
    return !!(p && p.classList.contains('ad-showing'));
  }
  // The watch player's own <video> — also what the shorts->/watch redirect lands on. Scoped to the
  // player element so a thumbnail hover-preview's inline <video> can never be sampled.
  function mainVideo() {
    const p = document.querySelector('#movie_player, #shorts-player');
    if (p) { const v = p.querySelector('video'); if (v) return v; }
    // Native /shorts/ feed (no redirect): several reel players can coexist — take the one actually
    // playing (the short in view), else the first with a loaded source. Gated to /shorts/ so this
    // broad fallback never grabs a hover-preview <video> on other pages.
    if (location.pathname.startsWith('/shorts/')) {
      const vids = [...document.querySelectorAll('video')];
      return vids.find(v => !v.paused && (v.currentSrc || v.src))
          || vids.find(v => v.currentSrc || v.src)
          || null;
    }
    return null;
  }

  // `activeId` = the id of the video CURRENTLY loaded in the player. It is updated only from the
  // video element's own load events (loadedmetadata / durationchange), which fire once the URL has
  // settled on the new video — never straight from the URL. That ordering is what stops a stray
  // late event from the previous video being attributed to the new id during an SPA navigation.
  let boundVideo = null;
  let activeId = null;

  function sampleNow(e) {
    if (!activeId) return;
    if (isAdShowing()) return;                          // currentTime/duration belong to the ad — ignore
    const v = (e && e.target && 'duration' in e.target) ? e.target : mainVideo();
    if (!v) return;
    const d = v.duration;
    if (!d || !isFinite(d) || d <= 0) return;          // live stream (Infinity) / metadata not ready
    record(activeId, Math.min(1, v.currentTime / d));
  }

  function bindVideo() {
    const v = mainVideo();
    if (!v || v === boundVideo) return;                // already bound to this element
    boundVideo = v;
    // All of these can move the playhead; they funnel into one sampler. timeupdate covers normal
    // playback; seeking/seeked catch manual scrubbing (fire even while paused and even if the video
    // never started) — so dragging the slider past a threshold is recorded immediately.
    ['timeupdate', 'seeking', 'seeked', 'pause', 'play', 'playing', 'ratechange', 'progress', 'loadeddata', 'canplay']
      .forEach(ev => v.addEventListener(ev, sampleNow, { passive: true }));
    // Lifecycle: re-align activeId to whatever video is now loaded; clear it between videos so a
    // stray tick in the gap can't be misfiled. ended -> count as fully watched.
    v.addEventListener('loadedmetadata', () => { activeId = currentVideoId(); sampleNow(); }, { passive: true });
    v.addEventListener('durationchange', () => { activeId = currentVideoId(); sampleNow(); }, { passive: true });
    v.addEventListener('emptied', () => { activeId = null; }, { passive: true });
    v.addEventListener('ended', () => { if (activeId) record(activeId, 1); }, { passive: true });
    activeId = currentVideoId();                        // the element may already be loaded when we bind
    sampleNow();
  }

  // Safety net only (events above are the primary path). Also (re)binds when the player's <video>
  // first appears or gets swapped out.
  setInterval(() => { bindVideo(); sampleNow(); }, SAMPLE_MS);

  // ---------------------------------------------------------------------------
  // Icons  (three discrete states; ring uses currentColor so it adapts to theme)
  // Built via the DOM, not innerHTML — YouTube enforces Trusted Types, which
  // blocks string-based HTML assignment.
  // ---------------------------------------------------------------------------
  const NS = 'http://www.w3.org/2000/svg';
  function svgChild(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function buildIcon(state, size = ICON_SIZE) {
    const svg = svgChild('svg', { viewBox: '0 0 16 16', width: size, height: size });
    svg.style.display = 'block';
    if (state === 'full') {
      svg.appendChild(svgChild('circle', { cx: 8, cy: 8, r: 7, fill: '#2ba640' }));
    } else if (state === 'half') {
      svg.appendChild(svgChild('path', { d: 'M8 1.5 A6.5 6.5 0 0 0 8 14.5 Z', fill: '#e53935' }));
      svg.appendChild(svgChild('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, opacity: 0.8 }));
    } else {
      svg.appendChild(svgChild('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, opacity: 0.55 }));
    }
    return svg;
  }
  function stateFor(frac) {
    if (frac > T_FULL) return 'full';
    if (frac >= T_PARTIAL) return 'half';
    return 'empty';
  }

  // ---------------------------------------------------------------------------
  // Decoration  (handles BOTH DOM regimes: legacy ytd-* and new view-models)
  // ---------------------------------------------------------------------------
  function idFromCard(root) {
    if (!root) return null;
    const a = root.querySelector(
      'a#thumbnail[href], a#video-title-link[href], a.yt-lockup-view-model-wiz__content-image[href], ' +
      'a[href*="/watch?v="], a[href*="/shorts/"]'
    );
    const href = a && a.getAttribute('href');
    if (!href) return null;
    let m = href.match(/[?&]v=([\w-]{11})/); if (m) return m[1];
    m = href.match(/\/shorts\/([\w-]{11})/); if (m) return m[1];
    return null;
  }

  // Grid-style cards have a channel avatar with empty gutter beneath it. Anchoring under the avatar
  // keeps the icon's vertical position fixed no matter how many lines the title wraps to.
  function avatarOf(card) {
    if (card.matches('yt-lockup-view-model, ytd-rich-item-renderer, ytd-rich-grid-media')) {
      return card.querySelector('yt-decorated-avatar-view-model, yt-img-shadow#avatar, #avatar');
    }
    return null;  // list-style cards (e.g. search results) -> fall back to the metadata-row gutter
  }
  function placeUnderAvatar(avatar, badge) {
    if (getComputedStyle(avatar).position === 'static') avatar.style.position = 'relative';
    Object.assign(badge.style, {
      position: 'absolute',
      left: '50%',
      top: '100%',
      transform: `translate(-50%, ${AVATAR_GAP}px)`,
      pointerEvents: 'none',
      lineHeight: '0',
      color: 'inherit',
      zIndex: '1'
    });
    avatar.appendChild(badge);
  }
  function placeInGutter(row, badge) {
    if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
    Object.assign(badge.style, {
      position: 'absolute',
      left: `-${GUTTER_OFFSET}px`,
      top: '50%',
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
      lineHeight: '0',
      color: 'inherit'
    });
    row.appendChild(badge);
  }
  // Shorts cards have neither an avatar gutter nor a metadata-view-model, so the badge sits inline to
  // the LEFT of the view-count subhead (making it a flex row pushes the count right). color is pinned
  // to the subhead text color so the empty/half ring adapts to theme, as in the other regimes.
  function placeBesideViews(sub, badge) {
    sub.style.display = 'flex';
    sub.style.alignItems = 'center';
    Object.assign(badge.style, {
      lineHeight: '0',
      marginRight: `${SHORTS_GAP}px`,
      flex: '0 0 auto',
      color: getComputedStyle(sub).color
    });
    sub.insertBefore(badge, sub.firstChild);
  }

  // Set the badge's icon + tooltip from the stored fraction for `id`. Shared by all card regimes.
  function applyBadgeState(badge, id, size = ICON_SIZE) {
    const frac = watched[id] || 0;
    const state = stateFor(frac);
    if (badge.dataset.state !== state) {
      badge.dataset.state = state;
      badge.replaceChildren(buildIcon(state, size));
    }
    badge.title = `${Math.round(frac * 100)}% watched`;
  }

  function decorateRow(row) {
    const card = row.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ' +
      'ytd-compact-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model'
    ) || row;
    const id = idFromCard(card);
    if (!id) return;

    let badge = card.querySelector('.ywi-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ywi-badge';
      const avatar = avatarOf(card);
      if (avatar) placeUnderAvatar(avatar, badge);
      else placeInGutter(row, badge);
      // Pin the ring color to the card's metadata-text color. Otherwise currentColor inherits
      // from the anchor element — black inside the avatar — and the empty/half ring vanishes
      // against a dark background. Reading the live text color adapts to light/dark theme.
      const textEl = row.querySelector('.ytContentMetadataViewModelMetadataText, span') || row;
      badge.style.color = getComputedStyle(textEl).color;
    }
    applyBadgeState(badge, id);
  }

  // Shorts regime: ytm-shorts-lockup-view-model[-v2] (the -v2 wraps the older inner element). No
  // metadata-view-model and no avatar, so we overlay the badge on the thumbnail. Normalizing to the
  // outermost host means the inner+outer matches collapse to one card, so the badge-exists guard
  // dedupes; a standalone (un-wrapped) inner host still decorates on its own.
  function decorateShort(el) {
    const card = el.closest('ytm-shorts-lockup-view-model-v2') || el.closest('ytm-shorts-lockup-view-model');
    if (!card) return;
    const id = idFromCard(card);
    if (!id) return;
    const sub = card.querySelector('.shortsLockupViewModelHostOutsideMetadataSubhead, .shortsLockupViewModelHostMetadataSubhead');
    if (!sub) return;                                    // no view-count row -> nowhere to anchor
    let badge = sub.querySelector('.ywi-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ywi-badge';
      placeBesideViews(sub, badge);
    }
    applyBadgeState(badge, id, SHORTS_ICON);
  }

  function sweep() {
    // Legacy regime: the views/time row is #metadata-line.
    document.querySelectorAll('#metadata-line').forEach(decorateRow);
    // New regime: the metadata block is yt-content-metadata-view-model.
    document.querySelectorAll('yt-content-metadata-view-model').forEach(decorateRow);
    // Shorts regime: distinct DOM, badge overlaid on the thumbnail.
    document.querySelectorAll('ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model').forEach(decorateShort);
  }

  let sweepTimer = null;
  function scheduleSweep() {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, SWEEP_MS);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  loadStore();
  new MutationObserver(() => { scheduleSweep(); bindVideo(); }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', () => { scheduleSweep(); bindVideo(); });
  scheduleSweep();
  bindVideo();

  // Maintenance helpers in the Tampermonkey menu.
  GM_registerMenuCommand('Export watched data (JSON to console)', () => {
    console.log('[YWI] watched data:', JSON.stringify(watched));
  });
  GM_registerMenuCommand('Reset all watched data', () => {
    if (confirm('Erase all locally-stored watched data for this script?')) {
      watched = {}; dirty = true; flush(); scheduleSweep();
    }
  });
})();
