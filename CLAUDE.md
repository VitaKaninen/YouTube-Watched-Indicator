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
- **Icon placement**: badge is `position:absolute; left:-20px` in the metadata row's left gutter so
  it sits left of the view count **without reflowing it** (the row is set `position:relative`).
  `GUTTER_OFFSET` is tunable.
- **False positives**: non-video metadata rows (e.g. the channel header's subscriber line) are also
  `yt-content-metadata-view-model`. The `idFromCard` guard (requires a `/watch` or `/shorts/` link)
  rejects them — don't decorate a row without a resolvable video ID.
- **Selectors drift**: YouTube renames polymer elements / class hashes periodically. The capture/
  decorate selectors are the brittle part and will need occasional maintenance. Re-inspect live
  rather than guessing from memory.

## Status

- **Verified live**: new-regime decoration + icon placement + video-ID extraction (30/31 cards on a
  channel grid; the 1 skip = header row, correct).
- **Not yet verified in real use**: watch-page capture (player sampling) and the legacy/search
  regime — both written against confirmed structure but test by actually watching part of a video
  and checking a search page.
- **Deferred**: Shorts. Different DOM and cramped metadata; may need the icon to push the view count
  right and may only support a degraded state. Inspect Shorts DOM before implementing.
