# YouTube Watched Indicator

Tampermonkey userscript that puts a watched-state icon on YouTube video thumbnails. As of **v0.6.0**
the icon is a **pill-shaped progress bar** (same `currentColor` rounded outline as the old ring, just
elongated) whose **fill width = the exact stored watched fraction** and whose **fill color sweeps
red → yellow → green** as it fills (linear HSL hue interp 0°→120°, `barColor()`). It replaced the old
three-state empty ○ / half-filled red ◐ / full green ● circle. The `T_PARTIAL`/`T_FULL` thresholds and
`stateFor()` survive only as a coarse gate for the live re-sweep during capture (see below) — they no
longer drive what's drawn; the bar always renders the precise fraction.

Main file: [`youtube-watched-indicator.user.js`](youtube-watched-indicator.user.js)

## Core design decision — why we measure watched-ness ourselves

The user keeps **YouTube watch history OFF and will not turn it on**. With history off, YouTube
stores *nothing* about what you've watched — no server record, and critically **no resume-playback
progress bar on thumbnails**. So the obvious approach (read YouTube's own progress bar) is impossible.

Instead the script **measures watched-% itself** from the HTML5 player on `/watch` (and `/shorts/`)
and stores it locally in Tampermonkey. Consequences, all accepted by the user:
- **No backfill** — starts empty, accumulates only from install forward.
- **This-browser-only** — data lives in this profile's GM storage; no cross-device sync.
- **Fully local** — nothing sent to Google; consistent with the user's history-off stance.

Data model (**v0.10.0**): `{ videoId: { f, l, t, d, c } }`:
- `f` — **furthest** fraction (0..1), monotonic high-water mark (only ever increases). Drives the
  thumbnail bar fill and the watch-page green fill.
- `l` — **last** fraction (0..1), the most recent playhead position; **not** monotonic (a seek-back
  lowers it). Drives the watch-page white marker and the resume click.
- `t` — ms timestamp of the last `l` update. Used only to resolve `l` across tabs (see `mergeInto`):
  since `l` has no max to fall back on, the newest write wins.
- `d` — durationSeconds, constant per video, captured from the player, filled in whenever it first
  becomes known (0 until then). Needed for the mm:ss timestamps.
- `c` — **clicked/opened** flag (1 once you've opened the video from a listing, even if never watched);
  sticky, OR-merged across copies. Dims the empty bar's outline until set (see below).

**Legacy compat:** older entries were a bare number (just the fraction); `normEntry()` upgrades any
`number` to `{ f, l: f, t: 0, d: 0, c: 0 }` on read, so old data keeps working — `l` defaults to `f` and
the timestamp won't show until `d` is recaptured. All storage helpers (`fracOf`/`lastOf`/`durOf`/`mergeInto`/
`record`) operate on the object shape; the in-memory map is normalized to objects in `parseStore()`.

Two features ride on `d`:
- **Hover timestamp** — the thumbnail bar's `title` shows `57% / 4:40` (percentage + the position you'd
  reached = `f * d`), via `fmtTime()`. Falls back to `NN% watched` when `d` is unknown. **Gotcha:** the
  badge must be `pointer-events: auto` for the native `title` tooltip to appear — with `none` (the
  original value) the hover passes through to the thumbnail, which starts the video preview and the
  tooltip never shows. Shorts already worked because `placeBesideViews` never set `none`; the grid
  (`placeUnderAvatar`) and list (`placeInGutter`) placements did and were flipped to `auto`.
- **Watch-page resume bar (`/watch` only)** — `updateWatchBar()` injects a clickable `<div>` bar under
  the title (anchored in `ytd-watch-metadata #above-the-fold`, before `#bottom-row`; capped at
  `WATCHBAR_MAXW`=360px — full column width was "too wide"). Green fill = **furthest** position (`f`);
  white marker = **last** position (`l`, ≤ `f`). **It is deliberately NOT a scrub bar:** clicking
  *anywhere* jumps to the LAST position (`video.currentTime = lastOf(id) * d`), never to the click point
  — clicking elsewhere must not move (and thus overwrite, via `record()`) your saved spot. Seeks **in
  place, no reload** (the point of it vs. a `?t=` URL). Built from divs (not SVG) so it stretches with
  rounded ends. Wired from `sweep()` + the `SAMPLE_MS` interval; removes itself when off `/watch`.

