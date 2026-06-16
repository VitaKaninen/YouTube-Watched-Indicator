// ==UserScript==
// @name         YouTube Watched Indicator
// @namespace    https://github.com/azrobbins/YouTube-Watched-Indicator
// @version      0.1.0
// @description  Local watched-state icons on YouTube thumbnails. Measures how much of each video you watch (no reliance on YouTube watch history) and stores it in Tampermonkey only. Empty / half / full circle = unseen / partially / fully watched.
// @author       azrobbins
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const STORE_KEY      = 'ywi.watched.v1';   // GM storage key: { videoId: maxFraction }
  const SAMPLE_MS      = 2000;               // how often to sample the player on a watch page
  const FLUSH_MS       = 1500;               // debounce before persisting to GM storage
  const SWEEP_MS       = 200;                // debounce before re-decorating after DOM changes
  const T_PARTIAL      = 0.05;               // >= this fraction -> "half" (red)
  const T_FULL         = 0.85;               // >  this fraction -> "full" (green)
  const GUTTER_OFFSET  = 20;                 // px the badge sits left of the metadata row (the empty gutter)

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
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_MS);
  }
  function record(id, frac) {
    if (!id || !(frac > 0)) return;
    const prev = watched[id] || 0;
    if (frac > prev) {
      watched[id] = Math.round(frac * 1000) / 1000;   // 0.001 precision is plenty
      dirty = true;
      scheduleFlush();
      scheduleSweep();                                 // update any on-screen badges
    }
  }
  // Persist promptly if the tab is hidden/closed mid-watch.
  window.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

  // ---------------------------------------------------------------------------
  // Capture  (read the HTML5 player on /watch and /shorts; store max fraction)
  // ---------------------------------------------------------------------------
  function currentVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  function isAdShowing() {
    const p = document.querySelector('#movie_player, .html5-video-player');
    return !!(p && p.classList.contains('ad-showing'));
  }
  function samplePlayer() {
    const id = currentVideoId();
    if (!id) return;
    if (isAdShowing()) return;                          // the player element plays ads too — ignore those
    const v = document.querySelector('video.html5-main-video, video.video-stream');
    if (!v) return;
    const d = v.duration;
    if (!d || !isFinite(d) || d <= 0) return;          // skip live streams / not-ready
    record(id, Math.min(1, v.currentTime / d));
  }
  setInterval(samplePlayer, SAMPLE_MS);

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
  function buildIcon(state) {
    const svg = svgChild('svg', { viewBox: '0 0 16 16', width: '14', height: '14' });
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

  function placeBadge(row, badge) {
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

  function decorateRow(row) {
    const card = row.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ' +
      'ytd-compact-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model'
    ) || row;
    const id = idFromCard(card);
    if (!id) return;

    let badge = row.querySelector(':scope > .ywi-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ywi-badge';
      placeBadge(row, badge);
    }
    const frac = watched[id] || 0;
    const state = stateFor(frac);
    if (badge.dataset.state !== state) {
      badge.dataset.state = state;
      badge.replaceChildren(buildIcon(state));
    }
    badge.title = `${Math.round(frac * 100)}% watched`;
  }

  function sweep() {
    // Legacy regime: the views/time row is #metadata-line.
    document.querySelectorAll('#metadata-line').forEach(decorateRow);
    // New regime: the metadata block is yt-content-metadata-view-model.
    document.querySelectorAll('yt-content-metadata-view-model').forEach(decorateRow);
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
  new MutationObserver(scheduleSweep).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', scheduleSweep);
  scheduleSweep();

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
