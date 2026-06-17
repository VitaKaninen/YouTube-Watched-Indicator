# YouTube Watched Indicator

A Tampermonkey userscript that puts a small **watched-state icon** on every YouTube video
thumbnail, so you can tell at a glance whether you've already seen something.

| Icon | Meaning | Threshold |
|:---:|---|---|
| **○** empty ring | Unseen | watched < 5% |
| **◐** red half-filled | Partially watched | 5% – 85% |
| **●** solid green | Watched | > 85% |

The icon sits **centered under the channel avatar** on grid cards (home, subscriptions, channel
pages), and falls back to the left of the view-count on list-style cards (e.g. search results).
Hovering shows the exact percentage as a tooltip.

---

## Why it works the way it does (the key design decision)

The obvious way to show "watched" would be to read YouTube's own thumbnail **progress bar**. That is
**not possible here**: the user keeps **YouTube watch history OFF** (and won't turn it on). With
history off, YouTube stores nothing about what you've watched — no server record, and no progress
bar on thumbnails.

So the script **measures watched-ness itself** by watching the HTML5 player, and stores the result
**locally in Tampermonkey**. Consequences (all intentional):

- **No backfill** — it starts empty and accumulates only from the moment it's installed.
- **This browser only** — data lives in this profile's Tampermonkey storage; no cross-device sync.
- **Fully local / private** — nothing is ever sent to Google or anywhere else. This matches the
  user's privacy posture (history off, dedicated browser profile for logged-in YouTube).

---

## How it works

Two independent halves:

### 1. Capture (records how much you watch)
- A timer (`SAMPLE_MS`, every 2 s) samples the page whenever you're on a `/watch` or `/shorts/` URL.
- It reads the HTML5 `<video>` element's `currentTime / duration` and records the **maximum
  fraction** reached for that video ID. The store is **monotonic** — it only ever increases, so
  rewatching from the start never lowers a value.
- Guards: skips while an **ad** is playing (the player element plays ads too — detected via the
  `ad-showing` class), and skips **live streams** (non-finite duration).
- Writes are batched: an in-memory map is flushed to Tampermonkey storage on a debounce
  (`FLUSH_MS`), and immediately when the tab is hidden or closed (`visibilitychange` / `pagehide`).

### 2. Decoration (draws the icons on thumbnails)
- A `MutationObserver` plus the `yt-navigate-finish` SPA event trigger a debounced **sweep**
  (`SWEEP_MS`).
- Each sweep finds every metadata block, resolves the card's video ID from its thumbnail/title link,
  looks the ID up in the store, and draws/updates the icon for the resulting state.
- Icons are built with `document.createElementNS` (SVG), never `innerHTML` — YouTube enforces
  **Trusted Types**, which blocks string-to-HTML assignment.

### Data model
- One Tampermonkey value, key `ywi.watched.v1`, shape `{ "<videoId>": <fraction 0..1> }`.
- Example: `{ "dQw4w9WgXcQ": 0.92, "abcdefghijk": 0.4 }`.

---

## Install & requirements

1. **Tampermonkey** installed in the browser profile you use for YouTube.
2. **Enable "Allow user scripts"** for Tampermonkey: `chrome://extensions` → Tampermonkey →
   **Details** → turn on *Allow user scripts* (older Chrome: enable *Developer mode*). **Recent
   Chrome (MV3) requires this or Tampermonkey injects nothing — with no console error.** Symptom of
   it being off: the script shows *Enabled* but the toolbar icon has no "1" badge and no icons
   appear.
3. Install the script (`youtube-watched-indicator.user.js`) — paste it into a new Tampermonkey
   script, or open the `.user.js` file / its raw GitHub URL so Tampermonkey offers to install.
4. Reload YouTube. Every card should show an empty **○**; watch part of a video and that card turns
   **◐** then **●**.

Watch history can stay **off** — the script does not use or need it.

---

## Configuration

All knobs are `const`s in the **Tunables** block near the top of the script:

| Constant | Default | Purpose |
|---|---|---|
| `T_PARTIAL` | `0.05` | Fraction at/above which the icon becomes **half** (red) |
| `T_FULL` | `0.85` | Fraction above which the icon becomes **full** (green) |
| `ICON_SIZE` | `22` | Icon size in px |
| `AVATAR_GAP` | `16` | Vertical gap (px) below the avatar; raise to move the icon **down**, lower (incl. negative) to move it **up** |
| `GUTTER_OFFSET` | `20` | How far left of the metadata row the icon sits on list-style/fallback cards |
| `SAMPLE_MS` | `2000` | How often the watch-page player is sampled |
| `FLUSH_MS` | `1500` | Debounce before persisting to storage |
| `SWEEP_MS` | `200` | Debounce before re-decorating after DOM changes |

After editing, re-save in Tampermonkey (or re-paste) and reload YouTube.

### Tampermonkey menu commands
Click the Tampermonkey toolbar icon on YouTube:
- **Export watched data (JSON to console)** — dumps the full store to the browser console (useful
  for backup, since data is local-only).
- **Reset all watched data** — erases the local store (with a confirm prompt).

---

## Notes for a future session (maintenance)

- **Selectors drift.** YouTube renames polymer elements and class hashes periodically, and is
  mid-migration between two DOM regimes. The capture/decorate selectors are the brittle part —
  **re-inspect the live DOM rather than trusting these names**:
  - **Legacy polymer** (e.g. search): card `ytd-video-renderer`, metadata row `#metadata-line`.
  - **New view-models** (home / subscriptions / channel grids — primary surface): card
    `yt-lockup-view-model`, metadata `yt-content-metadata-view-model`, view-count span
    `.ytContentMetadataViewModelMetadataText`, avatar `yt-decorated-avatar-view-model`.
- **Trusted Types**: never use `innerHTML` — build DOM nodes (`createElementNS` / `replaceChildren`).
- **Icon color**: the empty/half ring uses `currentColor`. Inside the avatar that inherits **black**
  and disappears on dark theme, so the script pins `badge.style.color` to the card's metadata-text
  computed color at decorate time (adapts to light/dark). `--yt-spec-text-secondary` reads empty at
  `:root` here — don't rely on it.
- **False positives**: non-video rows (e.g. the channel header's subscriber line) are also
  `yt-content-metadata-view-model`; the `idFromCard` guard (requires a `/watch` or `/shorts/` link)
  rejects them.
- **Verifying changes live**: the dev/testing approach used was the *Claude in Chrome* extension
  driving a dedicated, logged-in YouTube profile. One quirk — the extension **redacts query strings**
  from tool output, so you can't read `?v=…` directly; compute IDs *in-page* and return counts, and
  confirm placement/appearance with screenshots + `zoom`.

---

## Status & limitations

- **Verified live**: new-regime grid decoration, icon placement (centered under avatar, fixed
  vertical position regardless of title wrap), video-ID extraction, theme-aware color.
- **Written but not exhaustively tested live**: watch-page capture (player sampling) and the
  legacy/search-results layout — both target confirmed structure; sanity-check in real use.
- **Deferred**: **Shorts**. Different DOM and cramped metadata; likely needs the icon to push the
  view count right and may only support a degraded state. Inspect the live Shorts DOM before
  implementing.
- By design: no backfill, this-browser-only, fully local (see "Why it works the way it does").

---

## File map

- `youtube-watched-indicator.user.js` — the userscript itself.
- `README.md` — this document.
- `CLAUDE.md` — condensed design + gotchas, auto-loaded as context for Claude Code sessions.
