// ==UserScript==
// @name         YouTube Watched Indicator
// @namespace    https://github.com/azrobbins/YouTube-Watched-Indicator
// @version      0.9.0
// @description  Local watched-state icons on YouTube thumbnails. Measures how much of each video you watch (no reliance on YouTube watch history) and stores it in Tampermonkey only. A progress bar shows the exact watched fraction (colored red->green); hover for the timestamp; on the watch page the green fill marks the furthest position and a white marker the last position — click to resume there in place.
// @author       VitaKaninen
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
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
  const T_PARTIAL      = 0.05;               // >= this fraction -> coarse "partial" bucket (drives the live re-sweep gate only)
  const T_FULL         = 0.50;               // >  this fraction -> coarse "full" bucket   (drives the live re-sweep gate only)
  const ICON_SIZE      = 13;                 // px bar height (grid/list cards); width follows the BAR viewBox ratio
  const AVATAR_GAP     = 16;                 // px gap below the channel avatar (grid cards)
  const GUTTER_OFFSET  = 24;                 // px left of the metadata row (fallback for list cards, e.g. search)
  const SHORTS_ICON    = 12;                 // px bar height for the inline Shorts badge (sized to the 14px view-count text)
  const SHORTS_GAP     = 5;                  // px gap between the Shorts badge and the view count

  // ---------------------------------------------------------------------------
  // Storage  (in-memory map, debounced flush; monotonic max-fraction per video)
  // ---------------------------------------------------------------------------
  let watched = {};
  let dirty = false;
  let flushTimer = null;

  // Each entry is { f: furthestFraction (0..1, monotonic), l: lastFraction (0..1, NOT monotonic — the
  // most recent playhead position), t: ms timestamp of the last `l` update, d: durationSeconds (0 if
  // unknown) }. Legacy entries were a bare number (just the fraction); normEntry upgrades those on read
  // so old data keeps working — l defaults to f (only known position), duration stays 0 until recaptured.
  function normEntry(v) {
    if (typeof v === 'number') return { f: v, l: v, t: 0, d: 0 };
    if (v && typeof v === 'object') {
      const f = +v.f || 0;
      return { f, l: isFinite(v.l) ? +v.l : f, t: +v.t || 0, d: (isFinite(v.d) && v.d > 0) ? +v.d : 0 };
    }
    return { f: 0, l: 0, t: 0, d: 0 };
  }
  function parseStore(raw) {
    let o; try { o = JSON.parse(raw || '{}') || {}; } catch (e) { return {}; }
    const out = {};
    for (const id in o) out[id] = normEntry(o[id]);
    return out;
  }
  function fracOf(id) { const e = watched[id]; return (e && e.f) || 0; }   // furthest position
  function lastOf(id) { const e = watched[id]; return e ? (isFinite(e.l) ? e.l : e.f) : 0; }  // last position
  function durOf(id)  { const e = watched[id]; return (e && e.d) || 0; }
  // Merge another (already-normalized) copy of the map into ours. `f` keeps the larger fraction
  // (monotonic); `d` is filled whenever one side knows it. `l` has no max to fall back on (it's the
  // latest position, not a high-water mark), so the newest write wins by timestamp `t` — this is what
  // lets the active tab's seek-back-then-stop survive an idle tab re-persisting its older copy.
  function mergeInto(other) {
    let changed = false;
    for (const id in other) {
      const o = other[id], c = watched[id];
      if (!c) { watched[id] = { f: o.f, l: o.l, t: o.t, d: o.d }; changed = true; continue; }
      if (o.f > c.f) { c.f = o.f; changed = true; }
      if (!c.d && o.d) { c.d = o.d; changed = true; }
      if (o.t > c.t) { c.l = o.l; c.t = o.t; changed = true; }
    }
    return changed;
  }
  function loadStore() {
    watched = parseStore(GM_getValue(STORE_KEY, '{}'));
  }
  function flush() {
    if (!dirty) return;
    // Read-merge-write: fold in whatever is in storage *now* before overwriting, so a stale
    // in-memory copy (e.g. another tab wrote while this one had the page open) can never clobber
    // entries this tab never saw. The whole map lives under one key, so a blind write would do exactly
    // that. Monotonic max keeps the higher fraction on every conflict.
    mergeInto(parseStore(GM_getValue(STORE_KEY, '{}')));
    GM_setValue(STORE_KEY, JSON.stringify(watched));
    dirty = false;
  }
  // Live cross-tab sync: when another tab persists progress, fold it into this tab's map and redraw,
  // so an already-open page (e.g. Subscriptions) updates without a manual reload. Firefox/LibreWolf
  // don't reliably propagate GM storage to other open tabs otherwise — a plain reload there can read
  // a stale copy, which is why a freshly-watched video failed to show up across tabs.
  function watchStore() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    GM_addValueChangeListener(STORE_KEY, (key, oldVal, newVal, remote) => {
      if (!remote) return;                                 // ignore our own writes
      if (mergeInto(parseStore(newVal))) scheduleSweep();
    });
  }
  // Throttle, NOT debounce. A debounce here (clear + reset on every call) gets STARVED during
  // playback: timeupdate fires ~4x/s, so a 1.5s timer that resets every ~250ms never fires until
  // playback stops — silently dropping every video you don't pause for >1.5s. This schedules at most
  // one flush per FLUSH_MS and lets it fire, guaranteeing periodic persistence while watching.
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
  }
  function record(id, frac, dur) {
    if (!id || !(frac > 0)) return;
    const e = watched[id] || (watched[id] = { f: 0, l: 0, t: 0, d: 0 });
    const r = Math.round(frac * 1000) / 1000;             // 0.001 precision is plenty
    let changed = false;
    if (r > e.f) {                                         // furthest: monotonic high-water mark
      const crossed = stateFor(r) !== stateFor(e.f);       // coarse bucket change?
      e.f = r;
      changed = true;
      if (crossed) scheduleSweep();                        // only redraw badges when the bucket flips
    }
    if (r !== e.l) {                                       // last: the current playhead, can move either way
      e.l = r; e.t = Date.now();
      changed = true;
    }
    // Duration is constant per video but may not be ready on the first sample — record it whenever it
    // becomes known. Rounded to whole seconds (all we need for a mm:ss timestamp).
    if (dur && isFinite(dur) && dur > 0 && !e.d) { e.d = Math.round(dur); changed = true; }
    if (changed) { dirty = true; scheduleFlush(); }
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
    record(activeId, Math.min(1, v.currentTime / d), d);
  }

  // Continuous progress (timeupdate, scrub-in-progress) rides the throttled flush. Discrete user
  // actions — finishing a seek, pausing, ending — flush to storage IMMEDIATELY, so the value lands
  // the instant you act, even if you bounce straight to another tab/window and reload before the
  // 1.5s throttle would have fired (the cross-tab "reloaded and it's not there yet" case).
  const FLUSH_ON = new Set(['seeked', 'pause', 'ended']);
  function onSample(e) {
    sampleNow(e);
    if (e && FLUSH_ON.has(e.type)) flush();
  }

  function bindVideo() {
    const v = mainVideo();
    if (!v || v === boundVideo) return;                // already bound to this element
    boundVideo = v;
    // All of these can move the playhead; they funnel into one sampler. timeupdate covers normal
    // playback; seeking/seeked catch manual scrubbing (fire even while paused and even if the video
    // never started) — so dragging the slider past a threshold is recorded immediately.
    ['timeupdate', 'seeking', 'seeked', 'pause', 'play', 'playing', 'ratechange', 'progress', 'loadeddata', 'canplay']
      .forEach(ev => v.addEventListener(ev, onSample, { passive: true }));
    // Lifecycle: re-align activeId to whatever video is now loaded; clear it between videos so a
    // stray tick in the gap can't be misfiled. ended -> count as fully watched (and flush at once).
    v.addEventListener('loadedmetadata', () => { activeId = currentVideoId(); sampleNow(); }, { passive: true });
    v.addEventListener('durationchange', () => { activeId = currentVideoId(); sampleNow(); }, { passive: true });
    v.addEventListener('emptied', () => { activeId = null; }, { passive: true });
    v.addEventListener('ended', () => { if (activeId) { record(activeId, 1, v.duration); flush(); } }, { passive: true });
    activeId = currentVideoId();                        // the element may already be loaded when we bind
    sampleNow();
  }

  // Safety net only (events above are the primary path). Also (re)binds when the player's <video>
  // first appears or gets swapped out.
  setInterval(() => { bindVideo(); sampleNow(); updateWatchBar(); }, SAMPLE_MS);

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
  // Watched fraction -> a hue swept red (0deg) -> yellow (60) -> green (120). A linear hue interp
  // gives the "slowly turns from red to green as it fills" effect the bar's color tracks the amount.
  function barColor(frac) {
    const f = Math.max(0, Math.min(1, frac));
    return `hsl(${Math.round(f * 120)} 78% 45%)`;
  }
  // Seconds -> "m:ss" (or "h:mm:ss" for long videos), matching YouTube's own timestamp style.
  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return (h ? `${h}:${pad(m)}` : `${m}`) + ':' + pad(sec);
  }
  // Pill-shaped progress bar: a rounded-rectangle outline (same currentColor ring style as the old
  // circle) with an inner fill whose WIDTH = watched fraction and COLOR = barColor(frac). The fill is
  // clipped to the rounded interior, so its left end is rounded and its right end is cut flat at the
  // fill point — the usual progress-bar look. clip-path needs a document-unique id (counter below).
  const BAR_W = 44, BAR_H = 14, BAR_SW = 2;  // viewBox units; on-screen size set by `size` (= height)
  let clipSeq = 0;
  function buildIcon(frac, size = ICON_SIZE) {
    const svg = svgChild('svg', {
      viewBox: `0 0 ${BAR_W} ${BAR_H}`, width: size * BAR_W / BAR_H, height: size
    });
    svg.style.display = 'block';
    const ix = BAR_SW, iy = BAR_SW, iw = BAR_W - 2 * BAR_SW, ih = BAR_H - 2 * BAR_SW, ir = ih / 2;
    if (frac > 0) {
      const id = 'ywi-clip-' + (++clipSeq);
      const defs = svgChild('defs', {});
      const clip = svgChild('clipPath', { id });
      clip.appendChild(svgChild('rect', { x: ix, y: iy, width: iw, height: ih, rx: ir, ry: ir }));
      defs.appendChild(clip);
      svg.appendChild(defs);
      svg.appendChild(svgChild('rect', {
        x: ix, y: iy, width: Math.max(0.001, iw * Math.min(1, frac)), height: ih,
        fill: barColor(frac), 'clip-path': `url(#${id})`
      }));
    }
    const ox = BAR_SW / 2, oy = BAR_SW / 2, ow = BAR_W - BAR_SW, oh = BAR_H - BAR_SW, or = oh / 2;
    svg.appendChild(svgChild('rect', {
      x: ox, y: oy, width: ow, height: oh, rx: or, ry: or,
      fill: 'none', stroke: 'currentColor', 'stroke-width': BAR_SW, opacity: 0.7
    }));
    return svg;
  }
  // Coarse bucket, used ONLY to gate the live re-sweep during capture (avoid re-decorating ~4x/s while
  // a video plays). The bar itself renders the exact fraction whenever a sweep runs.
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
      pointerEvents: 'auto',          // so the badge itself receives hover -> its title tooltip shows
      lineHeight: '0',                // (none would pass the hover to the thumbnail, starting the preview)
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
      pointerEvents: 'auto',          // receive hover so the title tooltip shows
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
    const frac = fracOf(id), dur = durOf(id);
    const key = Math.round(frac * 1000) + ':' + size;   // rebuild only when the rendered bar would change
    if (badge.dataset.fkey !== key) {
      badge.dataset.fkey = key;
      badge.replaceChildren(buildIcon(frac, size));
    }
    // Tooltip on hover: "57% / 4:40" — the position you'd reached. Duration is only known once the
    // video has been watched at least once on this device; until then just show the percentage.
    const pct = Math.round(frac * 100);
    badge.title = dur > 0 ? `${pct}% / ${fmtTime(frac * dur)}` : `${pct}% watched`;
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
    updateWatchBar();
  }

  let sweepTimer = null;
  function scheduleSweep() {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, SWEEP_MS);
  }

  // ---------------------------------------------------------------------------
  // Watch-page resume bar  (only on /watch)
  // A clickable copy of the thumbnail bar injected under the video title. The FILL shows how far you'd
  // reached (your stored max), with a marker at that point. CLICKING anywhere on the bar jumps the
  // player to that recorded position — NOT to where you clicked (deliberately not a scrub bar: clicking
  // a different spot must never overwrite your saved position). It sets video.currentTime directly,
  // which seeks IN PLACE (no page reload, unlike a ?t= URL). Built from <div>s (not SVG) so it stretches
  // with rounded ends; all via createElement (Trusted Types blocks innerHTML). Useful for getting back
  // to your spot after a crash reset the player position.
  // ---------------------------------------------------------------------------
  const WATCHBAR_ID    = 'ywi-watchbar';
  const WATCHBAR_MAXW  = 360;                            // px max width of the resume bar
  function watchAnchor() {
    return document.querySelector('ytd-watch-metadata #above-the-fold')
        || document.querySelector('ytd-watch-metadata')
        || null;
  }
  function buildWatchBar() {
    const wrap = document.createElement('div');
    wrap.id = WATCHBAR_ID;
    Object.assign(wrap.style, {
      position: 'relative', margin: '10px 0 6px', maxWidth: WATCHBAR_MAXW + 'px', userSelect: 'none'
    });

    const track = document.createElement('div');
    Object.assign(track.style, {
      position: 'relative', height: '10px', borderRadius: '5px', boxSizing: 'border-box',
      border: '1.5px solid var(--yt-spec-text-secondary, #909090)',
      background: 'rgba(128,128,128,0.18)', cursor: 'pointer', overflow: 'hidden'
    });
    const fill = document.createElement('div');
    Object.assign(fill.style, { position: 'absolute', left: '0', top: '0', height: '100%', width: '0%' });
    track.appendChild(fill);

    const marker = document.createElement('div');
    Object.assign(marker.style, {
      position: 'absolute', top: '-3px', height: '16px', width: '2px', borderRadius: '1px',
      background: 'var(--yt-spec-text-primary, #fff)', transform: 'translateX(-1px)',
      pointerEvents: 'none', display: 'none'
    });
    wrap.append(track, marker);

    // Click ANYWHERE -> jump to the LAST recorded position (the white marker), not the click point,
    // so a stray click can't move (and thus overwrite) your saved spot. Read fresh at click time.
    track.addEventListener('click', () => {
      const v = mainVideo();
      const d = (v && isFinite(v.duration) && v.duration > 0) ? v.duration : durOf(currentVideoId());
      const l = lastOf(currentVideoId());
      if (v && d && l > 0) v.currentTime = l * d;        // seek in place — no reload
    });

    wrap._ywi = { fill, marker };
    return wrap;
  }
  function updateWatchBar() {
    if (location.pathname !== '/watch') {                // navigated off a watch page -> remove it
      const ex = document.getElementById(WATCHBAR_ID);
      if (ex) ex.remove();
      return;
    }
    const id = currentVideoId();
    if (!id) return;
    const anchor = watchAnchor();
    if (!anchor) return;
    let wrap = document.getElementById(WATCHBAR_ID);
    if (!wrap) wrap = buildWatchBar();
    if (wrap.parentNode !== anchor) {                    // (re)attach below the title, above the channel row
      anchor.insertBefore(wrap, anchor.querySelector('#bottom-row') || anchor.firstChild);
    }
    const frac = fracOf(id), last = lastOf(id), dur = durOf(id);
    const { fill, marker } = wrap._ywi;
    fill.style.width = (frac * 100) + '%';                // green fill up to the FURTHEST position
    fill.style.background = barColor(frac);
    if (frac > 0) { marker.style.display = 'block'; marker.style.left = (last * 100) + '%'; }  // white = LAST position
    else marker.style.display = 'none';
    wrap.title = frac > 0
      ? `Click to resume at ${Math.round(last * 100)}%${dur ? ' / ' + fmtTime(last * dur) : ''} · furthest ${Math.round(frac * 100)}%${dur ? ' / ' + fmtTime(frac * dur) : ''}`
      : 'No recorded position yet';
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  loadStore();
  watchStore();
  new MutationObserver(() => { scheduleSweep(); bindVideo(); }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', () => { scheduleSweep(); bindVideo(); });
  scheduleSweep();
  bindVideo();

  // Maintenance helpers in the Tampermonkey menu.
  GM_registerMenuCommand('Export watched data (JSON to console)', () => {
    // Read straight from storage (and fold into memory) so the dump always reflects what's actually
    // persisted, not just this tab's in-memory copy — the reliable thing to compare across tabs.
    mergeInto(parseStore(GM_getValue(STORE_KEY, '{}')));
    console.log('[YWI] watched data:', JSON.stringify(watched));
  });
  GM_registerMenuCommand('Reset all watched data', () => {
    if (confirm('Erase all locally-stored watched data for this script?')) {
      // Write empty directly — flush() does a read-merge-write and would fold the old data right back.
      watched = {}; dirty = false; GM_setValue(STORE_KEY, '{}'); scheduleSweep();
    }
  });
})();
