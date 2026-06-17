# YouTube Watched Indicator

Tampermonkey userscript that puts a watched-state icon on YouTube video thumbnails:
**empty ○ / half-filled red ◐ / full green ●** = unseen (<5%) / partially watched (5–85%) / watched (>85%).

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
- **Not yet verified in real use**: watch-page capture (player sampling) and the legacy/search
  regime — both written against confirmed structure but test by actually watching part of a video
  and checking a search page.
- **Deferred**: Shorts. Different DOM and cramped metadata; may need the icon to push the view count
  right and may only support a degraded state. Inspect Shorts DOM before implementing.
