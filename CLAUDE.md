# YouTube Watched Indicator

Tampermonkey userscript: a pill-shaped progress badge on every YouTube video card, driven by watch
progress the script measures itself. Main file: [`youtube-watched-indicator.user.js`](youtube-watched-indicator.user.js).

## Why it measures watching itself
The user keeps YouTube watch history OFF permanently, so YouTube stores nothing (no resume bars on
thumbnails). The script samples the HTML5 player on `/watch` and `/shorts/` and stores results
locally. Accepted: no record of pre-install viewing, this browser only, nothing sent to Google.

## Badge rendering (`buildIcon`, `applyBadgeState`)
- Fill width = `f` exactly; color `barColor()` = HSL hue 0→120 (red→green). `T_PARTIAL`/`T_FULL`/
  `stateFor()` only gate the live re-sweep during capture.
- Outline opacity `OUTLINE_CLICKED` once `c` or `f>0`, else `OUTLINE_UNCLICKED` — opacity, not a
  gray, so it follows the theme. Purpose: the user opens many watch-later tabs and forgets which.
- Gray fill (`BAR_BG`) ⟺ `likedOnly` = `k && !c && !(f>0)`. Clicked or watched → normal rules even
  when liked (user decision, reaffirmed 2026-10-02). Rejected: gray behind every pill (too much
  gray); gray on clicked/watched videos.
- Tooltip `57% / 4:40` (`f*d`); `NN% watched` without `d`; `In your Liked playlist` when likedOnly.
  The badge needs `pointer-events:auto`, or the hover reaches the thumbnail (starts the preview, no tooltip).

## Data model — `{ videoId: { f, l, t, d, c, k } }` under `STORE_KEY`
- `f` furthest fraction, monotonic. `l` last playhead fraction (seek-back lowers it). `t` ms of the
  last `l` write. `d` duration s (0 until known). `c` clicked from a listing. `k` in Liked playlist.
- `mergeInto`: max `f`, fill `d`, newest-`t` wins `l`, OR `c`/`k` (both sticky). `normEntry`
  upgrades legacy bare-number entries.
- `c` and `k` are distinct. v0.17–0.18 stored liked as `c:1`; `applyLiked`'s heal relabels a bare
  `c:1` (no f/l/d) on a liked video to `k:1` **only when the previous `LIKED_VER_KEY` < 2**. Run on
  every backfill (bug until v0.28.0) it erased real clicks on videos liked after the last backfill.

## Storage and cross-tab
- GM storage plus a mirror in the page's `localStorage` (same key). The mirror belongs to the
  origin, so it survives a userscript-manager reset, and old script versions (no mirror code) can't
  strip it. `loadStore` merges it back and re-seeds GM.
- An old-version tab rewrites the single GM blob in its own format and drops fields it doesn't
  know; this recurs whenever a field is added. The mirror is the fix (protects values written by ≥ v0.12.0).
- `flush()` is read-merge-write over both backends, so a stale tab can't clobber others. Reset must
  write `{}` directly — `flush()` would merge the old data back. Export re-reads storage first.
- Cross-tab: `GM_addValueChangeListener` plus the `window` `storage` event (GM's listener is
  unreliable on Firefox/LibreWolf).
- Flush is a **throttle** (`if (flushTimer) return`), never a debounce: `timeupdate` at ~4 Hz
  starves a debounce, and nothing persists during playback.
