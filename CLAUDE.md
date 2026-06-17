# YouTube Watched Indicator

Tampermonkey userscript that puts a watched-state icon on YouTube video thumbnails:
**empty ○ / half-filled red ◐ / full green ●** = unseen (<5%) / partially watched (5–50%) / watched (>50%).

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

Data model: `{ videoId: maxFraction }` (0..1), monotonic — only ever takes the max fraction seen.

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
  filed under the new id. Player `<video>` is found via `#movie_player, #shorts-player` (scoped so a
  thumbnail hover-preview's inline `<video>` is never sampled). **Shorts opened as normal `/watch`**
  (the user runs a redirect script) therefore capture through this same reliable watch path; native
  `/shorts/` capture is best-effort (`#shorts-player`, first match only).
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
