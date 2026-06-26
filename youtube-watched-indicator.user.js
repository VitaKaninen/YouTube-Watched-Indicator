// ==UserScript==
// @name         YouTube Watched Indicator
// @namespace    https://github.com/azrobbins/YouTube-Watched-Indicator
// @version      0.25.0
// @description  Local watched-state icons on YouTube thumbnails. Measures how much of each video you watch (no reliance on YouTube watch history) and stores it in Tampermonkey only. A progress bar shows the exact watched fraction (colored red->green); hover for the timestamp; clicked-but-unwatched videos get a brighter outline so you don't re-open them; on the watch page the green fill marks the furthest position and a white marker the last position — click to resume there in place. Videos in your Liked list that you haven't otherwise touched get a gray-filled pill (backfilled via YouTube's own session API — no API key needed), so you can spot ones you liked before installing.
// @author       VitaKaninen
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
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
  const BAR_BG         = 'rgba(128,128,128,0.7)';   // gray fill for a LIKED-but-untouched pill (the liked-backfill indicator); theme-neutral medium gray, opaque enough to read on light + dark

  // Liked-videos backfill: pull your Liked playlist via YouTube's own session API and mark any liked
  // video NOT already in storage as "clicked" (so videos you watched/liked before install still get the
  // opened-indicator outline). No Google API key — reuses the page's innertube key + your cookies.
  const LIKED_TS_KEY     = 'ywi.liked.fetchedAt';   // GM key: ms timestamp of the last successful backfill
  const LIKED_REFRESH_MS = 24 * 60 * 60 * 1000;     // auto-refresh at most once per 24h (menu command forces it)
  const LIKED_VER_KEY    = 'ywi.liked.logicVer';    // GM key: which backfill-logic version last ran
  const LIKED_VER        = 5;                        // bump when the backfill logic changes -> forces a one-time re-run (v2 = liked stored as `k`, heals the v0.17-0.18 `c` mislabel; v3 = parser also reads the new lockupViewModel item shape; v4 = robust continuation-token search; v5 = continuationItemViewModel replaces continuationItemRenderer)

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
  // `c` = clicked/opened flag (1 once you've opened the video from a listing, even if you never watched
  // it — e.g. a deferred/lazy-loaded new tab). 0 = never clicked.
  // `k` = liked flag (1 if the video is in your Liked playlist; set by the liked-backfill for videos not
  // otherwise in storage). Drives the gray-filled pill that flags "liked before install" — but ONLY while
  // the video is neither clicked nor watched; once you click/watch it, the normal rules take over.
  function normEntry(v) {
    if (typeof v === 'number') return { f: v, l: v, t: 0, d: 0, c: 0, k: 0 };
    if (v && typeof v === 'object') {
      const f = +v.f || 0;
      return { f, l: isFinite(v.l) ? +v.l : f, t: +v.t || 0, d: (isFinite(v.d) && v.d > 0) ? +v.d : 0, c: v.c ? 1 : 0, k: v.k ? 1 : 0 };
    }
    return { f: 0, l: 0, t: 0, d: 0, c: 0, k: 0 };
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
      if (!c) { watched[id] = { f: o.f, l: o.l, t: o.t, d: o.d, c: o.c, k: o.k }; changed = true; continue; }
      if (o.f > c.f) { c.f = o.f; changed = true; }
      if (!c.d && o.d) { c.d = o.d; changed = true; }
      if (o.t > c.t) { c.l = o.l; c.t = o.t; changed = true; }
      if (o.c && !c.c) { c.c = 1; changed = true; }       // clicked is sticky — OR across copies
      if (o.k && !c.k) { c.k = 1; changed = true; }       // liked is sticky — OR across copies
    }
    return changed;
  }
  // Durable mirror in the PAGE's localStorage (youtube.com origin), alongside GM storage. Two reasons:
  // (1) it belongs to the origin, not the script, so it survives the userscript manager resetting the
  //     script's GM values on an edit/update;
  // (2) crucially, an OLD version of this script left running in another tab rewrites the GM blob in its
  //     own (older) format and silently strips fields it doesn't know — e.g. pre-v0.10.0 has no `c`, so
  //     its flush regressed clicked entries to c:0 (kept f/l/t/d). Old versions have NO localStorage
  //     code, so they never touch this mirror; on load we merge it back and re-seed GM, healing the loss.
  // localStorage's `storage` event is also reliable cross-tab on Firefox/LibreWolf, unlike GM's listener.
  function lsGet() { try { return localStorage.getItem(STORE_KEY) || '{}'; } catch (e) { return '{}'; } }
  function lsSet(s) { try { localStorage.setItem(STORE_KEY, s); } catch (e) {} }
  function loadStore() {
    watched = parseStore(GM_getValue(STORE_KEY, '{}'));
    const healed = mergeInto(parseStore(lsGet()));         // fold in the mirror (may out-live a stripped GM copy)
    if (healed) { dirty = true; flush(); }                 // re-seed GM from the survivor copy
  }
  function flush() {
    if (!dirty) return;
    // Read-merge-write: fold in whatever is in storage *now* before overwriting, so a stale in-memory
    // copy (e.g. another tab wrote while this one had the page open) can never clobber entries this tab
    // never saw. The whole map lives under one key, so a blind write would do exactly that. Merge BOTH
    // backends; monotonic max / sticky-OR keep the stronger value on every conflict.
    mergeInto(parseStore(GM_getValue(STORE_KEY, '{}')));
    mergeInto(parseStore(lsGet()));
    const s = JSON.stringify(watched);
    GM_setValue(STORE_KEY, s);
    lsSet(s);
    dirty = false;
  }
  // Live cross-tab sync: when another tab persists progress, fold it into this tab's map and redraw,
  // so an already-open page (e.g. Subscriptions) updates without a manual reload. Firefox/LibreWolf
  // don't reliably propagate GM storage to other open tabs otherwise — a plain reload there can read
  // a stale copy, which is why a freshly-watched video failed to show up across tabs. The localStorage
  // `storage` event covers what GM's listener misses there.
  function watchStore() {
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(STORE_KEY, (key, oldVal, newVal, remote) => {
        if (!remote) return;                               // ignore our own writes
        if (mergeInto(parseStore(newVal))) scheduleSweep();
      });
    }
    window.addEventListener('storage', e => {              // localStorage changed in another tab
      if (e.key === STORE_KEY && e.newValue && mergeInto(parseStore(e.newValue))) scheduleSweep();
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
    const e = watched[id] || (watched[id] = { f: 0, l: 0, t: 0, d: 0, c: 0, k: 0 });
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
  const OUTLINE_CLICKED = 0.75, OUTLINE_UNCLICKED = 0.25;  // outline opacity: brighter once clicked, dim until then
  let clipSeq = 0;
  function buildIcon(frac, size = ICON_SIZE, clicked = true, likedOnly = false) {
    const svg = svgChild('svg', {
      viewBox: `0 0 ${BAR_W} ${BAR_H}`, width: size * BAR_W / BAR_H, height: size
    });
    svg.style.display = 'block';
    const ix = BAR_SW, iy = BAR_SW, iw = BAR_W - 2 * BAR_SW, ih = BAR_H - 2 * BAR_SW, ir = ih / 2;
    // Gray-filled pill for a LIKED-but-untouched video (in your Liked list, never clicked or watched) —
    // flags videos you liked before installing. Every other state follows the original rules: no gray
    // fill, just the colored watched fraction (if any) over a transparent interior.
    if (likedOnly) {
      svg.appendChild(svgChild('rect', {
        x: ix, y: iy, width: iw, height: ih, rx: ir, ry: ir, fill: BAR_BG
      }));
    }
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
      fill: 'none', stroke: 'currentColor', 'stroke-width': BAR_SW,
      opacity: clicked ? OUTLINE_CLICKED : OUTLINE_UNCLICKED
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
      // Single-author cards use yt-decorated-avatar-view-model; MULTI-author cards (e.g. "More Court TV
      // and COURT TV") use a yt-avatar-stack-view-model instead — same ~32px box, but unrecognized it
      // fell through to placeBesideMeta and the badge landed inline on the author line (pushed down/right
      // vs. the under-avatar pill on single-author cards). Match both so the stack gets placeUnderAvatar.
      return card.querySelector('yt-decorated-avatar-view-model, yt-avatar-stack-view-model, yt-img-shadow#avatar, #avatar');
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
  // New-regime cards (yt-content-metadata-view-model) whose channel avatar isn't actually rendered:
  // a channel's own /videos grid omits the per-video avatar entirely, and the watch-page recommendation
  // lockups keep a yt-decorated-avatar-view-model in the DOM but collapsed to 0x0. In both cases
  // placeUnderAvatar anchors an absolutely-positioned badge to nothing (off at the gutter / at 0,0 ->
  // invisible). Instead place the badge inline at the START of the metadata block — left of its first
  // line (the view count on a channel grid, the channel name in the watch sidebar). Same inline look as
  // the Shorts badge; always on-screen and theme-colored.
  function placeBesideMeta(vm, badge) {
    const line = vm.querySelector(':scope > div') || vm;
    Object.assign(badge.style, {
      display: 'inline-flex',
      alignItems: 'center',
      verticalAlign: 'middle',
      marginRight: `${SHORTS_GAP}px`,
      flex: '0 0 auto',
      pointerEvents: 'auto',          // receive hover so the title tooltip shows
      lineHeight: '0',
      color: 'inherit'
    });
    line.insertBefore(badge, line.firstChild);
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
    const e = watched[id];
    const frac = fracOf(id), dur = durOf(id);
    const clicked = ((e && e.c) ? 1 : 0) || frac > 0;       // watched implies clicked
    const likedOnly = !!(e && e.k && !e.c && !(frac > 0));  // in Liked list but never clicked/watched -> gray pill
    const key = Math.round(frac * 1000) + ':' + size + ':' + (clicked ? 1 : 0) + ':' + (likedOnly ? 1 : 0);  // rebuild only when the rendered bar changes
    if (badge.dataset.fkey !== key) {
      badge.dataset.fkey = key;
      badge.replaceChildren(buildIcon(frac, size, !!clicked, likedOnly));
    }
    // Tooltip on hover: "57% / 4:40" — the position you'd reached. Duration is only known once the
    // video has been watched at least once on this device; until then just show the percentage. A
    // liked-but-untouched video says so instead of "0% watched".
    const pct = Math.round(frac * 100);
    badge.title = likedOnly ? 'In your Liked playlist' : (dur > 0 ? `${pct}% / ${fmtTime(frac * dur)}` : `${pct}% watched`);
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
      // Prefer the avatar gutter only when the avatar is genuinely rendered (non-zero box). YouTube
      // now omits the avatar on channel-grid cards and collapses it to 0x0 in watch-sidebar lockups,
      // so an unguarded placeUnderAvatar anchored to it renders the badge invisibly. New-regime cards
      // fall back to an inline badge in the metadata row; legacy list cards keep the gutter.
      const avatar = avatarOf(card);
      if (avatar && avatar.offsetWidth > 0 && avatar.offsetHeight > 0) placeUnderAvatar(avatar, badge);
      else if (row.matches && row.matches('yt-content-metadata-view-model')) placeBesideMeta(row, badge);
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
      position: 'relative', margin: '0 0 6px', maxWidth: WATCHBAR_MAXW + 'px', userSelect: 'none'
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
  // Click tracking  (mark a video "opened" the moment you click it on a listing — left-click,
  // middle-click/auxclick, or right-click->open-in-new-tab. Captured on the listing page where the
  // click happens, so it works even when the new tab is deferred/lazy-loaded and never runs the script.
  // Purpose: stop re-opening the same video in multiple tabs — clicked cards get a brighter outline.)
  // ---------------------------------------------------------------------------
  function idFromClick(target) {
    if (!target || !target.closest) return null;
    const a = target.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href') || '';
      let m = href.match(/[?&]v=([\w-]{11})/); if (m) return m[1];
      m = href.match(/\/shorts\/([\w-]{11})/); if (m) return m[1];
    }
    const card = target.closest(
      'yt-lockup-view-model, ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer, ' +
      'ytd-compact-video-renderer, ytd-playlist-video-renderer, ' +
      'ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model'
    );
    return card ? idFromCard(card) : null;
  }
  function markClicked(id) {
    if (!id) return;
    const e = watched[id] || (watched[id] = { f: 0, l: 0, t: 0, d: 0, c: 0, k: 0 });
    // Persist IMMEDIATELY, not via the throttled timer: a click is a rare discrete event, and the page
    // may navigate / reload / open a new tab right after — a 1.5s deferred flush can be lost in that
    // window (the symptom: clicked outlines vanish on reload). flush() is a read-merge-write, so this is
    // safe across tabs and cheap at click frequency.
    if (!e.c) { e.c = 1; dirty = true; flush(); scheduleSweep(); }
  }
  // Listen on `window` in CAPTURE phase: capture runs window -> document -> target, so this fires before
  // any page/extension handler (e.g. an "open in new tab" script on document) that might call
  // stopImmediatePropagation and otherwise prevent us from ever seeing the click.
  ['click', 'auxclick', 'contextmenu'].forEach(ev =>
    window.addEventListener(ev, e => markClicked(idFromClick(e.target)), true));

  // ---------------------------------------------------------------------------
  // Liked-videos backfill  (fill the "I at least opened this" gap for videos liked before install)
  // Calls YouTube's own internal "innertube" browse API for your Liked playlist (browseId VLLL),
  // reusing the page's API key + your session cookies (SAPISIDHASH auth, same as the site). No Google
  // API key and nothing is sent anywhere new — it's a read of your own list, same as opening the page.
  // Every liked video NOT already in the watched map is created as clicked (c:1, f:0); existing entries
  // are left untouched, so measured progress / real clicks always win.
  // ---------------------------------------------------------------------------
  function getCookie(name) {
    return (document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')) || [])[1] || '';
  }
  // The web client authenticates innertube with SAPISIDHASH = "<ts>_<sha1hex>", hashing
  // "<ts> <SAPISID> <origin>". SAPISID (and the __Secure-*PAPISID variants) are JS-readable by design.
  async function sapisidHash(origin) {
    const sid = getCookie('__Secure-3PAPISID') || getCookie('__Secure-1PAPISID') || getCookie('SAPISID');
    if (!sid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sid} ${origin}`));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }
  // ytcfg holds the innertube API key + request context; it lives on the PAGE window (unsafeWindow under
  // a userscript sandbox). Fall back to scraping the values out of the page HTML if ytcfg isn't reachable.
  function pageYtcfg(k) {
    try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.ytcfg) return unsafeWindow.ytcfg.get(k); } catch (e) {}
    return null;
  }
  function innertubeKey() {
    return pageYtcfg('INNERTUBE_API_KEY')
        || (document.documentElement.innerHTML.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1]
        || null;
  }
  function innertubeContext() {
    const ctx = pageYtcfg('INNERTUBE_CONTEXT');
    if (ctx) return ctx;
    const ver = pageYtcfg('INNERTUBE_CLIENT_VERSION')
            || (document.documentElement.innerHTML.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || [])[1]
            || '2.20240101.00.00';
    return { client: { clientName: 'WEB', clientVersion: ver, hl: 'en', gl: 'US' } };
  }
  async function innertubeBrowse(body) {
    const key = innertubeKey();
    if (!key) throw new Error('no innertube key');
    const headers = { 'Content-Type': 'application/json' };
    const auth = await sapisidHash(location.origin);
    if (auth) { headers['Authorization'] = auth; headers['X-Goog-AuthUser'] = '0'; headers['X-Origin'] = location.origin; }
    const res = await fetch(`/youtubei/v1/browse?key=${encodeURIComponent(key)}&prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ context: innertubeContext(), ...body })
    });
    if (!res.ok) throw new Error('browse HTTP ' + res.status);
    return res.json();
  }
  const isVid = s => typeof s === 'string' && /^[\w-]{11}$/.test(s);
  // Find a continuation token anywhere inside a continuationItemRenderer. The exact nesting drifts
  // (continuationEndpoint.continuationCommand.token in the legacy shape; wrapped in a
  // commandExecutorCommand.commands[] under the new view-model shape), so search rather than fixed-path.
  function deepToken(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.continuationCommand && typeof o.continuationCommand.token === 'string') return o.continuationCommand.token;
    for (const k in o) { const r = deepToken(o[k]); if (r) return r; }
    return null;
  }
  // Walk the response tree collecting every liked videoId and any continuation token, rather than
  // navigating brittle fixed paths (the response shape shifts between initial + continuation pages and
  // across YouTube revisions). Handles BOTH item shapes: the legacy `playlistVideoRenderer` AND the newer
  // `lockupViewModel` (YouTube migrated playlist items to view-models — if only the old shape is matched
  // the fetch "succeeds" but finds zero videos). As a last resort also picks up bare `videoId` fields.
  function collectLiked(obj, ids, tokens) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.playlistVideoRenderer && isVid(obj.playlistVideoRenderer.videoId)) ids.add(obj.playlistVideoRenderer.videoId);
    if (obj.lockupViewModel && isVid(obj.lockupViewModel.contentId)
        && (!obj.lockupViewModel.contentType || obj.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
      ids.add(obj.lockupViewModel.contentId);
    }
    if (obj.continuationItemRenderer || obj.continuationItemViewModel) {
      // YouTube renamed continuationItemRenderer → continuationItemViewModel; handle both
      const tok = deepToken(obj.continuationItemRenderer || obj.continuationItemViewModel);
      if (tok) tokens.push(tok);
    }
    if (Array.isArray(obj)) { for (const x of obj) collectLiked(x, ids, tokens); }
    else for (const k in obj) collectLiked(obj[k], ids, tokens);
  }
  async function fetchLikedIds() {
    const ids = new Set();
    let tokens = [];
    collectLiked(await innertubeBrowse({ browseId: 'VLLL' }), ids, tokens);   // VL + LL (Liked playlist)
    let guard = 0;
    while (tokens.length && guard++ < 1000) {                                  // cap ~100k videos
      const token = tokens.shift();
      const next = [];
      collectLiked(await innertubeBrowse({ continuation: token }), ids, next);
      tokens = next;
    }
    return ids;
  }
  function applyLiked(ids) {
    let changed = false;
    ids.forEach(id => {
      const e = watched[id];
      // Gap-fill: a liked video with no existing entry gets the `k` (liked) flag -> renders as a gray pill.
      if (!e) { watched[id] = { f: 0, l: 0, t: 0, d: 0, c: 0, k: 1 }; changed = true; return; }
      // Heal the earlier (v0.17-v0.18) backfill, which mislabeled liked videos as CLICKED (c:1). A bare
      // click with no real watch data, on a video now confirmed liked, was almost certainly that backfill
      // -> relabel it liked so it shows gray. Genuinely watched videos (f>0) and clicks carrying real data
      // are left untouched -> normal rules. (A real pre-fix click on a liked video is indistinguishable
      // from the backfill, so it flips to gray too — rare and cosmetically minor.)
      if (e.c && !e.k && !(e.f > 0) && !(e.l > 0) && !e.d) { e.c = 0; e.k = 1; changed = true; }
    });
    if (changed) { dirty = true; flush(); scheduleSweep(); }
    return changed;
  }
  let likedBusy = false;
  async function refreshLiked(force) {
    if (likedBusy) return;
    const last = +GM_getValue(LIKED_TS_KEY, 0) || 0;
    const stale = Date.now() - last >= LIKED_REFRESH_MS;
    const verBumped = +GM_getValue(LIKED_VER_KEY, 0) !== LIKED_VER;            // logic changed -> re-run once
    if (!force && !stale && !verBumped) return;                               // throttle automatic runs
    likedBusy = true;
    try {
      const ids = await fetchLikedIds();
      const added = applyLiked(ids);
      GM_setValue(LIKED_TS_KEY, Date.now());
      GM_setValue(LIKED_VER_KEY, LIKED_VER);
      console.log(`[YWI] liked backfill: ${ids.size} liked videos found, ${added ? 'updated gray-pill marks' : 'no changes'}`);
    } catch (e) {
      console.warn('[YWI] liked backfill failed (will retry next run):', e);   // leave timestamp untouched -> retries
    } finally {
      likedBusy = false;
    }
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
  // Auto-backfill from Liked videos (throttled to once/24h). Delayed so ytcfg/session cookies are ready.
  setTimeout(() => refreshLiked(false), 5000);

  // Maintenance helpers in the Tampermonkey menu.
  GM_registerMenuCommand('Mark Liked videos (gray pill) now', () => {
    refreshLiked(true).then(() => console.log('[YWI] liked backfill: done'));
  });
  // TEMP DIAGNOSTIC (added v0.20.0 to debug the liked backfill) — remove once confirmed working. Pages
  // through the whole Liked playlist with per-page logging so we can see where the continuation chain
  // breaks, then dumps the final response (the one with no next token) to reveal where YT nests it.
  GM_registerMenuCommand('YWI: diagnose Liked fetch (console)', async () => {
    try {
      console.log('[YWI diag] key:', innertubeKey() ? 'FOUND' : 'MISSING',
                  '| auth:', (await sapisidHash(location.origin)) ? 'BUILT' : 'MISSING');
      let data = await innertubeBrowse({ browseId: 'VLLL' });
      const ids = new Set(); let tokens = [];
      collectLiked(data, ids, tokens);
      // Log any page-1 alerts immediately — an alert here often explains a capped/no-token response.
      const p1alerts = [];
      (function find(o) {
        if (!o || typeof o !== 'object') return;
        if (o.alertRenderer || o.alertWithButtonRenderer) {
          const a = o.alertRenderer || o.alertWithButtonRenderer;
          const txt = a.text && (a.text.simpleText || (a.text.runs && a.text.runs.map(r => r.text).join('')));
          p1alerts.push({ type: a.type, text: txt });
        }
        for (const k in o) find(o[k]);
      })(data);
      if (p1alerts.length) console.warn('[YWI diag] page 1 ALERTS (may explain missing token):', p1alerts);
      console.log(`[YWI diag] page 1: total ids ${ids.size}, next token: ${tokens.length ? 'YES' : 'NO'}`);
      let guard = 0, page = 1;
      while (tokens.length && guard++ < 1000) {
        data = await innertubeBrowse({ continuation: tokens.shift() });
        const next = [];
        collectLiked(data, ids, next);
        page++;
        console.log(`[YWI diag] page ${page}: total ids ${ids.size}, next token: ${next.length ? 'YES' : 'NO'}`);
        tokens = next;
      }
      console.log('[YWI diag] DONE — total liked ids:', ids.size, '| pages:', page);
      // Surface any alert/error YouTube attached (throttle / "unavailable" messages explain a short response).
      const alerts = [];
      (function find(o) {
        if (!o || typeof o !== 'object') return;
        if (o.alertRenderer || o.alertWithButtonRenderer) {
          const a = o.alertRenderer || o.alertWithButtonRenderer;
          const txt = a.text && (a.text.simpleText || (a.text.runs && a.text.runs.map(r => r.text).join('')));
          alerts.push({ type: a.type, text: txt });
        }
        for (const k in o) find(o[k]);
      })(data);
      console.log('[YWI diag] alerts in last response:', alerts.length ? alerts : 'none');
      // Brute-force: every key containing "continuation" anywhere, with its path — reveals a token shape
      // deepToken might miss (e.g. nextContinuationData) vs. the response simply having no continuation.
      const conts = [];
      (function find(o, path) {
        if (!o || typeof o !== 'object') return;
        for (const k in o) {
          if (/continuation/i.test(k)) conts.push({ path: (path + '.' + k).slice(1), value: o[k] });
          find(o[k], path + '.' + k);
        }
      })(data, '');
      console.log('[YWI diag] continuation-ish nodes in last response:', conts.length ? conts : 'NONE');
      console.log('[YWI diag] last response full object:', data);
    } catch (e) {
      console.error('[YWI diag] FETCH ERROR:', e);
    }
  });
  GM_registerMenuCommand('Export watched data (JSON to console)', () => {
    // Read straight from storage (and fold into memory) so the dump always reflects what's actually
    // persisted, not just this tab's in-memory copy — the reliable thing to compare across tabs.
    mergeInto(parseStore(GM_getValue(STORE_KEY, '{}')));
    console.log('[YWI] watched data:', JSON.stringify(watched));
  });
  GM_registerMenuCommand('Reset all watched data', () => {
    if (confirm('Erase all locally-stored watched data for this script?')) {
      // Write empty directly — flush() does a read-merge-write and would fold the old data right back.
      watched = {}; dirty = false; GM_setValue(STORE_KEY, '{}'); lsSet('{}'); GM_setValue(LIKED_TS_KEY, 0); GM_setValue(LIKED_VER_KEY, 0); scheduleSweep();
    }
  });
})();