- `visibilitychange` must be on `document` (Firefox/LibreWolf don't fire it on `window`).

## Capture (`bindVideo`)
- Event-driven on the player `<video>`: `timeupdate`, `seeking`/`seeked` (fire while paused),
  `pause`, `ended` → 1. `seeked`/`pause`/`ended` flush at once. The 2 s interval only rebinds/resamples.
- Also flush on `pagehide`, `beforeunload`, hidden, and `yt-navigate-start` (SPA nav fires none of the others).
- `activeId` comes only from the video's `loadedmetadata`/`durationchange` and is cleared on
  `emptied` — never from the URL — so a late tick from the previous video can't be filed under the new id.
- Player = `#movie_player, #shorts-player`; on native `/shorts/` fall back to the playing `<video>`
  (gated to `/shorts/` so hover previews are never sampled). The user's redirect script sends most
  Shorts to `/watch`. Skip while `ad-showing`; skip non-finite duration (live).

## Click tracking (`markClicked`)
`click`/`auxclick`/`contextmenu` on **`window` capture** (runs before page and other-script handlers
on `document`), and **flush immediately** (the page often navigates or opens a tab before a throttled
flush fires). Works even when the opened tab is deferred and never runs the script.

## Liked backfill (`refreshLiked`)
- Innertube `POST /youtubei/v1/browse`, `browseId:'VLLL'`; key + context from `unsafeWindow.ytcfg`
  (HTML-scrape fallback); auth header `SAPISIDHASH` from `__Secure-3PAPISID` / `__Secure-1PAPISID` /
  `SAPISID` — cookies alone aren't honored. No API key, no `@connect`.
- `collectLiked` walks the whole JSON (shapes drift): `playlistVideoRenderer.videoId`,
  `lockupViewModel.contentId`, tokens from `continuationItemRenderer`/`continuationItemViewModel` via `deepToken`.
- Runs 5 s after load when 24 h stale (`LIKED_TS_KEY`) or `LIKED_VER` changed; the menu command
  forces it; on failure both keys stay so it retries. Reset zeroes both.
- **No live Like detection** — a new like is unknown until the next backfill.
- Observed 2026-10-02: the fetch stops at 4,988 IDs / 50 pages, all `VIDEO` lockups; storage held
  ~2,100 `k` entries not in that list (unliked, or past a ~5,000 cap — unverified). `k` is never cleared.

## Watch-page resume bar (`updateWatchBar`, `/watch` only)
Div bar in `ytd-watch-metadata #above-the-fold` before `#bottom-row`, max `WATCHBAR_MAXW` 360 px
(full width was too wide; placing it above the title was tried and reverted). Fill = `f`, white
marker = `l`. **Not a scrub bar:** a click anywhere seeks in place to `l`; clicking elsewhere must
never move (and via `record()` overwrite) the saved spot.
Known from code, not measured: after a reload the video starts at 0:00, and pressing Play before
clicking the bar overwrites `l` on the first tick; the click then does nothing (`l > 0` guard).

## DOM regimes (`sweep`) and placement
| Regime | Card | Badge placement |
|---|---|---|
| View-model (subscriptions, channel grid, `/playlist`, watch sidebar) | `yt-lockup-view-model` + `yt-content-metadata-view-model` | under the avatar when it has a real box (`placeUnderAvatar`; `yt-decorated-avatar-view-model` or multi-author `yt-avatar-stack-view-model`), else inline at the start of the first metadata row (`placeBesideMeta`) |
| Legacy (search) | `ytd-video-renderer` `#metadata-line` | `placeInGutter`, left of the row |
| Shorts | `ytm-shorts-lockup-view-model-v2` wrapping `ytm-shorts-lockup-view-model` (normalize to outer, dedupe) | inline left of the view-count subhead (`placeBesideViews`, user preference), `SHORTS_ICON` |
| Playlist panel (watch page with `list=`) | `ytd-playlist-panel-video-renderer` | prepended in `#byline-container` |

- Only the subscriptions grid renders the avatar; channel grid, `/playlist` and the watch sidebar
  omit it or collapse it to 0×0. Keep the `offsetWidth/Height > 0` guard: anchoring to a 0×0 avatar
  puts the badge off-screen. Under-avatar badges on one-line-title cards hang into the row gap (fine).
- Set `badge.style.color` from the card's metadata text: inside the avatar `currentColor` is black
  (invisible on dark). `--yt-spec-text-secondary` reads empty at `:root`.
- Non-video `yt-content-metadata-view-model` rows (channel header) are skipped by requiring a
  resolvable `/watch` or `/shorts/` id.
- Trusted Types: build all DOM with `createElement`/`createElementNS`, never `innerHTML`.
- Selectors drift; re-inspect live rather than from memory.

## Testing with Claude-in-Chrome (screenshots forbidden — user rule)
- Read state from the page: `localStorage['ywi.watched.v1']` is the mirror. Audit each card: badge
  count, rendered state (gray rect `rgba(128…`, `hsl` fill width ÷ 40, outline opacity) vs. the
  stored entry, plus an `elementFromPoint` hit test.
- Channel pages have a sticky header over the viewport middle: hit-test after
  `scrollIntoView({block:'end'})`, not `center`. `/playlist` badges need ~2 s+ after load.
- Disable Open Links in New Tab first (it takes synthetic clicks). The user's autoplay blocker also
  blocks script-started playback: seeks can be tested (`#movie_player.seekTo`), playback capture can't.
- Verified 2026-10-02 (v0.27.0): subscriptions (1,202 cards incl. Shorts shelf and multi-author),
  `/playlist` (500), LL and uploads watch-page panels, watch sidebar incl. the "From <channel>" chip,
  channel Videos and Shorts tabs, click marking, seek capture, resume bar across reload + click.
  Not tested: search results (legacy regime), clicked/liked Shorts, playback capture.

## Install (Chrome MV3)
Tampermonkey needs its per-extension **Allow user scripts** toggle (chrome://extensions → Tampermonkey
→ Details). Without it the script shows Enabled but never runs — no badge count, no error.