**Click tracking (`c`):** a capture-phase `click`/`auxclick`/`contextmenu` listener (`markClicked` /
`idFromClick`) marks a video opened the instant you click its card on a listing — covering left-click,
middle-click, and right-click→open-in-new-tab. Captured **on the listing page**, so it works even though
the user's setup opens videos in deferred/lazy-loaded tabs that never run the script (the whole point —
the new tab needn't load for the mark to stick). The empty bar's outline is dim (`OUTLINE_UNCLICKED`
opacity) until clicked, then brighter (`OUTLINE_CLICKED`); a watched video (`f>0`) counts as clicked
regardless. Opacity (not a hardcoded gray) so it adapts to theme. Purpose: the user opens many "watch
later" tabs and forgets which they've already opened.

**Click-persistence gotchas (v0.11.0 fix — clicked outlines vanished on reload):**
- **Flush IMMEDIATELY on click, not via `scheduleFlush`** — unlike playback (continuous, throttled), a
  click is a one-shot event and the page often navigates / reloads / spawns a new tab right after, so a
  1.5s deferred flush gets lost in that window before it persists. `markClicked` calls `flush()` directly.
- **Listen on `window` capture, not `document`** — capture order is window → document → target, so a
  window-capture handler fires before any page/extension handler on `document` (e.g. the user's
  "open in new tab" script) that might `stopImmediatePropagation` and prevent us from seeing the click.
- Within one script version storage never regresses `c` (read-merge-write OR-merges it; only Reset
  writes `{}`). The real-world regression we hit (v0.12.0) came from **a stale OLD-version tab** — see
  the durable-mirror gotcha below.

**Stale-tab field-stripping + durable localStorage mirror (v0.12.0):** symptom was a clicked entry
losing only `c` (`{f,l,t,d}` intact, `c:1`→`c:0`) with no edit, after a wait+reload. Cause: the user
keeps many tabs open; a tab still running a **pre-`c` version (≤v0.9.0)** rewrites the whole single-key
GM blob in its older format on its next flush, silently dropping fields it doesn't know (`c`). Any
writer that doesn't OR-merge a field will strip it — this recurs whenever a new field is added and an
old tab lingers (every `@version` bump leaves old tabs running until reloaded). Operational fix: close
all YouTube tabs and reopen. Code fix: **mirror the map into the page's `localStorage`** (`lsGet`/`lsSet`,
same `STORE_KEY`) alongside GM storage. It belongs to the youtube.com **origin, not the script**, so (a)
it survives the userscript manager resetting GM values on edit, and (b) old script versions have no
localStorage code so they never strip it — `loadStore()` merges it back and re-seeds GM (`healed`),
healing a stripped GM copy. `flush()` writes both backends (merging both first); Reset clears both; a
`window` `'storage'` event folds in cross-tab changes (reliable on Firefox/LibreWolf, unlike GM's
listener). Caveat: only protects values written by ≥v0.12.0 — data already stripped before the mirror
existed is gone.

## Gotchas (verified live 2026-06-16)

- **Capture is event-driven (v0.3.0, was polling)**: the old `setInterval(samplePlayer, 2000)` only
  caught the watched position if a 2s tick happened to land at the right moment — it routinely lost
  seeks-then-SPA-navigate and slider moves with no playback. Now `bindVideo()` attaches listeners to
  the player's `<video>` (`timeupdate` for playback, `seeking`/`seeked` for manual scrubbing — these
  fire even while paused / never-played, so dragging the slider past a threshold records immediately),
  plus `ended`→full. The 2s interval remains only as a safety net + to (re)attach when the `<video>`
  appears/swaps. Flush triggers: `visibilitychange`(hidden), `pagehide`, `beforeunload`, and crucially
  **`yt-navigate-start`** (SPA nav away from a video fires none of the first three). Mis-attribution
  guard: `activeId` (the loaded video's id) is set **only** from the video's own load events
  (`loadedmetadata`/`durationchange`, when the URL has settled) and cleared on `emptied`, never
  straight from the URL — so a stray late `timeupdate` from the previous video during a nav can't be
  filed under the new id. Player `<video>` is found via `#movie_player, #shorts-player`; on a native
  `/shorts/` page (no redirect) `mainVideo()` falls back to the playing `<video>` in the feed (gated
  to `/shorts/` so it never grabs a hover-preview elsewhere). **Shorts opened as normal `/watch`**
  (the user runs a redirect script) capture through the reliable watch path either way.
- **Flush must be THROTTLED, not debounced (v0.4.0 fix — caused silent data loss on Firefox/LibreWolf)**:
  `scheduleFlush` was a debounce (`clearTimeout` + reset). Fine with the old 2s polling (2s > 1.5s
  debounce so it drained), but the event-driven `timeupdate` fires ~4x/s, resetting the 1.5s timer
  before it ever fires → **nothing persisted to GM storage during continuous playback**; only videos
  paused/ended for >1.5s (or caught by a teardown flush) were saved. Symptom: export showed a handful
  of entries despite watching dozens. Fix: throttle — schedule at most one flush per `FLUSH_MS` and
  let it fire (`if (flushTimer) return;`). Chrome masked it because its teardown flush persisted
  reliably; Firefox's didn't.
- **`visibilitychange` listener must be on `document`, not `window`**: Firefox/LibreWolf don't fire it
  on `window`, so the tab-switch flush was silently skipped there (worked on Chrome). Canonical target
  is `document`.
- **Cross-tab GM storage doesn't propagate reliably on Firefox/LibreWolf (v0.5.0)**: with a video tab
  and an already-open Subscriptions tab, the subs tab kept reading a *stale* blob even after a reload —
  a freshly-watched video was in storage (the watch tab's reload-dump proved it) yet absent from the
  subs tab's dump. Diagnostic tell: the whole map is one JSON value under one key, so a single fresh
  read can't contain one new entry but miss another — divergent dumps ⇒ the tabs hold different copies.
  Two-part fix: (1) **read-merge-write** in `flush()` (`mergeInto(storage)` before `GM_setValue`) so a
  stale in-memory copy can never clobber another tab's entries (monotonic max keeps the larger); (2)
  **`GM_addValueChangeListener`** (`watchStore()`) to fold in remote writes live and re-sweep, so an
  open tab updates without a manual reload. **Caveat from (1):** the Reset menu command must write `{}`
  **directly** (not via `flush()`, which would merge the old data straight back). The export command
  now re-reads storage before dumping so it reflects what's persisted, not just this tab's memory.
- **Trusted Types**: youtube.com enforces `require-trusted-types-for 'script'`, so
  `element.innerHTML = '<svg…>'` **throws**. Build all DOM (the SVG icons) with
  `document.createElementNS` / `replaceChildren`, never innerHTML.
- **Two DOM regimes, mid-migration** — the script must handle both:
  - **Legacy polymer** (search results): `ytd-video-renderer` → metadata row is `#metadata-line`
    with `<span>` children.
  - **New view-models** (home / subscriptions / channel grids — the primary surface):
    `yt-lockup-view-model` → metadata is `yt-content-metadata-view-model`; view-count span is
    `span.ytContentMetadataViewModelMetadataText`.
  `sweep()` decorates by querying `#metadata-line` AND `yt-content-metadata-view-model`.
- **Ads share the player element**: during ads `currentTime/duration` refer to the *ad*. Skip
  sampling when `#movie_player` / `.html5-video-player` has the `ad-showing` class.
- **Live streams**: `duration` is `Infinity` — guard against non-finite duration.
- **Icon placement**: on grid cards the badge is anchored **under the channel avatar**
  (`yt-decorated-avatar-view-model`), centered, `top:100%` + `AVATAR_GAP`px. The avatar's position is
  fixed regardless of title wrap, so the icon no longer drifts when a title spans two lines (an
  earlier version anchored to the views row and *did* drift). List-style cards without a usable
  avatar (e.g. search results) fall back to `placeInGutter` (`left:-GUTTER_OFFSET` of the metadata
  row). Tunables: `ICON_SIZE`, `AVATAR_GAP`, `GUTTER_OFFSET`.
- **Shorts DOM (verified live 2026-06-16, subscriptions Shorts shelf)**: a third regime. Card is
  `ytm-shorts-lockup-view-model-v2` which **wraps** an inner `ytm-shorts-lockup-view-model` (older
  element, still present) — both match, so `decorateShort` normalizes to the outermost via
  `.closest('…-v2') || .closest('…')` and the badge-exists guard dedupes (verified 1 badge/card after
  a double sweep). Shorts have **no** `yt-content-metadata-view-model` and **no**
  `yt-decorated-avatar-view-model`, so neither existing placement applies. Link is
  `a.reel-item-endpoint[href=/shorts/ID]` (caught by `idFromCard`'s `/shorts/` branch). Title/views are
  in `.shortsLockupViewModelHostOutsideMetadata`; the view count is the
  `.shortsLockupViewModelHostOutsideMetadataSubhead` block (gray ~`rgb(170,170,170)`, 14px). **Per user
  preference the badge sits inline to the LEFT of the view count** (`placeBesideViews` makes that
  subhead a flex row and prepends the badge, pushing the count right), at `SHORTS_ICON`=18px to match
  the text, colored to the subhead text color so the ring adapts to theme. (An earlier version overlaid
  it on the thumbnail top-left; replaced.)
- **Icon color / `currentColor`**: the empty + half rings use `currentColor`. Inside
  `yt-decorated-avatar-view-model` that inherits **black** (`rgb(0,0,0)`) → invisible on dark theme.
  Fix: at decorate time set `badge.style.color` to the card's metadata-text computed color
  (`.ytContentMetadataViewModelMetadataText`, ~`rgb(170,170,170)` on dark) — adapts to theme.
  Note `--yt-spec-text-secondary` reads **empty** at `:root` here, so don't rely on it.
- **False positives**: non-video metadata rows (e.g. the channel header's subscriber line) are also
  `yt-content-metadata-view-model`. The `idFromCard` guard (requires a `/watch` or `/shorts/` link)
  rejects them — don't decorate a row without a resolvable video ID.
- **Selectors drift**: YouTube renames polymer elements / class hashes periodically. The capture/
  decorate selectors are the brittle part and will need occasional maintenance. Re-inspect live
  rather than guessing from memory.

## Install gotcha (Chrome MV3)

Recent Chrome (MV3) requires a per-extension **"Allow user scripts"** toggle before Tampermonkey can
inject *any* userscript. Symptom: the script shows **Enabled** in the Tampermonkey popup but the
toolbar icon has **no "1" badge** and nothing runs (no console error either). Tampermonkey shows a
banner "Please enable the `Allow User Scripts` extension setting." Fix: `chrome://extensions` →
Tampermonkey → **Details** → enable **Allow user scripts** (older Chrome: enable Developer mode),
then reload the page. Must be done in the *same profile* the script lives in.

## Status

- **Verified live**: new-regime decoration + icon placement + video-ID extraction (30/31 cards on a
  channel grid; the 1 skip = header row, correct).
- **Capture rewritten event-driven (v0.3.0), not yet verified in real use**: replaced the 2s polling
  with `<video>` event listeners + `yt-navigate-start` flush (see the capture gotcha above). Threshold
  for "full" lowered 0.85→0.50. Test by: (a) seek the slider past ~5% / past ~50% **without playing**
  and confirm half/full record; (b) play a bit then click straight to another video and confirm the
  position stuck; (c) confirm an unrelated video isn't falsely marked after navigating away.
- **Legacy/search regime**: still written against confirmed structure but not separately re-verified.
- **Shorts decoration (v0.2.0)**: implemented and **verified live** on the subscriptions Shorts shelf
  — all three states render in the thumbnail top-left and are legible; dedup confirmed. Capture for
  Shorts now rides the normal `/watch` path (the user's redirect script), which is the reliable route.
