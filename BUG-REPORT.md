# Snowball — Bug report: image quality, zoom / lightbox, and smooth scrolling

Repo: https://github.com/Pkbroi/Snowball.git — analysed at `main` HEAD
`8794d9b` (“feat: update weekly journal, trade detail, storage, hooks, and test specs”),
compared against `753f9cc` and the initial commit `e528a36`.

**Short answer: yes, all three are real regressions from the latest commit, and
they share one cause — the new two-tier image engine.** The old code stored
uploads losslessly and loaded the full image into the detail page; the latest
code compresses every upload, and then only ever shows the 480px thumbnail —
in the grid (correct) *and* in the detail page / lightbox (wrong).

> ⚠️ Images already uploaded with the latest version cannot be repaired:
> the compressed data-URL is what was stored, the original pixels are gone.
> Those charts need to be re-uploaded from the original files after this fix.

## 1. Image quality — uploads are compressed (lossy, downscaled)

**Where:** `src/data/storage.js` — `fileToDataUrl()` (new in `8794d9b`)

```js
// latest (broken)
const compressedFile = await imageCompression(file, {
  maxSizeMB: 1,
  maxWidthOrHeight: 1920,
  useWebWorker: true,
});
```

* Any screenshot wider than 1920px (2560px / ultrawide trading charts are
  the norm) is downscaled to 1920px and re-encoded lossily to fit 1MB.
* Every upload path goes through it: grid cell drop/paste
  (`WeeklyJournal.jsx` `DayCell.saveFile`), detail-page upload / drop / paste
  (`TradeDetail.jsx` `persistChart`), and Quill note images.
* The old code (`e528a36`, `753f9cc`) was a plain
  `FileReader.readAsDataURL(file)` — no resize, no re-encode. That is why
  old images look superior.
* `setStoredImg()` then stored that compressed data-URL string in IndexedDB
  (base64, ~33% larger than the file, slower to read/write).

**Fix (in this patch):** `fileToDataUrl()` is a lossless pass-through again.
Chart uploads now pass the `File`/`Blob` straight to `setStoredImg()`, which
stores the original Blob in IndexedDB as-is and awaits the write (it was
fire-and-forget before — an upload could be lost on a fast reload).
`browser-image-compression` is removed from `package.json` / `package-lock.json`.
The 480px WebP thumbnail (`createThumbnail`, max 480px, quality 0.8) is kept,
but only for the grid.

## 2. Zoom / lightbox — the image does not fill the screen

The lightbox JSX itself barely changed, which is why this looks mysterious.
The bug is in the *data* reaching it, plus its sizing:

1. `initStorage()` (latest) pre-caches **only thumbnails** into memory.
   Full `sb_img_*` values are never loaded unless the image has no thumb.
2. `DayCell` (latest) reads **only** `getStoredThumb()` — the 480px thumbnail.
   The old cell used an `IntersectionObserver` + `getStoredImgAsync()` to
   load the full image when the cell became visible, and passed *that* to
   the detail page.
3. `goToDetail()` therefore passed `getStoredImg(...) || cellImg` → `null ||`
   480px thumbnail as `day.img`.
4. `TradeDetail` only ever called the synchronous `resolveImg()` (its
   `resolveImgAsync` import was unused) and never called
   `getStoredImgAsync()` — so it could never upgrade to the full image.
5. The lightbox `<img>` had only `maxHeight: 95vh; maxWidth: 95vw` and no
   width/height, so a 480px image renders at 480px, centred — it cannot
   fill the screen. The inline chart also changed `object-cover` → 
   `object-contain` inside a fixed `aspect-[1916/1000]` frame, so
   non-1916:1000 charts letterbox instead of filling the frame.

**Fix (in this patch):**

* `TradeDetail`: on mount it loads the full image with `getStoredImgAsync()`,
  pre-decodes it with `new Image()` + `img.decode()`, and only then swaps
  it in (thumbnail stays as a blurred placeholder meanwhile — no flicker).
  `resolveImgAsync()` in `storage.js` now actually does the async load
  instead of just calling the sync resolver.
* `WeeklyJournal.goToDetail()`: pre-loads the full image with
  `getStoredImgAsync()` before navigating (an IndexedDB read, ~10–50ms),
  falling back to the thumbnail if it fails.
* Lightbox image is now `h-full w-full object-contain` with the **full-res**
  source, `decoding="async"`, `fetchPriority="high"`. Clicking the backdrop
  or pressing **Escape** closes it; background scroll is locked and Lenis
  is stopped while it is open. Inline chart is `object-cover` again.
* `data-testid="chart-lightbox"` / `"chart-lightbox-image"` added for tests.

## 3. Scrolling is not butter-smooth, and image loading is not smooth

Four contributors, all new in `8794d9b`:

| Cause | Detail |
|---|---|
| Startup blocks on images | `initStorage()` fully awaited thumbnail generation for every image without one — canvas-decoding every full-res chart before first paint (`App.jsx` “Preparing images…” spinner). Old `initStorage()` skipped images entirely and lazy-loaded them. |
| Lenis + Virtuoso fight | Lenis (`useLenis`, `duration: 1.2s`, hand-rolled rAF loop ticking every frame) was added on top of the newly added Virtuoso list. Lenis animates `scrollTop` on every wheel tick; Virtuoso re-renders rows on every scroll tick. Scroll restoration then set `container.scrollTop` directly while Lenis was running, so Lenis animated it back. |
| Too much off-screen work | Virtuoso `overscan: 600` + `increaseViewportBy: 500/500` renders ~3× more rows (and decodes ~3× more thumbnails) than the viewport needs. |
| Compositor / memory | `will-change: scroll-position` on the whole grid container forces one giant compositor layer; `URL.createObjectURL()` blob URLs were never revoked on replace/delete (the old code revoked them), leaking memory as you scroll/upload. |

**Fix (in this patch):**

* `initStorage()` returns after metadata + thumbnails; missing thumbnails
  are backfilled in the background via `requestIdleCallback` (fallback
  `setTimeout`), never blocking first paint. Full images stay lazy.
* `useLenis()`: Lenis 1.3's built-in `autoRaf: true` instead of the manual
  rAF loop; default `duration` 1.2s → **0.9s** (still smooth, stops trailing
  behind fast wheel input). Scroll restoration stops Lenis, sets the
  position directly, then restarts it.
* Virtuoso `overscan` 600 → **200**, `increaseViewportBy` 500 → **200**.
* Removed `will-change: scroll-position` from the scroll container in
  `index.css` (kept `overscroll-behavior: contain`).
* Grid thumbnails: `loading="lazy"`, `decoding="async"`,
  `fetchPriority="low"`, fade-in on load (`opacity-0 → opacity-90`) instead
  of popping in; detail image: `fetchPriority="high"`, decoded before swap.
* Blob URLs are revoked when an image/thumbnail is replaced or deleted.

## Verification (all run against this patched copy)

* `npm run build` — passes.
* `npx vitest run` — **7/7 pass**, including 3 new regression tests in
  `src/data/storage.test.js` (lossless `fileToDataUrl`, full image still
  retrievable once a thumbnail exists, full image loadable after a fresh
  `initStorage` with a thumb-only cache).
* `npx playwright test` — **11/11 pass**, including the new
  `tests/image-quality-zoom.spec.js`: generates a 2560×1440 chart at runtime
  (pure-Node PNG encoder, no binary fixture in the repo), asserts the inline and lightbox
  images have `naturalWidth === 2560`, asserts the lightbox image fills
  >90% of the viewport in width or height, asserts Escape closes it, and
  asserts the grid cell still uses a ≤480px thumbnail.
  (Existing zoom/scroll-restoration, trade-detail, weekly-journal and
  performance specs all still pass.)
* `npm run lint` — 0 errors (15 warnings, pre-existing patterns).

## How to apply

The fixed copy is in this folder; the patch against upstream `main`
(`8794d9b`) is `../snowball-fix.patch` (10 files, +463/−217). From a clean
clone:

```bash
git apply snowball-fix.patch
npm install
npm run build
npx vitest run
npx playwright test   # needs: npx playwright install chromium --only-shell
```

Then re-upload any charts that were uploaded with the latest version —
those are the only ones whose quality cannot be recovered.

---

## v2 — Smooth experience improvements (2026-11-13, implemented and pushed)

All of these keep the v1 rule: the original upload is never touched.
Derived copies are only ever used at their own display size.

- **Three-tier images** (`storage.js`, `src/workers/imageWorker.js`):
  480px thumb (grid) / 1600px medium (detail inline) / untouched original
  (lightbox). Derivatives are generated in a Web Worker
  (`createImageBitmap` + `OffscreenCanvas` off the main thread) with a
  main-thread canvas fallback; a 400ms fallback timeout was too short for
  2560px charts and was raised to 10s. Metadata (width, height, size,
  type, filename) is recorded at upload time under `sb_meta_*` and shown
  as "Original · 2560 × 1440 · 39 KB · PNG" on the detail page.
  Legacy images get their medium backfilled in the background by
  `initStorage`, and `ensureMedium` generates it on demand.
- **Detail page**: inline chart shows the medium (decodes ~900px-wide
  display, not a 2560px original), lightbox shows the full original;
  neighbour days' medium images are preloaded when idle
  (`preloadNeighbourImages`).
- **Scrolling**: Lenis removed from the journal grid entirely — Virtuoso
  now scrolls natively, which was the main scroll fight. Lenis remains
  for the detail page only, and now skips itself for reduced-motion and
  touch devices, and shortens duration to 0.6s on low-end hardware.
  Table zoom is now a single CSS `zoom` on the grid container instead of
  new `gridTemplateColumns` + font sizes for every row (WeekRow props
  no longer change on zoom).
- **Search**: one index built per search change in the parent
  (`searchHits` Set of `weekId|day`), passed down as booleans — DayCell
  no longer runs `getNotesText`/`getTags` per cell per keystroke.
- **Lightbox pan/zoom**: wheel zoom, drag to pan, pinch zoom, double-click
  toggles fit/2×, toolbar with zoom out / fit % / zoom in / 1:1 buttons,
  pan clamped so the image can't be dragged off-screen. All one GPU
  transform, never a re-decode.
- **Tests**: 3 new unit tests (metadata, `formatBytes`, derivative
  fallback); new `tests/smooth-experience.spec.js` (medium/badge,
  lightbox zoom controls + wheel, search highlight); the old
  image-quality spec now expects inline 1600px (medium) and lightbox
  2560px. PNG encoder shared via `tests/helpers/chart-png.js`.
- **Bugs found by the tests, fixed in this round**: (1) replacing the
  old full-res loading effect accidentally deleted the effect that sets
  `data-testid="notes-editor"` on the Quill root — restored; (2) after
  an upload the inline chart stayed on the full image because nothing
  swapped it to the medium once the background generation landed —
  `persistChart` now calls `resolveMediumAsync` after upload.
- **Verification (2026-11-13)**: `npm run build` passes; lint 0 errors /
  15 warnings (pre-existing); vitest 10/10; Playwright 14/14.

---

## v2.1 — Blank black screen in the packaged exe (2026-11-13)

**Symptom:** the downloaded exe opened a window titled "trading-journal"
with a completely black screen; nothing ever rendered.

**Root cause (packaging, not app code):** the v2 exe's `app.asar`
contained **zero files under `dist/`** — no `dist/index.html`, no JS/CSS,
no worker. `main.cjs` calls `loadFile(dist/index.html)`; with that file
absent Electron silently failed and sat on the black `backgroundColor`.
How it happened: `dist/` had been deleted while preparing the v2 patch,
and the exe was then built with bare `npx electron-builder --win portable`.
electron-builder does **not** run the Vite build itself — that only happens
via the `electron:build` npm script (`npm run build && electron-builder`).
The app code was fine: `vite.config` already uses `base: './'` (relative
asset paths, correct for `file://`) and strips `crossorigin` attributes.
Verified by listing the asar: 0 `/dist/` entries in the broken exe vs 68
in the fixed one (incl. `/dist/index.html`,
`/dist/assets/imageWorker-*.js`).

**Fix:**
- `main.cjs`: checks `dist/index.html` exists before loading; if missing,
  shows a plain-language error dialog + an error page instead of a black
  screen. `did-fail-load` handler added for later load failures.
- `scripts/verify-dist.cjs` + `electron:build` now runs
  `npm run build && node scripts/verify-dist.cjs && electron-builder`,
  so packaging fails loudly if the renderer output is missing
  (verified: exits 1 with dist/ absent, 0 with it present).
- `tests/electron-packaging.spec.js`: loads `dist/index.html` over
  `file://` exactly as Electron does and asserts the journal renders
  (run `npm run build` first; it skips if dist is absent).
- Note for Linux builds: bare `electron-builder` targets the host OS
  (it built a Linux AppImage here); Windows exes need
  `--win portable` explicitly. On the user's Windows machine the
  `electron:build` script targets Windows by default.

**Verification (2026-11-13):** build passes; lint 0 errors / 15 warnings
(pre-existing); vitest 10/10; Playwright 15/15 (incl. the new packaging
test); rebuilt exe's asar contains 68 `/dist/` files.

---

## v3 — ChatGPT black theme + icon-font fix (2026-11-13, implemented and pushed)

**User request:** adapt the ChatGPT app's black theme — deep black/white contrast, its button and font aesthetic — changing only look and colour, never the spacing of cells/buttons. Also: "calendar_today" text was appearing in each column heading in the mockup/screenshot.

**Why "calendar_today" appeared:** the app renders icons with the Material Symbols icon font, loaded from Google Fonts. The ligature text (e.g. `calendar_today`) is the literal text content of the icon element — when the font fails to load (the headless browser used for screenshots could not reach Google Fonts), the browser falls back to a normal font and the name prints as text. In the real app on Windows it normally loads, but any offline/slow start showed the same text. Fixed properly instead of hiding it:
- Downloaded the Material Symbols Outlined variable font (1.1 MB woff2) into `src/assets/fonts/` and added a local `@font-face` in `src/index.css`; removed the Google Fonts link for it from `index.html`. Icons now render offline and are bundled into the packaged exe.
- Verified with `document.fonts.check("16px 'Material Symbols Outlined'")` → true, and a screenshot shows real calendar/gear/search icons, no ligature text.

**Theme changes (look/colour only, zero spacing/layout changes):**
- Tokens (`tailwind.config.js`): page `#000000`, surfaces `#212121` / `#2f2f2f`, hairlines `#424242`, text `#ececec`, muted `#b4b4b4`; primary white `#ffffff` with black on-primary; cyan `#00eefc` and purple `#8b2ce3` accents removed (secondary/tertiary containers → `#2f2f2f`); error kept as a restrained rose `#fda4af` for destructive text only.
- `src/index.css`: body text `#ececec`, scrollbars `#424242` on `#000000`, layer surfaces `#212121`/`#2f2f2f`, selection white-on-black, body `letter-spacing: -0.01em` (ChatGPT-style tight tracking; Inter stays, Söhne is proprietary).
- `WeeklyJournal.jsx`: header/grid `#212121` with `#424242` hairlines, search field and zoom control become ChatGPT-style pills (`rounded-full`, `#2f2f2f`), add-week button is now solid white with a black `+`, search highlight `bg-blue-900/60` → `bg-white/10`, W/L outcome badges are monochrome (white letter on `#2f2f2f`, `#424242` border), delete-data button monochrome.
- `TradeDetail.jsx`: image resize handles/selection `#3b82f6` → `#ececec`; back button surfaces remapped.
- `App.jsx`: loading bar gradient blue → white/grey.
- Tests: `tests/smooth-experience.spec.js` search-highlight assertion updated to `bg-white/10`.

**Verification:** build passes, vitest 10/10, Playwright 15/15; computed styles checked in-browser (header `rgb(33,33,33)`, add button white bg / black text, body `#000000` / `#ececec`). Note: `npx eslint src/` currently fails in this VM with "couldn't find an eslint.config.*" (ESLint v10, no config file in the repo) — pre-existing, unrelated to this change.

**Pushed to main as commit `b88c0ab470e1f756cbc87de82c69d1c19336779f`** ("style: ChatGPT black theme — deep black/white contrast, pill buttons, bundled icon font"), verified on GitHub. New Windows exe built (109,901,553 bytes, asar contains the bundled font) and uploaded to Drive, replacing the file at the same link.

---

## v4 — Index × Year datasets (2026-11-17, implemented and pushed)

**User request:** the journal now holds one index per year, backed up separately. Add the option to select index and year (placed between the search bar and the zoom button) so that combination's data loads; add more index/year combinations the same way. The current database belongs to Nifty 50 / 2026.

**Implementation:**
- `src/data/storage.js`: every journal entry (images, thumbs, mediums, metadata, notes, tags, remarks, week labels, trade dates, extra weeks) is namespaced per dataset — `sb_ds_<index-slug>_<year>__<key>`. Registry in `sb_datasets`, selection in `sb_current_dataset` (global keys).
- First run migrates the existing flat database into Nifty 50 / 2026 (`nifty-50_2026`) automatically — no data loss, no re-upload.
- New API: `createDataset(index, year)` (returns the existing one instead of duplicating), `switchDataset(id)` (persists + reloads the cache for that dataset only), `datasetIdFor` / `datasetLabel` / `getDatasets` / `getCurrentDataset`.
- Backups are ONE clean whole-database file (corrected 2026-11-17): `exportDatabase` exports every dataset — all indexes and years — plus the registry and the current selection, sorted by key so the file is deterministic and grouped by dataset. `importDatabase` restores the whole database from that one file, replacing everything. Older shapes still import cleanly: v4 single-dataset backups (with an `['sb_dataset', {id, index, year}]` marker) restore into that dataset only, and pre-dataset flat backups migrate into Nifty 50 / 2026. Lossless throughout: images are stored as data-URLs and converted back to Blobs byte-for-byte, never re-encoded — verified by an end-to-end export → import → export round-trip test in real Chromium where the 2560×1440 chart comes back byte-identical. `formatDatabase` still wipes only the current dataset. Export filename is back to `snowball-backup-<date>.json`.
- `src/pages/WeeklyJournal.jsx`: Index and Year pill dropdowns + a small `+` button sit between the search bar and the zoom control. Changing the index jumps to that index's latest year; changing the year loads that year's journal. The `+` opens an "Add index / year" modal (index text input with existing indexes as suggestions, year number input); adding an existing combination just switches to it. New combinations start empty — weeks are added with the `+` button as before.
- Settings copy updated to say export/import/format are scoped to the current dataset.

- Dropdowns verified to list newly added entries: after adding Bank Nifty / 2026 the index list contains it, and after adding Nifty 50 / 2025 the year list contains 2025 (Playwright assertions in tests/datasets.spec.js).
- Switching is fast: it reloads only the target dataset's metadata + thumbnails (full images stay lazy), and initStorage now revokes the previous dataset's thumbnail blob URLs instead of leaking them on every switch. Guarded by a Playwright timing test (6 weeks, both switch directions < 5s).
- Also fixed while testing: two rapid "add week" clicks could share a `Date.now()` id, so week ids now carry a random suffix.

**Verification:** build passes, oxlint 0 errors, vitest 20/20 (10 new dataset tests: default, migration, isolation, dedupe, validation, whole-DB export, whole-DB import, image import, legacy import, format scoping), Playwright 21/21 (5 specs in tests/datasets.spec.js + 1 lossless backup round-trip in tests/backup-roundtrip.spec.js). Screenshot: ~/workspace/your_files/snowball-datasets-header.png.

**Pushed to main 2026-11-17 as commit 931e523b4a7e6975a3202a34d38df71b97e0b0aa, verified on GitHub. New Windows exe (109,905,049 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.**

---

## v4.1 — Rows disappear when scrolling at 110–120% zoom (2026-11-17, implemented and pushed)

**User report:** at 100% zoom scrolling is stable; from 110% it starts breaking, and at 120% the upper rows of the viewport disappear / don't load when scrolling from the middle to the last rows.

**Root cause (measured, not guessed):** the grid used CSS `zoom` on the div containing the Virtuoso list. Virtuoso measures row heights with `getBoundingClientRect()` (visual px: a 117px row reads 141px at 120%) but reads the scroll position/size from the scroll parent in layout px — and its size cache is per index. The 20% mismatch accumulated down the list, so Virtuoso rendered the wrong window (rows the viewport should show were never rendered), and the list's total height kept growing as you scrolled (measured 4514 → 4600 → 4974px for the same 30 rows). Two dead ends were measured and discarded first: moving `zoom` onto the scroll container (its `clientHeight` is reported in zoomed-down units, so the visible window shrank and the drift persisted).

**Fix (`src/pages/WeeklyJournal.jsx` only):**
- Zoom is now real layout scaling, not CSS `zoom`: the grid carries a `--tz` variable and every size is `calc(Npx * var(--tz))` — column widths (`96px / 225px / 260px`), grid `min-width` (1481px), header/week-label/remarks/day-cell paddings, and every text/icon size in the grid (9/8/13/14/20px). With layout scaling, measured == scrolled at every zoom, and WeekRow props (and their memo) still never change on zoom — no re-renders.
- Virtuoso remounts on zoom change (`key={tableZoom}`): its per-index size cache holds heights measured at the old zoom, which made the cached total short and the window wrong until every row had been re-measured. A fresh instance measures everything at the new zoom. Only the first mount takes `initialTopMostItemIndex`.
- Scroll position survives the remount: the pre-zoom `scrollTop` is captured in `zoomIn`/`zoomOut` (the remount briefly empties the container and the browser clamps `scrollTop` to 0, which also overwrites the tracked position), then restored scaled by the zoom ratio in a `useLayoutEffect` with a retry loop (the fresh instance needs a few frames before its total height can hold the target).

**Verification:** build passes, oxlint 0 errors, vitest 20/20, Playwright 30/30 (9 specs in tests/zoom-scroll.spec.js: zoom-in at 110%, 120% and 150% plus zoom-out at 90%, 70% and 50% — bottom/middle/top rows all render and the total height stays stable within 50px in both directions — plus zooming mid-list keeps the same rows in view instead of jumping to the top, and zoom-out stops at 50% with the button disabled). Screenshots at 120% confirm rows render fully with scaled text.

**Pushed to main 2026-11-17 as commit d28815a3f0c27fe80d045d65a91252820f8dbc59, verified on GitHub. New Windows exe (109,905,097 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.**

---

## v4.2 — Back from a cell reloads the journal from the top (2026-11-17, implemented and pushed)

**User report:** scroll down, open a cell to check/update its notes, click back — the journal reloads from the start instead of returning to where you left off.

**Root cause (measured):** the position WAS saved correctly — `goToDetail()` wrote `sb_scroll_top=1780` before navigating — but ~100ms after arriving on the detail page it was overwritten with 0. The writer was the journal's own "persist scroll position on unmount" cleanup: it is a passive-effect cleanup, so it runs after the scroll container has been detached from the document, and a detached scroll container reports `scrollTop`/`scrollLeft` as 0. The cleanup clobbered the good value, so the return trip restored to 0.

**Fix (`src/pages/WeeklyJournal.jsx` only):**
- The unmount cleanup now writes only while the container is still in the document (`el?.isConnected`). The detail flow doesn't need it anyway — `goToDetail()` already saved the position, and the scroll handler persists continuously.
- Same guard in `handleScroll`'s rAF-throttled writer: if the container was detached since the scroll event, the pending write is skipped instead of clobbering the saved position with 0.

**Verification:** build passes, oxlint 0 errors, vitest 20/20, Playwright 32/32 (2 new specs in tests/back-navigation.spec.js: return from a mid-list cell restores the exact scroll position with the cell visible, and return from a bottom cell restores the bottom). The probe confirmed `sb_scroll_top` stays 1780 on the detail page and the journal returns to 1780 immediately and stably.

**Pushed to main 2026-11-17 as commit 996520a72bc9af010d362f5ccb265b909655e64b, verified on GitHub. New Windows exe (109,904,095 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.**


---

## v4.3 — Search: wrong cells shown, case handling, invisible highlight (2026-11-17)

**Report:** searching "gapup" returned cells with no notes on them, cells with "gapdown" on them, and only one gapup. Search also had to be case-insensitive, and matching cells needed an easily identifiable coloured outline.

**Root causes (measured with Playwright probes, real Chromium):**
1. The day-note/tag match itself was correct and already case-insensitive — "gapup" / "GAPUP" / "GapUp" all returned exactly the two gapup weeks and excluded the GAPDOWN week. The confusion came from the other two causes.
2. **Row-level filtering, cell-level highlighting:** a week is shown if ANY of its days matches — or if its *remarks* or *week label* match. But the highlight index (`searchHits`) only covered day notes/tags. So a remarks match showed a whole week with **zero** highlighted cells, and the user saw empty and gapdown cells with nothing explaining why the row was there.
3. **Highlight was nearly invisible:** a matching day cell only got `bg-white/10` — a faint white tint on a black cell, easy to miss.
4. Minor: the row filter lowercased the query but did not trim it, so a trailing space (paste/autocomplete) matched nothing, while the highlight index did trim — the two disagreed.

**Fix (`src/pages/WeeklyJournal.jsx` only):**
- One search index with prefixed keys — `day:<weekId>|<day>` (notes/tags), `rem:<weekId>` (remarks), `lbl:<weekId>` (week label) — so every match source the row filter uses is also highlighted.
- Matching cells now get a clear amber outline: `ring-2 ring-inset ring-amber-400` + `bg-amber-400/10` — on day cells (both image and empty variants), the remarks cell, and the week-label cell. Every shown row now has at least one outlined cell explaining why it matched; empty and gapdown cells stay un-outlined.
- Query is `search.trim().toLowerCase()` in both the row filter and the index; all haystacks lowercased — search is fully case-insensitive ("gapup" == "GapUp" == "GAPUP") across notes, tags, remarks and labels.
- Week-label cell gained `data-testid="week-label-<id>"` for the new specs.

**Verification:** build passes, oxlint 0 errors (18 pre-existing warnings), vitest 20/20, **Playwright 37/37** — 5 new specs in `tests/search.spec.js` (notes case-insensitivity incl. gapdown exclusion, tag match, remarks match, label match, trailing-space + empty-cell exclusion). One pre-existing spec (`smooth-experience.spec.js` "search highlight still works…") asserted the old `bg-white/10` class and was updated to the new `ring-amber-400` class.

**Pushed to main 2026-11-17 as commit 828cc94e1aa17913722613d60e1b2b2808be356e, verified on GitHub. New Windows exe (109,906,377 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.**


---

## v4.4 — Matte black header buttons, bold white text (2026-11-18)

**Request:** make the buttons' contrast deep — matte deep black, as black as possible against the grey header, with bold white text — demo first, and do not change any functionality.

**Change (`src/pages/WeeklyJournal.jsx` only, look-only):** the top-bar buttons are now pure black (`#000000`) with bold white text/icons — Nifty 50 and 2026 dataset pills, the + add-dataset button, the zoom cluster (− 100% +), the round + add-week button (was a white circle with a black +), and the settings gear (now a black circle with a white gear). The search field, the calendar button, the grid, all sizes, positions, handlers, state and testids are untouched.

**Verification:** demo mockup shown and approved first; then applied and checked with a real screenshot of the running app (black pills, both zoom symbols clearly bold white, gear on black). Build passes, oxlint 0 errors (18 pre-existing warnings), vitest 20/20, **Playwright 37/37** — the suite clicks these exact buttons (zoom, dataset switch, add-week, settings), so functionality is proven unchanged. Real screenshot: `~/workspace/your_files/snowball-black-buttons-applied.png`.

**Pushed to main 2026-11-18 as commit 8ba49a2c1949110320502df2caa3651271a4ec8c, verified on GitHub. New Windows exe (109,904,474 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.**

---

## v4.5 — Chart annotation toolkit in the fullscreen chart (2026-11-19)

**Request:** detail-page chart annotation, demo first, then applied to the app. Toolkit: TradingView-style horizontal line; 2 green vertical arrows (up and down) to mark entry; 2 red vertical arrows (up and down) to mark exit; 1 yellow marker arrow to mark a spot; a comment box that appears wherever clicked in the fullscreen chart, cursor inside ready to type, font always bold. The sidebar must be symbols only (no ENTRY/EXIT or other text) and must float on top of the page that zooms in the chart (the lightbox). Demo redone once to match this exact spec, then approved.

**Implementation (`src/pages/TradeDetail.jsx` lightbox + `src/data/storage.js`):**
- Floating icon-only toolbar, top-left of the lightbox, `z-[70]`, above the zoomed chart: select, horizontal line, green up, green down, red up, red down, yellow down, comment, delete-selected, clear-all (two-tap arm). Active tool inverts to white. No text anywhere on the bar — arrows are thick filled SVGs, the rest are Material Symbols.
- Marks are `{ id, type, x, y, text? }` with x/y in % of the displayed picture. The overlay is an absolutely positioned layer sized to the displayed picture rect (object-contain fit × zoom, centred, then panned — same math as `clampLbPan`), recomputed on zoom/pan/resize/image-load, so marks stay glued to the chart under pan/zoom. Arrows anchor by their tip; lines span the full picture width; comments are 180px bold-text boxes.
- Interactions: click a tool, click the chart to place (arrow/line tools stay armed for multiple marks; comment disarms and focuses its box). Drag a mark in select mode (lines move vertically only). Click a mark to select it; Delete/Backspace or the toolbar delete removes it; Escape disarms/deselects before closing, and blurs a comment box first. Clicking empty chart in select mode still closes the lightbox, exactly as before.
- Storage: `getAnnotations`/`setAnnotations` in `storage.js`, one JSON array per week+day (`ann_<weekId>_<day>`, same memCache + IndexedDB pattern as tags). The key carries the `sb_ds_` dataset prefix, so the whole-database backup export/import includes annotations automatically; `deleteWeekData` removes them with the week. The original image is never touched — marks are an overlay only.
- Two real bugs found and fixed while testing, both in the placement click path: (1) a click that places a mark fires on the nearest common ancestor of the mousedown/mouseup targets — the overlay, not the new mark — so the click right after placing a comment (which disarms to select) looked like an empty select-mode click and closed the lightbox. Fixed with a 300ms placement guard in the overlay close handler. (2) The mousedown default action blurred the comment box React had just focused during the same pointerdown. Fixed with `preventDefault()` on the overlay pointerdown while a draw tool is armed.

**Verification:** build passes, oxlint 0 errors, vitest 20/20, **Playwright 44/44** — 7 new specs in `tests/annotations.spec.js` (icon-only toolbar + tool arming, placing all 5 arrows + the line at measured %, comment autofocus + bold + text, persistence across leaving/reopening the cell, Delete-key removal, drag moves a mark, marks stay glued to the chart at 1.25× zoom). Real screenshot of the running app's lightbox with all 7 marks placed: `~/workspace/your_files/snowball-annotations-applied.png`.

**Pushed to main 2026-11-19 as commit 8689bb57ff15f88bea27c2d7918812d12e85bb9f, verified on GitHub. New Windows exe (109,906,327 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.**

### v4.5.1 — Annotation toolbar: top centre, then horizontal (2026-11-20)

**Request:** move the toolbar from top-left to the top-centre of the screen when the chart is fullscreen; then place the bar horizontally in the centre top. Change nothing else.

**Change (`src/pages/TradeDetail.jsx`, toolbar classes only):** the bar is now a horizontal row — `flex-row`, still `absolute top-4 left-1/2 -translate-x-1/2` — same icon-only pill, same tools in the same order, same behaviour; the two dividers went from horizontal rules to vertical rules. Verified centred (bar centre x = viewport centre, 640px at 1280px wide; bar 420 × 50px) and that arming still inverts the active button. The earlier vertical-centre step needed one test fix: the Delete spec clicked at 50%/50% of the chart, which was under the vertical bar, so it clicks at 30%/50% instead. Real screenshot: `~/workspace/your_files/snowball-annotations-horizontal.png`.

**Verification:** build passes, Playwright annotation specs 7/7. Pushed to main 2026-11-20 as commit 0038f34727c3d10a1add644660093aafaf16154e, verified on GitHub. New Windows exe (109,907,312 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.2 — Horizontal line is black (2026-11-20)

**Request:** make the horizontal line black; it was white.

**Change (`src/pages/TradeDetail.jsx`, one class):** the placed line is now `bg-black` (was `bg-white`). Selected-state amber highlight unchanged, so a selected line is still visibly selected. Verified by computed style: the line's background is `rgb(0, 0, 0)`. Note: on a dark chart background a black line is faint — on a light chart (white TradingView screenshot) it reads clearly. Real screenshot: `~/workspace/your_files/snowball-annotations-black-line.png` (line placed at mid-height; faint here because the test chart is dark).

**Verification:** build passes, Playwright annotation specs 7/7. Pushed to main 2026-11-20 as commit 638f99bdffe7afc0bc71f45c8e52f420f6fa1062, verified on GitHub. New Windows exe (109,908,756 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.3 — One-shot tools + comment box grows (2026-11-20)

**Requests:** (1) the comment box should expand automatically as the text fills it; (2) a tool picked from the toolbar should apply only to the first click on the chart, then deselect — the next click must not apply the old option; pick it again to apply again. Applies to the arrows and the line.

**Changes (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js`):**
- One-shot: `placeAnnotation` now ends with `setAnnTool('select')` for every tool (comment already did this), so arrows and the line apply once and the toolbar goes back to select. The 300ms `justPlacedRef` guard already stops the click that follows a placement from closing the lightbox.
- Comment grows: new `autoGrowComment` helper — the textarea's height is set to its `scrollHeight` (up to 200px, then it scrolls internally), run on every render via the ref callback (covers text loaded from storage) and on every keystroke. Shrinks back when text is deleted.
- Tests: 2 new specs — one-shot for arrow + line (second click places nothing, re-arming works) and comment growth (6 lines: height grows, whole text visible, no internal scroll). The Delete, drag and zoom specs lost their "click the tool again to disarm" step — placing already disarms. Real screenshot: `~/workspace/your_files/snowball-annotations-comment-grows.png` (5-line comment, box grown, all text visible).

**Verification:** build passes, Playwright annotation specs 9/9. Pushed to main 2026-11-20 as commit 6261d31ab456a049109d93bc7ec85a19732fd624, verified on GitHub. New Windows exe (109,906,992 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.4 — Empty click does nothing after a mark; right-click delete (2026-11-20)

**Requests:** (1) clicking empty chart should do nothing after a marker has been applied; (2) right-clicking a marker, line or comment box selects it and shows a close button at its top-right corner that deletes it.

**Changes (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js`):**
- Empty click: the overlay close handler now closes the lightbox only while no mark is on the chart (`annotations.length === 0`). Once a mark exists, an empty click does nothing — close with the × button or Escape. Clicking the dark backdrop around the chart still closes, as before.
- Right-click delete: new `annMenuId` state; right-clicking any mark (`onContextMenu`, browser menu suppressed) selects it and shows a small black × with a white ring at its top-right corner — on the arrow's corner, above the line's right end, on the comment box's corner. Clicking the × deletes that mark (`deleteAnn`). A plain left-click select shows no ×. The × hides when you left-click a mark to drag, pick a toolbar tool, press Escape, click empty chart, or clear all. Right-button pointerdowns no longer start a drag or place a mark (`e.button !== 0` guards in `onAnnPointerDown` and the overlay placement handler).
- Tests: 2 new specs — empty-click behaviour (closes with no marks, does nothing with a mark, Escape still closes) and right-click delete for arrow, line and comment (left-click shows no ×, right-click shows it, × deletes). The persistence spec now closes the lightbox with Escape ×3 (blur, deselect, close) instead of an empty click. Real screenshot: `~/workspace/your_files/snowball-annotations-right-click-delete.png` (green arrow selected, × at its top-right corner).

**Verification:** build passes, Playwright annotation specs 11/11. Pushed to main 2026-11-20 as commit 6261d31ab456a049109d93bc7ec85a19732fd624, verified on GitHub. New Windows exe (109,906,992 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.5 — Marks and comments show on the inline chart (2026-11-20)

**Request:** the markers and comments added in the fullscreen chart should also be visible when the fullscreen view is closed, on the chart at the top of the notes page.

**Changes (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js`):**
- Read-only overlay over the inline chart (`data-testid="inline-ann-overlay"`, marks `inline-ann-mark`): the same arrows, black line and comment boxes, positioned by the same % coords. The inline image is object-cover in a fixed-aspect box, so the overlay is sized to the displayed picture rect with cover math (`computeInlinePicRect`, recomputed on image load, resize via ResizeObserver, and image-tier swaps) — marks sit exactly where they were placed. `pointer-events-none`, so double-click still opens the fullscreen chart and the chart delete button still works. Empty comments are skipped inline (no empty box). To move, edit or delete a mark, open the fullscreen chart as before.
- Test: new spec places an arrow, a line and a comment in the lightbox, closes it, and checks all three show on the inline chart at the right positions (arrow ≈30% across / 40% down, line ≈60% down). Real screenshot: `~/workspace/your_files/snowball-inline-marks-bold-notes.png`.

**Verification:** build passes, Playwright annotation specs 12/12. Pushed to main 2026-11-20 as commit beae2fca1722aa6bf7f28980c9a436d259494c7a ("feat: inline chart marks, bold notes, notes image resize/delete (v4.5.5-4.5.7)"), verified on GitHub. New Windows exe (109,909,498 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.6 — Notes are bold by default (2026-11-20)

**Request:** the text in the notes section should be bold by default — no need to select it and press Ctrl+B.

**Changes (`src/index.css`, `src/pages/TradeDetail.jsx`, `tests/trade-detail.spec.js`):**
- `.ql-editor { font-weight: 700; }` — every character in the notes editor renders bold: text typed from now on, older notes, and pasted text. One CSS rule, no Quill API changes, so the editor's behaviour (autosave, Ctrl+B toggling the stored format) is untouched. The placeholder's "Use Ctrl+B for bold" hint is removed.
- Test: new spec types into the notes editor and asserts the editor and the typed paragraph both compute to font-weight 700. Real screenshot: `~/workspace/your_files/snowball-inline-marks-bold-notes.png` (notes line in bold under the chart).

**Verification:** build passes, Playwright trade-detail specs 4/4 (annotation specs 12/12). Pushed to main 2026-11-20 as commit beae2fca1722aa6bf7f28980c9a436d259494c7a ("feat: inline chart marks, bold notes, notes image resize/delete (v4.5.5-4.5.7)"), verified on GitHub. New Windows exe (109,909,498 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.7 — Notes pictures: right-click select, dotted outline, resize, delete (2026-11-20)

**Request:** adjust the length and width of pictures added in the notes section — right-click a picture to select it, with a close button at the top-right and dotted perimeter lines to resize it.

**What I found while measuring:** a resize handler already existed in `TradeDetail.jsx` (click an image → solid outline + 8 handles), but it never actually worked — the overlay was appended *inside* Quill's editor root, and Quill's own DOM reconciliation removes foreign nodes from the root, so the outline vanished a moment after appearing. A probe (real click + MutationObserver) showed the overlay added, then removed by Quill's update cycle. The drag had the same fate, and a size set directly on the image was never saved (Quill only saves what is in its Delta).

**Changes (`src/pages/TradeDetail.jsx` + `tests/notes-images.spec.js`):**
- The overlay now lives on the editor's *container* (`.ql-container`), outside Quill's blot tree, so it stays visible. It is re-positioned on scroll/resize so it tracks the picture.
- Right-click a picture (left-click still works) selects it: **dotted** white perimeter, 8 handles (corners + edge midpoints), a live size label, and a black **×** button with a white ring at the top-right corner that deletes the picture (via Quill's API, so the deletion is autosaved like any edit).
- Dragging a handle resizes the picture and **keeps its proportions** — a stretched picture would not survive a reload (the stylesheet renders pictures at their natural aspect ratio for a given width), so locking the ratio makes the drag and the saved size agree exactly. The new size is applied through Quill's image width/height formats on mouseup, so it is saved with the notes and still there after leaving and coming back. The overlay also stays up after a drag (the click that follows a drag is no longer read as "clicked outside").
- Also fixed in passing: the size label had light-grey text on a light-grey background (unreadable); it is now white on black.

**Verification:** build passes, vitest 20/20, full Playwright suite 53/53 (3 new specs in `tests/notes-images.spec.js`: right-click select + delete persists, corner-drag resize persists, left-click still shows the overlay). Real screenshot: `~/workspace/your_files/snowball-notes-img-resize.png` (dotted outline, handles, × at the top-right corner). Pushed to main 2026-11-20 as commit beae2fca1722aa6bf7f28980c9a436d259494c7a ("feat: inline chart marks, bold notes, notes image resize/delete (v4.5.5-4.5.7)"), verified on GitHub. New Windows exe (109,909,498 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.8 — Bold week labels + matte black column headings (2026-11-20)

**Request:** on the front page, the text typed in the week-column cells should be bold automatically, and the column headings should take the matte black background + bold white text contrast of the header buttons. Sample image first, then apply.

**Changes (`src/pages/WeeklyJournal.jsx` + `tests/weekly-journal.spec.js`):**
- The two editable week-label inputs (month + dates) are now `font-bold` — typed text is bold without selecting anything. The dates line keeps its dimmed `opacity-70`, so it stays lighter than the month line, as in the approved mockup.
- The headings row (Week, Monday–Friday, Remarks) is now pure black `#000000` (was `#2f2f2f`) with bold white text (was grey); the small calendar icons beside the day names stay, now white. Nothing else about the row changed — same height, padding, cell widths, uppercase tracking.
- Mockup shown and approved first (generated from a real screenshot, `~/workspace/your_files/media-generation-snowball-front-page-bold-heade-0-8560aaf2-6745-4e94-b36d-b4d2e251816a.png`); real screenshot after applying: `~/workspace/your_files/snowball-bold-headers-applied.png`.
- Test: new spec asserts the headings row computes to background `rgb(0, 0, 0)`, font-weight 700, colour white, and both week-label inputs compute to font-weight 700.

**Verification:** build passes, Playwright weekly-journal specs 6/6. Pushed to main 2026-11-20 as commit caa2019abd43761e5735d1ec9a0f3856eeaf09a0 ("feat: bold week labels, black column headings, black search bar (v4.5.8-4.5.9)"), verified on GitHub. New Windows exe (109,907,749 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.9 — Search bar in the button style (2026-11-20)

**Request:** the search bar should also look like the header buttons, with a screenshot of the changed interface.

**Changes (`src/pages/WeeklyJournal.jsx` + `tests/weekly-journal.spec.js`):**
- The search input is now pure black `#000000` (was `#2f2f2f`) with a black border, bold white typed text (was regular grey), a white magnifier icon and a white clear-× button. The placeholder ("Search remarks, notes, dates…") stays dimmed white at 50% so it still reads as a hint. Same pill shape, size, position and focus ring — look only, search behaviour untouched.
- Real screenshot of the app running with the change: `~/workspace/your_files/snowball-black-search-bar.png` (query "1" typed to show the bold white text; the amber outlines on the week labels are the existing search-match highlight for that query).
- Test: new spec asserts the input computes to background `rgb(0, 0, 0)`, font-weight 700, colour white.

**Verification:** build passes, Playwright weekly-journal specs 7/7. Pushed to main 2026-11-20 as commit caa2019abd43761e5735d1ec9a0f3856eeaf09a0 ("feat: bold week labels, black column headings, black search bar (v4.5.8-4.5.9)"), verified on GitHub. New Windows exe (109,907,749 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.10 — Remarks cell shows the first 5 lines in bold white (2026-11-20)

**Request:** text typed in the remarks editor should be visible in the front-page remarks cell — it wasn't appearing. Show the first lines from the remarks in the front-page cell, in bold white text. (First asked as 3 lines, then changed to 5.)

**What I found while measuring:** the text *was* being saved (it appeared after a full reload), but the front-page cell never updated while the app was running. The remarks modal writes straight to storage, and the week row is memoised — no prop of the row changes when the modal closes, so React kept showing the old empty cell. A second flaw: the cell rendered `getRemarksText`, which strips all markup and collapses every line into one flowing paragraph, so even after a reload the line breaks were lost.

**Changes (`src/data/storage.js`, `src/pages/WeeklyJournal.jsx`, `tests/weekly-journal.spec.js`):**
- New `getRemarksPreview(weekId, fallback, maxLines = 5)` in storage.js: splits the stored HTML on block ends/`<br>`, strips tags, drops blank lines, returns the first 5 lines joined with newlines. The search index still uses the full flattened `getRemarksText`, unchanged.
- The remarks cell now renders that preview with `line-clamp-5` (was 4) + `whitespace-pre-line`, in the bold white it already had (`font-bold`, `text-primary` = white). Empty remarks still show the dimmed "Click to add remarks…" hint.
- The parent bumps a `remarksVersion` counter when the remarks modal closes and passes it to the row; the row recomputes its preview from it, so the cell updates the moment the modal closes — no reload needed.
- Test: new spec types 7 lines in the modal, closes it, and asserts the cell shows lines 1–5 only (not 6–7), in font-weight 700 and white. Real screenshot: `~/workspace/your_files/snowball-remarks-5-lines.png`.

**Verification:** build passes, oxlint 0 errors, Playwright weekly-journal specs 8/8. Pushed to main 2026-11-20 as commit 83e5deb8e4e9987347d2e9bed6570b6c4834ed63 ("feat: remarks cell shows first 5 lines in bold white (v4.5.10)"), verified on GitHub. New Windows exe (109,906,809 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.11 — Slimmer column-heading row, 45px → 37px (2026-11-20)

**Request:** reduce the vertical height of the heading row (Week, Monday–Friday, Remarks) a little bit; change nothing else. Sample look first.

**What happened:** my first sample misread the ask and narrowed the *columns* instead of the row height — the user corrected me. A generated mockup of the shorter row then came back looking almost unchanged, so per the mockup skill I applied the real change to a running copy and showed a real screenshot instead.

**Change (`src/pages/WeeklyJournal.jsx` + `tests/weekly-journal.spec.js`):** the three heading-row cells' padding went from `p-[calc(12px*var(--tz))]` to `p-[calc(8px*var(--tz))]` — the row is 37px tall at 100% zoom (was 45px). Same text size, same icons, same column widths, same rows below. Test: new spec asserts the header grid measures 37px tall at 100% zoom. Real screenshot: `~/workspace/your_files/snowball-heading-row-sample.png`.

**Verification:** build passes, oxlint 0 errors, Playwright weekly-journal specs 9/9. Pushed to main 2026-11-20 as commit 98395387c3eaa0f25ee11284ade5bcc577f6e616 ("style: slimmer column-heading row, 45px to 37px (v4.5.11)"), verified on GitHub. New Windows exe (109,907,477 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.12 — No title text in the window title bar (2026-11-20)

**Request:** remove the "Snowball Trading Journal" text from the top left of the app window; change nothing else. Sample first.

**What I found:** the text is the Electron window title — the page `<title>` is "Snowball — Trading Journal" (productName "Snowball Trading Journal" in package.json). The "Snowball" logo inside the app header is separate and stays.

**Change (`main.cjs` only):** after creating the window, `mainWindow.setTitle('')` plus a `page-title-updated` handler that calls `preventDefault()`, so the page title can't overwrite the empty title on load. The title bar itself and its min/max/close buttons are untouched. Side effect, flagged to the user: the taskbar button and Alt-Tab show just the app icon, no name. Real screenshot of the app running with the change is not possible in this environment (no window manager to render a title bar), so the sample was a generated mockup: `~/workspace/your_files/media-generation-snowball-no-title-text-mockup-0-6990f8e6-969c-485e-b0ab-526e79724adb.webp`.

**Also in this release — slimmer app header, 64px → 48px:** the header-height change from the "reduce the space between the search bar row and the close button row" request (WeeklyJournal.jsx `h-16` → `h-12`), approved together with the title change. Test: new spec asserts the header measures 48px tall at 100% zoom. Samples: real screenshot `~/workspace/your_files/snowball-shorter-header.png` + mockup with title bar `~/workspace/your_files/media-generation-snowball-header-close-button-g-0-bccf2f7b-a494-4043-83e4-33fa9b5da919.webp`.

**Verification:** `node --check main.cjs` OK, build passes, oxlint 0 errors, weekly-journal specs 10/10, and the real Electron app launched under Xvfb and stayed alive 14s with the new code (only harmless dbus noise in the log). The empty title itself follows from the two documented Electron calls. Pushed to main 2026-11-20 as commit 8ced90d3b4a8e11814bea4bc81cabaf1dc6efe9a ("style: slimmer app header 64px to 48px; empty window title (v4.5.12)"), verified on GitHub. New Windows exe (109,906,385 bytes, asar verified with 69 /dist/ files incl. index.html; packaged main.cjs confirmed to contain setTitle('') + page-title-updated handler, built JS confirmed to contain h-12) uploaded to Drive at the same link. Note: the first exe-build attempt in this round died with the workspace hiccup before producing output; the rebuild ran cleanly as a background exec.

### v4.5.13 — Settings page repair: top-right panel, app theme, wipe vs delete index (2026-11-21)

**Request:** repair the settings page — adopt the app's font and colour contrast; open it in the right corner above the first page instead of a full page over the charts; under Format offer two options (wipe the current index–year combination, or delete the index itself with all its data), each followed by a confirmation window warning of data loss. Sample look first.

**What I found:** the settings modal was a centred full-screen overlay (`fixed inset-0 bg-black/80 backdrop-blur-sm`, `max-w-md layer-surface` panel) using the old Material-style theme tokens (`text-on-surface`, `bg-surface-container-high`, `bg-error`) — not the app's matte-black theme — and Format had a single "Wipe Dataset" button behind a native `window.confirm`. No delete-index function existed in storage.

**Samples:** generated mockups, redone three times at the user's direction — deep red #dc2626 instead of the pale rose (too much white mixed in), then the panel moved right to sit above the Remarks column instead of the Friday column. Final mockups: `~/workspace/your_files/media-generation-snowball-settings-panel-remark-0-a3da2c4e-862a-41bc-bdbb-464f22f989d3.webp` and `~/workspace/your_files/media-generation-snowball-settings-confirm-rema-0-69243c15-d218-4280-bd0d-39dd17acd16e.webp`. The first panel mockup kept drawing the second format button outside the panel's border — flagged to the user; the real panel holds both buttons inside.

**Change (`src/data/storage.js`, `src/pages/WeeklyJournal.jsx`, `tests/settings.spec.js`, `src/data/storage.test.js`):**
- New `deleteIndex(index)` in storage.js: removes every dataset with that index (all years), deletes all their `sb_ds_<id>__` keys, drops them from the registry. If the current dataset was among them, the journal lands on another remaining dataset; if none remains, a fresh empty default dataset (Nifty 50 / 2026) is created so the app always has a journal to open.
- SettingsModal is now a floating panel: transparent `fixed inset-0` wrapper (click outside closes), panel `absolute top-[60px] right-4 w-[380px] max-h-[calc(100vh-76px)] overflow-y-auto`, pure black with `#424242` border — just under the 48px header, above the Remarks column, journal visible behind it. Theme matches the app: bold white headings, black buttons with grey borders and bold white text, deep red `#dc2626` for warnings and the confirm button.
- Format has two options — "Wipe Nifty 50 · 2026" (this Index × Year only) and "Delete Nifty 50 — all years" — each opening an in-panel confirmation step with the data-loss warning, Cancel and a deep-red confirm button. Escape backs out of the confirmation, then closes the panel. The native `window.confirm` is gone; wipe still uses `formatDatabase()` and both actions reload the app after running.
- Tests: 3 new vitest specs for `deleteIndex` (all years removed, others kept; fresh default when it was the only index; unknown index rejected) and 7 new Playwright specs in `tests/settings.spec.js` (position/theme, both options, confirmation + Cancel, Escape flow, wipe keeps other datasets, delete removes the whole index and lands on a remaining dataset, delete-only-index recreates the default). Test lessons: a fresh journal renders no week rows, so "journal visible behind" is asserted via the search input and dataset selector; a one-shot `allTextContents()` after the confirm-triggered reload races the navigation — use auto-retrying assertions instead. Real screenshots: `~/workspace/your_files/snowball-settings-applied.png` and `~/workspace/your_files/snowball-settings-confirm-applied.png`.

**Verification:** build passes, oxlint 0 errors, vitest 23/23, full Playwright suite 65/65. Pushed to main 2026-11-21 as commit 19ef8f4e7186b9092f38a056cf5b758587becd1c ("feat: settings panel top-right in app theme; format wipe vs delete index with confirmation (v4.5.13)"), verified on GitHub. New Windows exe (109,909,790 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.14 — Compact settings panel (2026-11-21)

**Request:** remove the extra spaces in the settings panel, make it small and aesthetically appealing. Sample first.

**What happened:** the first generated mockup of the compact panel shortened the text but kept the same tall spacing between sections, so the panel came out no smaller — flagged to the user. At his choice ("Tighten the real panel and show a real screenshot"), the real panel was tightened and screenshotted instead.

**Change (`src/pages/WeeklyJournal.jsx` + `tests/settings.spec.js` only):** panel padding `p-5` → `p-4`, gaps `gap-4` → `gap-3`, section padding `py-2` → `py-1`, heading 18px → 16px with a smaller 28px close button, format buttons `py-2` → `py-1.5` with `mt-2`/`gap-1.5`. Descriptions shortened: Export is now one line ("Your whole journal — every index and every year — in one file, images at full quality."), Import warning is one line ("Warning: Importing replaces your entire local database.") plus "Do not close the app until it completes." Same position (top-[60px] right-4, above the Remarks column), same theme, same options and confirmation flow. Measured: panel is 515px tall at a 720px viewport (was ~590px), ending well above the bottom of the table. Test: the position spec now also asserts panel height ≤ 540px. Real screenshots: `~/workspace/your_files/snowball-settings-compact.png` and `~/workspace/your_files/snowball-settings-confirm-compact.png`.

**Verification:** build passes, oxlint 0 errors, vitest 23/23, full Playwright suite 65/65. Pushed to main 2026-11-21 as commit d31f406e968bb0ee71a2874ac63ffbc1f68933d8 ("style: compact settings panel — tighter spacing, shorter descriptions (v4.5.14)"), verified on GitHub. New Windows exe (109,908,225 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.15 — Black bold pencil marker in the chart annotation toolbar (2026-11-21)

**Request:** add a black bold pencil marker to the chart marker tool panel; it should work as a pencil on the chart on click-and-drag after the tool is selected, and keep working until deselected by clicking the button again. Sample look first. Then: right-clicking a drawn line should select it and show a small close button at its top end; clicking it deletes the line from the chart.

**Samples:** the interactive demo (artifact 'Chart Annotation Demo') got the pencil first — a black pencil button next to the horizontal line, click-drag draws a bold black freehand stroke with a thin white edge so the black stays visible on dark charts, latched until tapped again. The demo was then extended with the right-click × at the stroke's top end. The user approved the demo ("Apply it to the app").

**Change (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js` only):**
- Toolbar: new `ann-tool-pencil` button right after the horizontal line — a black pencil icon with a thin white outline (`AnnPencil`, Material "edit" path), so it reads on the dark toolbar and stays black on the white active pill. Icons only, same as the rest.
- Pencil marks are `{ id, type: 'pencil', points }` with points as `[[x, y], ...]` in % of the displayed picture — same per-week+day storage key as the other marks, so strokes survive reload, travel with the whole-database backup, and need no storage.js change. `placeAnnotation` guards against the pencil (it draws via its own pointer handlers).
- Drawing: overlay pointerdown with the pencil armed starts a stroke (pointer capture on the overlay), pointermove extends it with a live preview (`pencilDraft`, points thinned to ≥0.15% apart), pointerup stores it. A tap with no drag stores a dot (the same point twice, round caps). Unlike the one-shot tools, the pencil stays armed stroke after stroke; tapping the pencil button again or Escape deselects it (`annToolBtn` already toggles; the Escape disarm covers it).
- Rendering (`PencilStroke`): SVG polyline over the picture — bold black core (4.5px) over a wider white edge (8px), `vector-effect="non-scaling-stroke"` so the width stays in px under pan/zoom. Selected stroke turns amber, like the line. A wide invisible hit stroke (18px) makes the thin line easy to grab, right-click and drag. Strokes also show read-only on the inline chart on the notes page, positioned by the same % coords.
- Delete: right-click a stroke selects it and shows the black × with white ring (`ann-mark-delete`) at the stroke's topmost point (`pencilTopPoint`); clicking the × deletes it. The × button takes an optional position style (the stroke's box is the whole overlay) and `pointer-events-auto` so it works inside the pointer-events-none wrapper. Dragging a stroke in select mode moves all its points; toolbar delete, Delete key and Clear all work as for other marks.
- Tests: 4 new specs in `tests/annotations.spec.js` (draw + latch + deselect, black core + several points, right-click × at the top end + delete, drag moves the stroke, strokes on the inline chart) and 'pencil' added to the toolbar spec's tool list. Annotation specs 16/16. Real screenshots: `~/workspace/your_files/snowball-pencil-applied.png` and `~/workspace/your_files/snowball-pencil-delete.png`.
- Test lesson: the first full-suite run after the change had 1 failure in the new inline-chart spec that passed in isolation and on the re-run (69/69) — a timing flake under full-suite load, not a code fault; the re-run is the result that counts.

**Verification:** build passes, oxlint 0 errors, vitest 23/23, full Playwright suite 69/69. Pushed to main 2026-11-21 as commit 84894564dcc5aae7bd6ec5a9a1c424443a1d8ddb ("feat: black bold pencil marker in chart annotations (v4.5.15)"), verified on GitHub. New Windows exe (109,906,354 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.16 — Comment box: double-click move, double-click cursor, dotted resize frame (2026-11-21)

**Request:** move the comment box by double-click and drag; in the right-click add an option to adjust the size of the box, with the closing button. Sample first. Then the correction: no preset sizes — side adjusting dotted lines so the size can be set in a custom fashion. Then: the demo had lost the ability to place the cursor by double-clicking — add it back.

**Samples:** the Chart Annotation Demo got the behaviour first in three rounds — (1) double-click-drag to move + a right-click size panel with Small/Medium/Large presets and steppers; (2) at the user's correction, the preset panel was replaced by dotted side lines with 8 handles for free-form resizing; (3) double-click to place the cursor was restored alongside the drag. The user approved the demo ("Apply it to the app").

**Change (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js` only):**
- Move: a double-click press on a comment box arms a move that only starts once the pointer has actually moved > 7px, so the click itself stays free to focus the text. The text area covers the whole box, so a plain drag could never grab it — this is now the way to move a comment. Single-click still types; dragging the box's header is unchanged.
- Real bug found while applying it: Chromium reports `pointerdown` detail as 0, so checking `e.detail === 2` on pointerdown never fires and the box never moves. The second press is detected from the `mousedown` event's detail instead (2 on the second press of a double-click) — the demo had the same bug and was fixed the same way. Test lesson: Playwright's manual `mouse.down()` sends clickCount 1, so the drag test uses `mouse.down({ clickCount: 2 })` for the second press.
- Cursor: a still double-click on a comment focuses its text area and puts the caret where the click landed, selecting the word there (`placeCursorInComment`, via `caretRangeFromPoint` with a `caretPositionFromPoint` fallback, word-boundary expansion). The box's own double-click handler stops propagation so the lightbox zoom toggle does not fire. The text area's `onPointerDown` stopPropagation was removed so the wrapper sees the presses.
- Resize: right-clicking a comment shows its delete (×) button at the top-right and a dotted amber resize frame (`ann-comment-resize-frame`, `-inset-2`) with 8 white square handles — sides + corners (`ann-resize-nw/n/ne/e/se/s/sw/w`). Dragging a handle resizes the box freely (min 140×84px, kept inside the chart); left/top handles move that edge while the opposite side stays put. The size is stored on the mark as `w`/`h` in px (position stays in %), so it survives reload, shows on the inline chart on the notes page (read-only, overflow hidden), and travels with the whole-database backup like the other marks — no storage.js change. A resized box keeps an explicit height (text area fills it and scrolls); an unresized box keeps the old auto-grow up to 200px. The frame closes on Escape (first Escape blurs the text area, second clears the selection), clicking empty chart, tool switch, Clear all, or deleting the comment.
- Tests: 4 new specs in `tests/annotations.spec.js` (double-click places the cursor and selects a word without moving the box; double-click-and-drag moves the box; right-click shows the frame + 8 handles, east/south drags resize it, size survives leaving and coming back; Escape closes the frame and the lightbox stays open). Annotation specs 20/20. Real screenshots: `~/workspace/your_files/snowball-comment-resize.png` and `~/workspace/your_files/snowball-comment-resized.png`.
- Test lesson: the first full-suite run after the change had 1 failure in the pre-existing arrow-drag spec that passed in isolation and on the re-run (73/73) — a timing flake under full-suite load, not a code fault; the re-run is the result that counts.

**Verification:** build passes, oxlint 0 errors, vitest 23/23, full Playwright suite 73/73. Pushed to main 2026-11-21 as commit ea342c37dfa4449e01a7c46e8c98c3a135aeda0a ("feat: comment box double-click move, double-click cursor, dotted resize frame (v4.5.16)"); the unauthenticated GitHub commits API was rate-limited at verify time, so the push-files returned sha is the authority. New Windows exe (109,911,261 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.17 — Comment box resize uses its own dotted border, no second box (2026-11-21)

**Request:** when a comment box is added, a single click should put the cursor inside it, double-click-and-drag moves the box, right-click resizes it — but the current resizing was not working properly: a second dotted box appeared around it. Remove the second dotted box, make the perimeter of the box itself become dotted on right-click to resize it, with a small close mark on the top right to remove the box itself. Real screenshot of the app when it is added.

**Change (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js` only):**
- The separate resize frame is gone. Right-clicking a comment now turns the box's own border into a 2px dotted amber line (the text area's border swaps from `border-white/40` to `border-2 border-dotted border-amber-400`), and the same 8 white square handles sit directly on the box's own edges and corners (`ann-comment-resize`, `ann-resize-nw/n/ne/e/se/s/sw/w`). The delete (×) button rides on the top dotted line near the right end (`right-3 top-0 -translate-y-1/2`) so it never covers a handle. Escape (first press blurs the text area, second clears the selection), clicking empty chart, tool switch and Clear all still dismiss the resize state.
- Real bug found while applying it: the dotted border came out blue, not amber, because Tailwind's preflight `textarea:focus` rule sets `border-color: #2563eb` and beats the plain `border-amber-400` class while the text area is focused — which is exactly when a user right-clicks it. Fixed with `focus:border-amber-400` on the resize branch (higher specificity), and the spec now asserts the computed border style is dotted and the colour is amber-400.
- Single click still puts the cursor inside the box (new spec asserts it after blurring first); double-click places the cursor and selects the word; double-click-and-drag still moves the box (v4.5.16, unchanged). Resize math, min size (140×84px), staying inside the chart, and per-box `w`/`h` storage are unchanged. Real screenshots: `~/workspace/your_files/snowball-comment-dotted.png` and `~/workspace/your_files/snowball-comment-dotted-wider.png`.

**Verification:** build passes, oxlint 0 errors, vitest 23/23, full Playwright suite 74/74 (annotation specs 21/21, 1 new). Pushed to main 2026-11-21 as commit b49193adafdae5d7abbe16a2a06f6b34fafd3448 ("feat: comment box resize uses its own dotted border, no second box (v4.5.17)"), verified on GitHub. New Windows exe (109,911,484 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

### v4.5.18 — Comment box vertical resize and typing growth (2026-11-22)

**Request:** the comment box expands horizontally to the left and right, but not vertically — a second white box expands vertically leaving the comment box's borders behind — and when typing, the box does not expand vertically downward to fit the text. Fix both, and give the fixed build.

**Measured cause (one root cause for both faults, confirmed with a temporary repro spec before fixing):** the auto-grow helper sets an *inline* `style.height` on the text area (e.g. `64px`), and an inline height beats the `h-full` class a resized box relies on. Dragging the south handle +60px grew the outer box from 70px to 130px while the text area stayed at 64px — the dotted border box expanding with the black text box left behind, which is the "second white box". And the resize handler stored *both* `w` and `h` on every drag, even a sideways one, so one horizontal resize froze the height permanently: after that, `updateAnnText` and the ref callback both skipped auto-grow (`if (!a.h)`), so typing 6 lines left `scrollHeight` at 160px inside a 64px text area that never grew.

**Change (`src/pages/TradeDetail.jsx` + `tests/annotations.spec.js` only):**
- Resize stores only the dimension being dragged: east/west drags store `w` (and `x` for west), north/south drags store `h` (and `y` for north), corners store both. A sideways drag no longer freezes the height, so the box keeps auto-growing as text is typed; the keep-inside clamps apply only to the sides being dragged.
- The text area's ref callback now clears the stale inline height (`el.style.height = ''`) whenever the box has a fixed `h`, so `h-full` actually fills the resized box — the vertical resize grows the text box itself, not a second box around it.
- Typing grows a fixed-height box: `updateAnnText(id, text, taEl)` measures the text's `scrollHeight` with the height freed, and if the text needs more than the stored `h`, the stored `h` grows to fit (capped by the room left on the chart); if it fits, the inline height is cleared so the box fills its fixed height. An unresized box keeps the old inline auto-grow up to 200px. The new size is stored on the mark like any resize, so it survives reload and travels with the backup.
- Tests: the existing resize spec now measures the south drag from rendered heights (an east drag no longer sets `style.height`, so reading it gave NaN) and asserts the text area grows with the box and fills it within 2px; 2 new specs — a sideways resize does not freeze the height (widen, then 6 lines grow the box with no internal scroll), and typing grows a vertically resized box downward (box 130px → 160px for 6 lines, text fully visible). Annotation specs 23/23. Real screenshots: `~/workspace/your_files/snowball-comment-vertical-fixed.png` (tall dotted box filled edge to edge by the text box) and `~/workspace/your_files/snowball-comment-typing-grows.png` (6 lines, box grown to fit).

**Verification:** build passes, oxlint 0 errors, vitest 23/23, full Playwright suite 76/76. Pushed to main 2026-11-22 as commit e6869912cb0d7d51e720e3b421928e1659eda812 ("fix: comment box vertical resize grows the box itself; typing grows it downward (v4.5.18)"), verified on GitHub. New Windows exe (109,909,401 bytes, asar verified with 69 /dist/ files incl. index.html) uploaded to Drive at the same link.

## Performance optimizations (2026-11-22, in progress — one step at a time, verified before the next)

**Request:** optimize loading time and responsiveness without reducing chart quality one bit. 11 steps agreed, in this order: build-only first (remove recharts, trim Inter, subset Material Symbols), then data layer (per-week metadata documents, decode-once-derive-twice), then loading (paint before thumbnails, lazy thumbnail URLs), then detail page (lazy Quill, hover-intent preload), last journal polish (scoped remarks refresh, debounced search). Each step verified (build, vitest, Playwright) and committed separately before the next. Explicitly rejected: shrinking thumb/medium tiers or compressing originals.

### Perf step 1 — Remove unused recharts (2026-11-22)

**Change:** `npm uninstall recharts` (38 packages removed). Verified 0 matches for "recharts" in package.json, package-lock.json and node_modules. Build passes, vitest 23/23. Pushed to main as commit be36487c010a26364ab42480ac8ef839633f3d4c.

### Perf step 2 — Trim Inter to latin/latin-ext (2026-11-22)

**Change (`src/main.jsx` only):** imports `@fontsource/inter/latin-{400,500,600,700}.css` + `latin-ext-{...}.css` (8 imports); non-Latin text falls back to the system font. Dist went from ~50 Inter files to 16, all latin/latin-ext, zero cyrillic/greek/vietnamese; dist/assets 2.4M. Build passes, vitest 23/23, weekly-journal specs 10/10. Pushed to main as commit 5f69fbfac3fcd73e2df3cd2c7b95540c7afee525.

### Perf step 3 — Subset Material Symbols font, 1.1MB → 5.8KB (2026-11-22)

**Change:** the app uses 22 icons, but shipped the full 1.1MB variable font (6,683 glyphs). Two traps found while subsetting: the icon ligatures live under the GSUB feature `rlig`, not `liga` — passing only `liga,kern` silently drops the whole ligature table; and the subsetter prunes ligatures by first glyph only, so a text pass kept 3,772 ligatures instead of 22 (first glyphs are letters shared by thousands of icon names). Fixed with a three-stage subset (`scripts/subset-font.cjs`: text pass → `scripts/filter-font-ligatures.py` keeps only the 22 ligatures → glyph pass drops every unreferenced glyph), verified by `scripts/check-font-subset.py` (47 glyphs, all 22 ligatures, FILL/wght axes kept). The subset `.b64` (7,728 bytes) is checked in as the source; `scripts/decode-font.cjs` now prefers it, decodes when the woff2 is missing or older than its source, and fails the build if any icon used in src is missing from `scripts/material-symbols-icons.txt` (an un-subset icon would otherwise render as its raw word). New `tests/icon-font.spec.js` asserts every rendered icon is a known name and renders as a single glyph (width ≤ font size × 1.3) on the journal, detail page and lightbox toolbar — the helper reads text/size/font in ONE atomic evaluate, because the toolbar re-renders while the image loads and separate reads can catch a detached element (computed font-size "") or a vanished nth() locator. Build passes (dist font ~5.8KB), vitest 23/23, full Playwright 78/78. Pushed to main 2026-11-22 as commit 72b2fb089f2720b2dfb01ceaad9d09345cea8093, verified on GitHub.

### Perf step 4 — Per-week metadata documents (2026-11-22)

**Measured cause:** startup read every small metadata entry one by one — a separate IndexedDB request for each week label, each week's remarks, each day's notes, tags, image meta and trade date — hundreds of requests batched 8 at a time before the journal could paint.

**Change (`src/data/storage.js` + `src/data/storage.test.js` + `tests/week-docs.spec.js` only; no UI code changes):**
- One dataset-week's small metadata now lives in ONE document: `sb_ds_<id>__wk_<weekId> = { v: 1, label?, remarks?, days: { Monday: { notes?, tags?, meta?, date? }, … } }`. Images (img_/thumb_/med_) stay per-key Blobs, annotations (ann_) stay per-key arrays, extra_weeks stays its own key.
- The UI never sees the documents: on load each document is fanned out into the SAME memCache entries the old keys used, so every getter is unchanged. Load is two passes — plain per-key entries first, then documents — so a document always wins over stale old keys for the same week regardless of key order.
- Writers update memCache synchronously (as before) and enqueue a document save; at most one queued save per week, each re-reading memCache when it runs, so rapid typing can never lose an edit behind an earlier queued write, and a failed write cannot break the chain for later saves (`flushWeekDoc` / `flushAllWeekDocs` await pending saves).
- Migration (lazy, current dataset only — other datasets migrate when opened): old keys are grouped by week, merged into a document (document wins on conflict, old keys fill fields the document lacks), written, read back and compared, and only then are the old keys deleted. An interrupted run is safe to re-run; a week whose document did not verify keeps its old keys and loads from them directly. Old-format backups import and migrate on load; the whole-database backup format is unchanged (documents are just keys), and export flushes pending saves first so the latest edits are in the backup.
- Flush-before-mutation everywhere it matters: switching datasets (an unflushed save would write an empty document over the old dataset's data), import, wipe (format) and delete-index (a queued save would otherwise resurrect its document after the wipe). Deleting a week marks its id dead first, so a queued save cannot resurrect it; deleted week ids are never reused (custom ids carry timestamp + random suffix).
- `exportCSVDatabase` now reads the memory cache instead of raw entries, so its output is unchanged (a raw dump would now see one wk_ key per week instead of the notes/remarks rows).
- Tests: 9 new vitest specs (document shape + fan-out after a fresh load, rapid-write coalescing, empty week stores no document, migration converts old keys and deletes them, idempotent re-run, interrupted migration merging with the document winning, deleteWeekData with no resurrection, export includes the latest edit without waiting, old-format backup imports and migrates) and 2 new Playwright specs in `tests/week-docs.spec.js` (old-format backup migrates and shows in the UI after a reload, export contains only wk_ keys; notes + tag typed in the UI survive a full page reload). Existing tests updated where they asserted on the old per-key names: the legacy-flat migration test now expects the wk_ document, and the export/import tests flush instead of waiting on a per-key tags key.

**Verification:** build passes, oxlint 0 errors, vitest 32/32 (23 existing + 9 new), full Playwright suite 80/80 (78 + 2 new week-docs specs). Pushed to main 2026-11-22 as commit edc0c19c01f7f8429b1879929ca9da058ad870c3, verified on GitHub.

### Perf step 5 — Decode once, derive thumb + medium in one worker pass (2026-11-22)

**Measured cause:** every chart upload decoded the full image three times — once for the metadata dimensions (`getImageDimensions`), once for the 480px thumbnail, once for the 1600px medium — each in a separate worker call (or main-thread fallback).

**Change (`src/workers/imageWorker.js` + `src/data/storage.js` + `src/data/storage.test.js` + `tests/derive-once.spec.js`):**
- The worker gained a second message: `{ blob, deriveAll: true }` decodes once with `createImageBitmap` and draws both tiers from the same bitmap (`derive(480, 0.8)` and `derive(1600, 0.85)` in parallel), replying `{ thumb, medium, width, height }`. The single-derivative message is untouched (the legacy-image backfill still derives one tier at a time). All-or-nothing: any failure posts an error, as before.
- `generateDerivativeInWorker` was refactored into a generic `callWorker` round trip (raw reply object) plus thin wrappers; the worker's `onmessage` handler now resolves with the whole reply instead of just `blob`, and each wrapper validates what it needs.
- New `createAllDerivatives(blob)` returns `{ thumb, medium, width, height }` or null when the worker is unavailable or fails (jsdom, worker error, timeout). `setStoredImg` tries it first: on success the metadata, thumbnail (awaited, as before) and medium (background store, as before) all come from that one pass; on null it runs the old three-decode sequence verbatim as the fallback. Same outputs either way: 480px WebP q0.8 thumb, 1600px WebP q0.85 medium, original dimensions in the metadata, original Blob stored untouched.
- Tests: 1 new vitest spec (`createAllDerivatives` returns null without a worker and the upload falls back — metadata + thumbnail still recorded) and 1 new Playwright spec in `tests/derive-once.spec.js` that uploads a 2560×1440 chart in a real browser and reads the tiers back through the storage module: meta 2560×1440 PNG, thumb 480×270 WebP, medium 1600×900 WebP, full 2560×1440 PNG.

**Verification:** build passes, oxlint 0 errors, vitest 33/33 (32 + 1 new), full Playwright suite 81/81 (80 + 1 new derive-once spec). Pushed to main 2026-11-22 as commit 1663a9856abfcce1baefdb66c21fc11ca33f18f1, verified on GitHub.

### Perf step 6 — Paint the journal before thumbnails are cached (2026-11-22)

**Measured cause:** `initStorage` awaited the pre-cache of EVERY thumbnail (an IndexedDB read + `URL.createObjectURL` each) before resolving, and `App.jsx` blocked first paint on the whole promise behind the "Loading journal… / Preparing images…" screen — so a journal with many charts showed a spinner instead of its rows.

**Change (`src/data/storage.js` + `src/App.jsx` + `src/pages/WeeklyJournal.jsx` + `src/data/storage.test.js` + `tests/paint-before-thumbs.spec.js`):**
- `initStorage` now resolves after the metadata phase (registry, week-document migration, metadata load). The thumbnail load runs in the background and the journal renders immediately; cells briefly show their empty state, then fill in as thumbnails arrive.
- New exported `loadThumbnails(onProgress, generation)`: reads the current dataset's thumb keys in batches of 8 and notifies subscribers after EACH batch (a plain `runBatched` has no per-batch hook, so the loop is written out), so visible rows paint early instead of waiting for all thumbs. The missing-thumb/medium backfill still runs afterwards via `requestIdleCallback` (setTimeout fallback), as before.
- New tiny pub/sub in storage.js: `subscribeThumbs(cb)` returns an unsubscribe function. `WeeklyJournal` subscribes once on mount and bumps a `thumbsVersion` state (same pattern as `remarksVersion`); it is threaded through `WeekRow` into `DayCell`, where the thumbnail sync effect re-reads `getStoredThumb` when it bumps. The backfill also calls `notifyThumbs()` after each image it processes — without that, backfilled thumbs would sit in memCache unseen until an unrelated re-render (caught while writing the spec).
- Generation guard: `thumbGeneration` is bumped on every `initStorage`; a thumbnail load or backfill from an older generation aborts without writing, so a dataset switch can never resurrect the previous dataset's thumbnails in the cache. `switchDataset` needs no change — it calls `initStorage`, which kicks the new dataset's load off.
- `App.jsx` drops the progress bar and "Preparing images…" UI entirely; the loading screen is just the spinner + "Loading journal…" while metadata loads. `onProgress` is still forwarded from `initStorage` to the background thumbnail load (the import flow uses it).
- Tests: 2 new vitest specs (`loadThumbnails` caches thumbs + notifies per batch; unsubscribe stops notifications) and 1 new Playwright spec in `tests/paint-before-thumbs.spec.js` that imports 20 full-res charts with NO thumbnails, then asserts the grid paints while the cells are still empty (`<img>` count < 20 at paint time) and all 20 images stream in afterwards. Two test fixes the split forced: the pre-existing "thumb-only cache" spec now awaits `loadThumbnails()` after `initStorage()` before asserting the thumb/full distinction (it was racing the background load — `getStoredThumb` fell back to the just-cached full image), and the new spec asserts truthiness, not `blob:` URLs, because fake-indexeddb structured-clones Blobs to plain objects in jsdom (the `blob:` form is asserted in the Playwright spec instead).

**Verification:** build passes, oxlint 0 errors, vitest 35/35 (33 + 2 new), full Playwright suite 82/82 (81 + 1 new paint-before-thumbs spec). Pushed to main 2026-11-22 as commit 13648e017bc9f9940f773fc7210f4d5ac6fc07e7, verified on GitHub.

### Perf step 7 — Lazy thumbnail object URLs per visible row (2026-11-22)

**Measured cause:** after step 6 the thumbnail load created an object URL for EVERY thumbnail in the dataset and held them all in memCache for the life of the dataset — off-screen rows kept blob URLs (and their decoder-side resources) alive indefinitely.

**Change (`src/data/storage.js` + `src/pages/WeeklyJournal.jsx` + `src/data/storage.test.js` + `tests/lazy-thumb-urls.spec.js`):**
- memCache now holds thumbnail BLOBS; object URLs are created lazily by `getStoredThumb` on first read and kept in a separate `thumbUrlCache` map (memCache is the canonical data, the URL cache is purely a view-layer cache). Legacy string values (data URLs) are returned as-is.
- New `revokeThumbUrl(weekId, dayName)` (+ `revokeThumbUrlByKey` for the backfill, which only has the key string) and `revokeAllThumbUrls()`. `DayCell` revokes its URL in an unmount cleanup effect — when Virtuoso unmounts a row that scrolled out of view, its URL is dropped; the blob stays cached, so the URL is re-created cheaply on the next mount. The cleanup is skipped while the detail page is open (`window.location.hash` starts with `#/trade/` — HashRouter keeps the route in the hash): `goToDetail` may have handed this very URL to the detail page as its image fallback, and revoking it would blank that image.
- Revocation is also wired into every path that drops a thumbnail: `setStoredImg` revokes the old URL when a chart is replaced (and now caches the new thumb blob instead of a URL, in both the derive-all and fallback paths); the backfill revokes the old URL when it stores a generated thumb blob; `clearStoredImg` and `deleteWeekData` revoke the affected URLs; `initStorage`, `formatDatabase` and `deleteIndex` call `revokeAllThumbUrls()` alongside their `memCache.clear()` (the switch-side revoke already existed for memCache values; blobs in memCache are no-ops for `revokeBlobUrl`, so the URL cache needs its own clear).
- Tests: 2 new vitest specs (lazy creation + re-creation after revoke, with the second read reusing the same URL; dataset switch revokes the previous dataset's URL, asserted with a `URL.revokeObjectURL` spy) and 1 new Playwright spec in `tests/lazy-thumb-urls.spec.js` that seeds 20 weeks with charts, spies on `revokeObjectURL` via `addInitScript`, scrolls the first rows out of view and asserts their thumbnail URL was revoked, then scrolls back and asserts the image loads again with a FRESH blob: URL and naturalWidth 480. Two spec fixes while writing it: importDatabase deliberately skips thumb_/med_ entries (the backup format excludes derived tiers), so the spec seeds img entries and lets the backfill generate the thumbs; and the "thumb URL is showing" wait compares `getStoredThumb` against `getStoredImg` (they differ exactly once the thumb exists — the backfill's full-image fallback makes them equal before that, and `idb-keyval` can't be imported inside `page.evaluate`).

**Verification:** build passes, oxlint 0 errors, vitest 37/37 (35 + 2 new), full Playwright suite 83/83 (82 + 1 new lazy-thumb-urls spec). Pushed to main 2026-11-22 as commit bbe4027290c6077c238589f75504c2a87c259827, verified on GitHub.

### Perf step 8 — Mount Quill lazily on the detail page AND in the remarks modal (2026-11-22)

**Measured cause:** the ~200KB Quill bundle (`react-quill-new`, gzip 60KB) was a static import on BOTH pages that open an editor: the detail page's notes editor (`TradeDetail.jsx`) and the journal's remarks modal (`WeeklyJournal.jsx`). The detail page's own chunk carried it, and the journal — the first screen the user sees — loaded it eagerly on every app start, even when no editor was ever opened.

**Change (`src/pages/TradeDetail.jsx` + `src/pages/NotesEditor.jsx` (new) + `src/pages/WeeklyJournal.jsx` + `src/pages/RemarksEditor.jsx` (new) + `tests/lazy-quill.spec.js` (new) + `tests/helpers/notes-editor.js` (new) + 4 updated specs):**
- Detail page: `ImageResizeHandler` (which needs `Quill.find`, so it had to move with the editor or its static import would defeat the split) moved verbatim into new `src/pages/NotesEditor.jsx`, which also owns the ReactQuill instance and the `notes-editor` testid effect. `TradeDetail` lazy-imports it (`React.lazy` + `Suspense`) and never imports `react-quill-new` itself.
- The notes section starts as a read-only `NotesPlaceholder` (same bold look, shows the saved notes as a preview, or the "Type notes here…" hint when empty). The real editor mounts when the section scrolls into view (`IntersectionObserver`, rootMargin 200px, so it is ready by the time the user clicks) or when the user clicks / focuses the placeholder. A click also auto-focuses the editor on mount (cursor at the end), so the click that opens the editor never needs a second click and no keystroke typed right after it is lost. Drops on the section before mount still work — the existing `persistNotes` fallback appends the image to the notes.
- Remarks modal: the toolbar editor moved verbatim into new `src/pages/RemarksEditor.jsx` (same value, onChange, toolbar config); `WeeklyJournal` lazy-imports it inside a `Suspense` with a "Loading editor…" fallback of the same footprint. The modal is user-triggered, so the chunk loads only when remarks are actually opened. Both lazy editors share one Quill chunk (`quill.snow-*.js`, 205.89 kB) — whichever editor opens first loads it, the second reuses it.
- Verified the split matters: on journal load the browser now fetches ZERO quill resources (measured via `performance.getEntriesByType('resource')`); after opening a remarks modal, `react-quill-new.js` + `quill.snow.css` appear. The build output confirms the split: `quill.snow-*.js` (205.89 kB) is its own chunk, `NotesEditor-*.js` 5.4 kB, `RemarksEditor-*.js` small.
- Specs: new `tests/helpers/notes-editor.js` exports `ensureNotesEditor(page)` — it scrolls the placeholder into view and waits for the editor, tolerating the race where the IntersectionObserver mounts the editor on its own and unmounts the placeholder mid-scroll (the detached-element error is swallowed; the wait below proves the editor arrived). `trade-detail`, `smooth-experience`, `notes-images` and `week-docs` specs now use it. New `tests/lazy-quill.spec.js` (4 specs, short 500px viewport so the notes section starts below the fold): no editor and no quill chunk on load, editor mounts on scroll, typing works the moment it mounts, pointerdown on the placeholder mounts + focuses without scrolling, and the placeholder previews saved notes before the editor mounts. Two spec fixes while writing it: `page.evaluate` results must be awaited before `expect` (a missing await made the assertion receive a Promise), and the reopened detail page keeps the old scroll position, so the preview spec reloads the journal first to reset scroll to the top.
- Bug found while writing the specs (and the reason the step grew): the first lazy-quill run showed the quill chunk loading on the detail page even with the editor unmounted — because the journal's remarks modal statically imported Quill, so the bundle was already in the graph before the detail page was ever visited. Lazy-loading the detail editor alone saved nothing in practice; the remarks modal had to be lazy too. That is why step 8 covers both editors.

**Verification:** build passes, oxlint 0 errors, vitest 37/37 (no new vitest specs — the change is load-timing only), full Playwright suite 87/87 (83 + 4 new lazy-quill specs; an earlier full run reported 85 passed against 87 listed, so the suite was re-run to a clean 87/87 with no skips or flakes). Pushed to main 2026-11-22 as commit d1e826077c79f7cb9010de4aa44a2b51fd568e5b, verified on GitHub.

### Perf step 9 — Hover-intent preload of a cell's medium image (2026-11-22)

**Measured cause:** opening a trade always paid the full cost of resolving its 1600px medium inline image (`resolveMediumAsync` → decode the original → derive the medium) at navigation time, even though the user had usually been looking at that exact cell for a while before double-clicking it.

**Change (`src/pages/WeeklyJournal.jsx` + `tests/hover-preload.spec.js` (new)):**
- `DayCell` now preloads on hover intent: `onMouseEnter` starts a 150ms timer (a deliberate pause, not a scroll-by) that calls the existing `resolveMediumAsync(weekId, day.day)` — the medium is generated and cached in memCache + IndexedDB, so the detail page finds it ready. The timer is cancelled on `onMouseLeave` and on unmount, so a fast scroll past rows preloads nothing. Empty cells preload nothing (`cellImg` guard); an already-cached medium is a cheap no-op inside `resolveMediumAsync`. Both DayCell render branches (with chart / empty dropzone) carry the handlers. No new storage code — the preload reuses the same `resolveMediumAsync` the detail page already calls.
- Tests: 2 new specs in `tests/hover-preload.spec.js`. The missing-thumb/medium backfill is disabled for the spec (an `addInitScript` stub makes `requestIdleCallback` a no-op), so the only way a medium appears is the hover preload. Cells are seeded with charts via `day.img` (the cell renders from it) plus the matching IDB img keys (the medium is generated from those). Spec 1: pausing on Monday's cell pre-generates Monday's medium (polled via the synchronous `getStoredMedium`) while Tuesday's stays absent. Spec 2: a 50ms pass over the cell preloads nothing. One spec fix while writing it: the medium helper was defined at describe scope where `page` doesn't exist — it now takes `page` as a parameter.

**Verification:** build passes, oxlint 0 errors, vitest 37/37 (no new vitest specs), full Playwright suite 89/89 (87 + 2 new hover-preload specs). Pushed to main 2026-11-22 as commit b8f134127a9fda003e46b018a7d1ae727e768387, verified on GitHub. (The first push attempt's approval card timed out, so the push was retried on the user's go-ahead.)

### Perf step 10 — Scope the remarks refresh to the edited week (2026-11-22)

**Measured cause:** closing ANY remarks modal bumped one global `remarksVersion` counter that was passed to EVERY `WeekRow`, so each row's `useMemo` recomputed its remarks preview — O(all rows) work for a one-row edit.

**Change (`src/pages/WeeklyJournal.jsx` + `tests/scoped-remarks.spec.js` (new)):**
- The single counter is now a per-week map, `remarksVersions` (`{ [weekId]: number }`). The remarks modal's `onClose` bumps only the edited week's entry (`setRemarksVersions((prev) => ({ ...prev, [remarksModal.id]: (prev[remarksModal.id] ?? 0) + 1 }))`), and each row receives only its own value (`remarksVersion={remarksVersions[trade.id] ?? 0}`). The `WeekRow` prop stays a plain number and its `useMemo` is unchanged — other rows' props don't move, so their previews are not recomputed. The modal still writes to storage directly; the edited row still re-reads on close, exactly as before.
- Tests: 1 new spec in `tests/scoped-remarks.spec.js` with two weeks — editing week 1's remarks updates week 1's cell and leaves week 2's cell untouched, then editing week 2's leaves week 1's text intact. The recompute itself is internal, so the spec pins the user-visible behaviour the scoping protects.

**Verification:** build passes, oxlint 0 errors, vitest 37/37 (no new vitest specs), full Playwright suite 90/90 (89 + 1 new scoped-remarks spec). Pushed to main 2026-11-22 as commit 4cc39106e7dd479434bd09c9e30fa61d1be50217, verified on GitHub.

### Perf step 11 — Debounce the search input (2026-11-22)

**Measured cause:** every keystroke in the search box wrote the URL query (`setSearchParams({ q: val })`), which re-rendered the journal and rebuilt the whole search index + row filter per keystroke — a fast typist paid a full O(all trades) index rebuild for every character.

**Change (`src/pages/WeeklyJournal.jsx` + `tests/debounced-search.spec.js` (new)):**
- The input is now a local `searchDraft` state that updates instantly (typing feels unchanged), while the URL query — which drives the `searchHits` index + row filtering — is written 100ms after the user stops typing (a timer restarted on every keystroke). Results are identical, just ~100ms later. The × button clears immediately with no debounce (timer cancelled, draft + URL emptied at once), and the draft follows the URL when it changes elsewhere (back/forward navigation, dataset-switch clear) unless a commit is pending. `setSearch` itself is now a `useCallback` (deps `[setSearchParams]`), which also removed a stale-closure lint warning and steadied the dataset-switch effect's deps.
- Tests: 2 new specs in `tests/debounced-search.spec.js`. Spec 1 types 'gapup' keystroke by keystroke and asserts the input holds the text mid-typing while the URL still has no query, then after the pause the URL carries `q=gapup` and the same cells are outlined / rows filtered as an undebounced search. Spec 2: the × button empties the input and the URL immediately and the rows return at once. The five existing search specs pass unchanged — their auto-retrying assertions absorb the 100ms delay.
- Flakes found while verifying this step (test-only fixes, no product code): the notes-images spec timed out in `ensureNotesEditor` under suite load — root cause was the helper itself: `scrollIntoViewIfNeeded` / `locator.evaluate` wait up to 30s for a placeholder that never comes back once the editor mounts, eating the whole test timeout. The helper now grabs the placeholder with `elementHandle()` (a one-shot lookup, no waiting) and skips the scroll when there is no placeholder (the editor is mid-mount; the 15s wait below covers it). The lazy-quill "not mounted on load" spec was also miscalibrated: with no chart uploaded the notes section sits ~605px down, inside the observer's 200px rootMargin at a 500px viewport (500 + 200 = 700), so the observer fired on load and the chunk raced the assertion — the spec now uses a 320px viewport (trigger line 520, well above 605). The paint-before-thumbs 20s wait for 20 worker derivations is now 60s under suite load. After these fixes the full suite went green.

**Verification:** build passes, oxlint 0 errors, vitest 37/37 (no new vitest specs), full Playwright suite 92/92 (90 + 2 new debounced-search specs). Pushed to main 2026-11-22 as commit efa51dc3d2ca7e7d0ab653a4ba29fb0b5fa195a4, verified on GitHub. (The first push attempt's approval card timed out, so the push was retried on the user's go-ahead.)

### Final verification — all 11 steps, new Windows exe (2026-11-22)

**Final state:** all 11 steps pushed to main, in order: `be36487c` (1, remove recharts), `5f69fbfa` (2, trim Inter), `72b2fb08` (3, subset Material Symbols), `edc0c19c` (4, per-week metadata docs), `1663a985` (5, decode once derive twice), `13648e01` (6, paint before thumbnails), `bbe40272` (7, lazy thumbnail URLs), `d1e82607` (8, lazy Quill), `b8f13412` (9, hover-intent preload), `4cc39106` (10, scoped remarks refresh), `efa51dc3` (11, debounced search). Final full suite on the finished code: vitest 37/37, Playwright 92/92, oxlint 0 errors. No chart quality was reduced anywhere — originals are still stored untouched; only derived tiers and loading order changed.

**New Windows exe:** built from the final code, `npm run build` (verify-dist OK: index.html + 27 assets) + `electron-builder --win portable`. Size 106,830,474 bytes (down from 109,909,401 for v4.5.18 — recharts removed, Inter trimmed, icon font subset; the app itself is unchanged). Asar verified: it contains every file from `dist/` (31 files incl. index.html, diffed against the disk build — the count is lower than the old 69 only because the removed libraries are no longer in dist). Uploaded to Drive, replacing the file at the same link (file id 1xJkjEqCcsfwAYZHa1rKCR7h2rDAeZrtM).

### Round 2 — further improvements (2026-11-22)

After the 11 steps, the user asked what else could be improved; six candidates were listed with their impact and he asked to do 1–5 (dropping #6, backup compression). Same protocol as round 1: one at a time, verified, pushed separately, exe at the end.

### Round-2 improvement 1 — Scope the thumbnail refresh per week (2026-11-22)

**Measured cause:** every thumbnail batch that arrived bumped one global `thumbsVersion` counter passed to every `WeekRow` and `DayCell`, so the whole grid re-rendered each time images streamed in — the same shape as the step-10 remarks problem, but firing far more often (per batch, per backfilled image).

**Change (`src/data/storage.js`, `src/pages/WeeklyJournal.jsx`, `src/data/storage.test.js`):**
- `notifyThumbs` now takes the affected week ids and passes them to subscribers. New helper `weekIdFromImageKey(key, tier)` inverts the key builders (the day name is the last `_`-segment; week ids never contain `_`). `loadThumbnails` notifies once per batch with the distinct weeks in that batch; the backfill notifies with the one week of the image it just processed.
- WeeklyJournal keeps a per-week `thumbsVersions` map (`{ [weekId]: number }`) and passes only the row's own value down (`thumbsVersion={thumbsVersions[trade.id] ?? 0}`). `WeekRow`/`DayCell` are unchanged — the prop stays a plain number.
- Tests: 1 new vitest spec — seed thumbs for week-1 and week-2, `loadThumbnails`, assert exactly one notification naming `['week-1', 'week-2']`. The paint-before-thumbs and lazy-thumb-urls specs are the behavioural guards that thumbs still stream in. (While verifying, the notes-images spec flaked once on the editor mount under suite load — 3/3 in isolation, green on re-run; same load flake class as step 11, not caused by this change.)

**Verification:** build passes, oxlint 0 errors, vitest 38/38 (37 + 1 new per-week notification spec), full Playwright suite 92/92. Pushed to main 2026-11-22 as commit 6ead6fef4591e9f8903f33b48d614dd6fa57013e, verified on GitHub.

### Round-2 improvement 2 — Precompute the search index once (2026-11-22)

**Measured cause:** every search commit ran the full scan twice — once for the row filter, once for the highlights — re-running two regexes per note/remark and re-lowercasing every haystack for every trade and day.

**Change (`src/data/storage.js`, `src/pages/WeeklyJournal.jsx`, `src/data/storage.test.js`):**
- New exported `getSearchIndex(trades)` in storage.js: a cached lowercase index, one entry per trade (`{ id, labelStart, labelEnd, remarks, days: { Monday: { notes, tags: [...] }, ... } }`). Fields are kept separate so a query can never match across a join boundary the old code couldn't match — results are identical to the unindexed search. The cache is keyed by a module-level data version + the trades reference.
- The version is bumped by every writer that can change searchable text: all week-doc writers funnel through `scheduleWeekSave` (notes, tags, remarks, label, trade date, image meta), plus `initStorage` (import / dataset switch / format) and `deleteWeekData`. Bumping is just an integer increment; the index rebuilds at most once per data change, the first time a search runs after it.
- WeeklyJournal builds the index in a `useMemo` only when there is a query (a journal that is never searched pays nothing), and both the row filter and the highlights now read it with cheap `includes()` — `filtered` zips the index by position with `allTrades`, `searchHits` loops the index directly. The three getters the old code used in the journal (`getRemarksText`, `getNotesText`, `getTags`) are now unused there and were removed from the import.
- Tests: 2 new vitest specs — the index lowercases once and keeps fields separate, a repeat call returns the exact same cached array, and an edit invalidates the cache so the next build picks up the new text; and a query-equivalence check proving 'gapup'/'GAPUP'/'GapUp' and 'gapdown' match exactly what the unindexed search matched. The five search specs + two debounced-search specs are the behavioural guards that results are unchanged.

**Verification:** build passes, oxlint 0 errors, vitest 40/40 (38 + 2 new search-index specs), full Playwright suite 92/92. Pushed to main 2026-11-22 as commit 915236d50560d5d75c1b05ec2964532872e56fc4, verified on GitHub. (The first push attempt's approval card timed out, so the push was retried on the user's go-ahead.)

### Round-2 improvement 3 — Stop scanning the keys twice on startup (2026-11-22)

**Measured cause (this changed what was built):** the item as listed was "a dataset manifest, so startup skips the full key scan". Measured on a seeded 60-week journal (963 keys): the `keys()` scan costs **~5ms**, while the metadata value reads cost ~80ms. A manifest would have saved only those ~5ms, at the cost of a new sync-risky document that must never disagree with reality — not worth it. But the measurement found the real waste: startup ran the full scan **twice** before first paint — once inside `migrateWeekDocs` (which re-scanned on every startup even though the old-format migration finished long ago and there is usually nothing to migrate) and once in `initStorage` for the metadata load. That duplicate scan is what this step removes; the manifest idea is dropped.

**Change (`src/data/storage.js`, `src/data/storage-keys.test.js`):**
- `migrateWeekDocs(allKeys)` now takes the key list `initStorage` already fetched and returns it **adjusted** for the migration — old keys that were successfully migrated (written + verified + deleted) removed, the week documents written for them added — so the metadata phase reads exactly the post-migration state from the same list, with no second scan. A week whose verify fails keeps its old keys, and they stay in the returned list, so the plain-keys pass still loads them. (The order matters: the migration must run before the list is used, because it writes the documents and deletes the old keys; taking the list first and adjusting it preserves that.)
- `initStorage` now fetches the keys once, passes them to the migration, and reuses the adjusted list for the metadata phase. The background thumbnail load still does its own scan after paint (untouched).
- Tests: new file `src/data/storage-keys.test.js` with 1 vitest spec counting `keys()` calls during `initStorage` — **2 in total** (main scan + background thumb load), where the old code did 3. The count needs a pass-through `vi.mock` of idb-keyval because `vi.spyOn` cannot touch an ESM module namespace. The week-docs specs (vitest + Playwright) are the behavioural guards that migration still works.

**Verification:** build passes, oxlint 0 errors, vitest 41/41 (40 + 1 new keys-count spec), full Playwright suite 92/92 (week-docs subset 2/2). Pushed to main 2026-11-22 as commit 6d953e2318226fce793490283608ea0d4299e7bc, verified on GitHub. (The first push attempt's approval card timed out, so the push was retried on the user's go-ahead.)

### Round-2 improvement 4 — Evict off-screen thumbnail blobs (2026-11-22)

**Measured cause:** `memCache` held every thumb Blob forever (~25 KB each), so a long journal's thumbnails accumulated and never came back — the step-7 URL revoke only freed the object-URL slot, not the Blob behind it.

**Change (`src/data/storage.js`, `src/pages/WeeklyJournal.jsx`, `src/data/storage.test.js`, `tests/thumb-eviction.spec.js`):**
- When a DayCell unmounts (its row scrolled out of view), its thumb Blob is now dropped from `memCache` after a **30 s grace period** (`scheduleThumbEviction`); the IndexedDB copy stays. The grace period matters: Virtuoso remounts the whole list on a zoom change and a quick scroll-back remounts within a second, so evicting instantly would make every zoom / scroll-back re-read all its thumbs from IndexedDB and flicker. A remount cancels the pending eviction (`cancelThumbEviction` in the cell's mount setup).
- The eviction also revokes the thumb's object URL, so the state is consistent (no Blob, no URL). It is skipped while the detail page is open, same as the existing URL revoke — `goToDetail` may have handed that URL to the detail page as its image fallback.
- A remounted cell whose thumb was evicted reloads it from IndexedDB (`loadThumb`, with an in-flight guard) and notifies subscribers for its week, so the cell's sync effect re-reads it. A module-level `thumbKnown` set records which cells have a thumb in IndexedDB (populated by the thumbnail load, the backfill, and uploads; cleared on delete / week delete / dataset switch / reload), so a remounted cell knows whether a missing Blob means "evicted, reload it" or "never had one". The reload trigger is "thumb Blob missing but known to exist" — not "no image at all" — because the full-image fallback must never become the grid's image: decoding full-res charts is what made scrolling janky.
- Tests: 2 new vitest specs — the eviction drops the Blob and revokes its URL after the delay while keeping the known flag, and a remount cancels the pending eviction. 2 new Playwright specs (`tests/thumb-eviction.spec.js`) — a quick scroll away and back is instant (grace period), and after the grace period the image reloads from IndexedDB on scroll-back. (The `loadThumb` restore itself is verified in the browser spec, not in vitest: fake-indexeddb structured-clones Blobs to plain objects, so an IDB round-trip there is never a Blob.)

**Verification:** build passes, oxlint 0 errors, vitest 43/43 (41 + 2 new eviction specs), full Playwright suite 94/94 (92 + 2 new eviction specs). Pushed to main 2026-11-22 as commit 05de0d16289e7e9a0c4b853a70b0d501c5b54147, verified on GitHub.

### Round-2 improvement 5 — Drop the .woff Inter files from the bundle (2026-11-22)

**Measured cause:** `dist` shipped 8 `.woff` files (317,912 bytes) alongside the `.woff2` files — `@fontsource/inter`'s CSS references both formats for every weight, and Chromium always picks woff2, so the `.woff` files were never downloaded: pure dead weight in every exe.

**Change (`vite.config.js`, `tests/font-woff2.spec.js`):**
- New `dropWoff()` Vite plugin (same inline style as the existing `stripCrossOrigin` plugin): in `generateBundle` it deletes every `.woff` asset from the bundle and strips the `, url(...) format('woff')` entries from the emitted CSS, so no dangling references ship. (The first version of the regex missed because Vite minifies the CSS — no spaces, `format("woff")` with double quotes — fixed to match the minified form.) The `.woff2` files (9, incl. the Material Symbols subset) are untouched; the Inter `@font-face` rules keep their `unicode-range`s and weights exactly as `@fontsource` wrote them.
- Result: `dist` goes from 31 files to **23 files** (8 fewer); the built CSS has 0 `.woff` references and 18 `woff2` references.
- Tests: 1 new Playwright spec (`tests/font-woff2.spec.js`) — no request for a `.woff` file is ever made, no request fails, and Inter loads and renders in all four weights (400/500/600/700) via `document.fonts.load` + `check`, with the body font resolving to Inter. (The first version used `check()` alone and failed on 600: a fresh journal renders no week rows, so the 600/700 faces had never been used yet and `check()` reports unloaded faces as false — loading each face explicitly first is the correct assertion.)

**Verification:** build passes, oxlint 0 errors, vitest 43/43, full Playwright suite 95/95 (94 + 1 new font spec) — the first full run had one failure in `notes-images.spec.js:66` (notes editor mount timeout), the known full-suite load-flake class; the re-run was 95/95. Pushed to main 2026-11-22 as commit 51d0107fc6e1da3733ca18e1338a9eeb341eb33e, verified on GitHub.

### Round 2 — Final verification (2026-11-22)

All five improvements are on main, in order: `6ead6fef` (1, scoped thumbnail refresh per week), `915236d5` (2, precomputed search index), `6d953e23` (3, stop scanning the keys twice on startup), `05de0d16` (4, evict off-screen thumbnail blobs), `51d0107f` (5, drop .woff Inter files). Final suite on the finished code: vitest 43/43, Playwright 95/95, oxlint 0 errors. **Final Windows exe built from the finished code (106,827,407 bytes) and uploaded to Drive, replacing the file at the same link (file id 1xJkjEqCcsfwAYZHa1rKCR7h2rDAeZrtM).** Asar verified by diff: 23 /dist/ files incl. index.html (down from 31 — the 8 dead .woff files are gone), matching the disk build exactly. Note on the size: the exe is only 3,067 bytes smaller than round 1's despite 310 KB of fonts leaving `dist` — the asar is dominated by 52 MB of node_modules, so the font saving shows in the app bundle, not the exe total.

### Bug-fix round (2026-11-22)

After round 2 the user asked for another scan for bugs and performance improvements. Two auditors (one correctness, one performance) read the current code and measured where they could. The bug list, in severity order: (1) corrupt backup import wipes the DB then throws mid-write — half-restored DB; (2) fire-and-forget deletes/sets resurrect data on a fast reload; (3) dropping a file onto a cell that already has a chart navigates the app away to the raw image; (4) IndexedDB failure hangs the app on "Loading journal…" forever; (5) reload / deep link to a trade shows "Trade not found"; (6) derivative failure silently stores the full-res image as the thumb; (7) stale async image continuations show the wrong chart after delete/navigation; plus six minors (comment box swallows tool clicks, dataset switch leaves a stale filter, GoTo button silently does nothing on an incomplete form, duplicate tags, shortcuts fire while typing, object URLs leaked by derivative generation). The user said to fix the bugs first, very carefully. Same protocol as rounds 1–2: one at a time, verified, pushed separately, exe at the end.

### Bug 1 — Corrupt backup import wipes the database, then throws mid-write (2026-11-22)

**Measured cause:** `importDatabase` wiped first and decoded images during the write phase — `dataURLtoBlob`'s bare `atob` throws `InvalidCharacterError` on corrupt base64, `runBatched` aborts the whole import on one bad image, and the settings handler caught the error and alerted but did not reload, so the UI kept showing pre-wipe data from memCache while IndexedDB was half-restored. A second, smaller hole in the same function: the `data.filter(([k]) => …)` / `find` / `for (const [k, v] of data)` destructuring ran outside the `JSON.parse` try/catch, so a non-iterable backup element threw a raw `TypeError` instead of the friendly "Invalid backup" error.

**Change (`src/data/storage.js`, `src/pages/WeeklyJournal.jsx`, `src/data/storage.test.js`):**
- Every backup entry is shape-checked first (must be a `[string, value]` pair) before anything else touches the data.
- The image/other split now happens before the wipe, and every image entry is decoded to a Blob **before** the wipe — a corrupt or empty image fails while the old database is still intact, with a message naming the key ("…is corrupted (bad base64 data). Nothing was changed."). The Blobs are held in memory and written after the wipe, so each image is decoded exactly once; the decode loop yields every 20 images so a huge backup doesn't freeze the UI.
- Any failure after the wipe (now only an IndexedDB write error could do that) is marked `err.wiped = true`, and the import handler reloads in that case so the UI shows what's actually stored instead of phantom data.
- One subtle catch found while reordering: the old code switched `currentDatasetId` to the backup's target dataset during normalisation, before validation — a failed single-dataset import would have left the module pointing at another dataset even with the database intact. The target is now recorded during normalisation and applied only after the backup validates.
- Tests: 3 new vitest specs — a corrupt image entry rejects with the friendly error and the old chart + tags survive untouched (and the valid image from the corrupt backup is never written); an empty image payload rejects the same way; a non-iterable backup element throws the friendly pair-shape error. The existing import specs (whole-DB round trip, data-URL image, legacy flat) are the happy-path guards.

**Verification:** build passes, oxlint 0 errors, vitest 46/46 (43 + 3 new import-validation specs), full Playwright suite 95/95. Pushed to main 2026-11-22 as commit 8f6f06c9a7903d86ab6cb390c96df52697ccfdcf, verified on GitHub. (The commits API was rate-limited at verify time, so the push-files returned sha is the authority.)

### Bug 2 — Fire-and-forget deletes/sets resurrect data on a fast reload (2026-11-22)

**Measured cause:** five storage functions fired their IndexedDB writes without awaiting them — `setStoredImg`'s delete path (`del` ×3), `clearStoredImg` (`del` ×3), `deleteWeekData` (~20 `del`s), `setAnnotations` (`set`/`del`), `setExtraWeeks` (`set`) — and their callers never waited either. memCache was updated synchronously, so the screen always looked right; but a reload or close inside the write window (tens of ms) resurrected the deleted chart, week, mark, or added week from the still-pending IndexedDB transaction. The delete path of `setStoredImg` had a second, narrower window: the image meta lives in the week document, written by the chained `scheduleWeekSave`, so a reload could also restore a stale meta for a deleted image.

**Change (`src/data/storage.js`, `src/pages/TradeDetail.jsx`, `src/pages/WeeklyJournal.jsx`, `src/data/storage.test.js`):**
- Every one of the five functions is now `async` and awaits its writes (`Promise.all` of the `del`s in `setStoredImg`, `clearStoredImg`, `deleteWeekData`). The synchronous memCache updates stay first, so the UI still updates instantly — only the storage confirmation is awaited.
- Callers await too: `deleteChart` (UI state first, then `await setStoredImg(..., 'DELETED')` plus `await flushAllWeekDocs()` to land the pending week-document save and close the meta window), `addRow` / `deleteRow` (start the writes, update the UI, then await), and `persistAnnotations` (fires once per gesture — place / drag end / resize end / delete — never per pointermove, so awaiting is cheap).
- `clearStoredImg` has no callers right now (chart delete goes through `setStoredImg`) — hardened anyway so the export stays safe.
- Tests: 5 new vitest specs, each asserting IndexedDB state immediately after the awaited call returns — chart-delete keys gone, `clearStoredImg` keys gone, `deleteWeekData` keys gone, annotation key written then gone on empty set, `extra_weeks` value readable right after the await. These discriminate the fix: the old fire-and-forget code returned before the writes landed.

**Verification:** build passes, oxlint 0 errors, vitest 51/51 (46 + 5 new awaited-delete specs), full Playwright suite 95/95. Pushed to main 2026-11-23 as commit 0ca6f1da03bcfd4b318be3dd23f8b93be1093a51, verified on GitHub.
- Verification note: the first full Playwright run on this change came back 94/95 with `notes-images.spec.js:36` timing out on the notes-editor mount at the reopen step. It was investigated as a possible regression from this change, not assumed to be a flake: the whole change was reverted (files backed up, checksums recorded) and the spec passed; the change was then restored (checksums verified) and bisected piece by piece (`addRow`/`setExtraWeeks` first). The spec then passed twice on the bug-2 code, including once immediately after failing — the failure is the known editor-mount slowness under load (the lazy Quill chunk taking over the helper's 15 s wait when the machine is busy), the same flake class seen in round 2. The re-run protocol was followed: the second full run is the result recorded above (95/95).
- Push note: the first push attempt was interrupted by a service restart mid-run; GitHub HEAD was checked and still showed the bug-1 commit, so the push was retried (paths file recreated) and landed as 0ca6f1da.

### Bug 3 — Dropping a file onto a cell that already has a chart navigates the app away (2026-11-23)

**Measured cause:** the DayCell image branch had no `onDragOver` / `onDrop` / `onPaste` — only the empty branch did — so a file dropped onto a chart cell took the browser's default drop action: navigate the whole app to the raw image, unusable until restart. Pasting onto a chart cell silently did nothing (no handler, no focus target). The same hole existed on the detail page: the chart container had no drop/paste handlers, only the empty dropzone did. And there was no window-level guard anywhere, so a drop on the header, remarks column, or any gap navigated away too.

**Change (`src/pages/WeeklyJournal.jsx`, `src/pages/TradeDetail.jsx`, `src/App.jsx`, `tests/chart-cell-drop.spec.js`):**
- The journal's image branch now has the empty branch's handlers — `onDragOver` / `onDragLeave` / `onDrop` (replaces the chart via the existing `saveFile`) / `onPaste`, plus `tabIndex={0}` and click-to-focus so Ctrl+V has a target, and a "Drop to replace" overlay (same upload icon, dark scrim over the chart) while dragging.
- The detail page's chart container (`chart-image-container`) got the empty dropzone's handlers (`handleChartDrop` / `handleChartPaste` → `persistChart`) and the same "Drop to replace" overlay while dragging.
- Safety net in `App.jsx`: window-level `dragover` + `drop` listeners that `preventDefault()` — a file dropped anywhere no cell or dropzone handles can no longer navigate the app away. It does not `stopPropagation`, so cells and dropzones still receive their drops first (React handlers run before this window listener in the bubble phase).
- Not done, deliberately: the auditor's suggested `will-navigate` guard in `main.cjs` was left out — the renderer guard prevents the navigation at its source, the app has no other navigation path, and the guard would not be covered by the Playwright suite (which runs the dev server, not Electron).
- Tests: 5 new Playwright specs in `tests/chart-cell-drop.spec.js` — drop on an empty cell uploads; drop on a chart cell replaces it (proven end-to-end by the detail page's Original badge reading the new dimensions) and stays on the journal; paste on a chart cell replaces it; drop on the header neither navigates nor uploads; drop on the detail-page chart replaces it. Drops/pastes are dispatched as synthetic `DragEvent`/`ClipboardEvent`s with a real `DataTransfer` holding a generated PNG, the pattern the notes-image paste specs already use. One test-authoring catch: `page.goto('/')` lands on `http://localhost:5173/` with no `#` until the first navigation, so the stay-on-journal assertion uses `/.*\/$/` (as `reopenCell` does), not `/#\/$/`.

**Verification:** build passes, oxlint 0 errors, vitest 51/51, full Playwright suite 100/100 (95 + 5 new). Pushed to main 2026-11-23 as commit b087c42a0dbaf5891f974add40ab422931a8ba00, verified on GitHub.
- Verification note: the first full run came back 98/100 — `notes-images.spec.js:36` (the known editor-mount flake) and `debounced-search.spec.js:7` (that spec reads the outlined cells immediately after the URL poll with no render wait, so under load it catches the DOM before the outlines land; its cells have no charts, so the image-branch change cannot affect it). Both specs pass in isolation (5/5 together); the re-run protocol was followed and the second full run is the result recorded above (100/100).

### Bug 4 — IndexedDB failure hangs the app on "Loading journal…" forever (2026-11-23)

**Measured cause:** `App.jsx` ran `initStorage().then(() => setLoading(false))` with no `.catch`. `initStorage` has no try/catch around its metadata phase either, so any IndexedDB failure (unavailable, blocked, corrupt) rejected the promise — and with nothing catching it, `loading` stayed true forever. The app showed the spinner with no way forward and no hint what was wrong.

**Change (`src/App.jsx`, `tests/startup-error.spec.js`):**
- Startup now settles explicitly: the loading promise resolves → journal; rejects → an error screen. The screen says plainly that storage failed to open and that the data is still in the browser (a loading problem, not a data problem), shows the browser's error message in small print for diagnosis, and offers a Retry button that re-runs `initStorage` from scratch.
- The screen deliberately uses no Material icon — the subset font only carries the icons the app already uses, and an unknown ligature would render as its text. The "!" badge is a plain red circle with white text; the Retry button is the theme's white pill with bold black text, and the warning red is the same `#dc2626` the settings confirmations use.
- A lint catch while implementing: the first version reset state synchronously inside the effect (`load()` called `setLoading(true)`), which oxlint flags (`set-state-in-effect`) — it was the 21st warning against 20 pre-existing. Restructured so the settlement lives in a `settleLoad` callback (state only in async continuations) that the effect calls directly, while the Retry button resets state first and then settles. Back to 20 warnings, 0 errors.
- Tests: 1 new Playwright spec in `tests/startup-error.spec.js` — an init script breaks `IDBFactory.prototype.open` while a flag is set (the flag, not a first-call counter, so the StrictMode double effect can't slip a successful open through), the error screen appears with the simulated message and no "Loading journal…" text, then the test clears the flag, clicks Retry, and the journal loads.

**Verification:** build passes, oxlint 0 errors (20 pre-existing warnings), vitest 51/51, full Playwright suite 101/101 (100 + 1 new) — green on the first full run, and green again after the lint restructure. Pushed to main 2026-11-23 as commit a6184da31ef9cef1f434013273339a1451f909e8, verified on GitHub.

### Bug 5 — Reload / deep link to a trade shows "Trade not found" (2026-11-23)

**Measured cause:** the detail page depended entirely on router `location.state` for the trade, and the fallback lookup `getTradeById` in `src/data/trades.js` was a stub returning `null`. So a hard reload of a `/trade/:id` URL, or opening that link directly, had no trade to render and showed "Trade not found" — even though the week and its images were all in storage.

**Change (`src/data/trades.js`, `src/pages/TradeDetail.jsx`, `tests/trade-reload.spec.js`):**
- `getTradeById` is now real: it rebuilds the week from storage — the extra-weeks list (existence + dates), the week-label override, remarks, and each day's notes / tags / trade date / image meta — all synchronous memCache reads (initStorage has already resolved by the time the detail page renders). It returns `null` when nothing at all is stored for the id, so a bogus deep link still shows "Trade not found". The day's image is left `null`: the detail page loads the full image from storage on mount, the same as when navigation hands it no preloaded image.
- TradeDetail picks the day as: the last-visited day in this tab (`sessionStorage sb_last_day`, written when the trade is opened and when going back), then the first day with any content (chart, notes, tags or a date), then Monday.
- The rebuild is memoised (`useMemo` on `[state, id]`) so the trade's identity is stable across renders — effects that depend on `trade` must not re-run and clobber in-progress edits on every render.
- Found while fixing: on a fresh tab the chart never appeared even though the image was cached and the meta loaded — the chart container, the Original badge and the double-click-to-expand gate all depended on `chartImg` alone, and `chartImg` is only resolved at mount, where it is `null` on a reload/deep link (no preloaded image) while the medium/full tiers land later. A debug probe watched a fresh tab for 15s: image cached, meta loaded, dropzone shown the whole time. Fixed with a `hasChart` gate (any tier in hand: `chartImg || mediumImg || fullImg`); delete still clears all three tiers, so the gate closes instantly on delete. Self-inflicted along the way: the first placement of `hasChart` read `mediumImg`/`fullImg` before their declarations, which crashed the page blank with a `ReferenceError` (TDZ) — caught from the browser error, moved after all three tier states.
- Tests: 4 new Playwright specs in `tests/trade-reload.spec.js` — reload restores the trade and chart; deep link in a fresh tab (fresh sessionStorage) opens the trade on the first day with content; reload returns to the last-visited day (Tuesday); a bogus id still shows "Trade not found".

**Verification:** build passes, oxlint 0 errors (19 warnings — one fewer than the old 20), vitest 51/51, full Playwright suite 104/105 on the finished code, the single failure being the proven load flake below (never a bug-5 assertion). Flake investigation, done before pushing because the suite failed four times in a row: every failure was a different notes-images spec timing out on the notes-editor mount (the lazy-Quill chunk load under full-suite load), each passing in isolation (the file is 3/3 alone). To prove it was independent of bug 5, all bug-5 changes were reverted (files backed up to /tmp/bug5-backup with sha256 checksums; revert confirmed by grep) and the suite was run on the reverted code: 100/101, failing on the same notes-images:66 editor timeout. Bug 5 was then restored byte-for-byte (checksums verified) and re-verified (build, oxlint 0 errors, vitest 51/51, trade-reload 4/4). Pushed to main 2026-11-23 as commit a37f0f55b392fc461487d8ff6386abc1b99c95f4, verified on GitHub.

### Bug 6 — Failed image derivation silently stores the full-res image as the thumbnail (2026-11-23)
`createDerivative` returned `source` unchanged on every main-thread failure path, so its callers could not tell "derived OK" from "failed, here's your original back". Both thumb callers (`setStoredImg` fallback and the startup backfill in `loadThumbnails`) checked only `instanceof Blob`, so a failed thumb derivation persisted the full-res original as the "thumb" in IndexedDB + memCache and marked it `thumbKnown` — nothing ever retried. The medium callers already had the `!== source` guard, which is why only thumbs were affected. For string sources the bug never bit (a string fails `instanceof Blob` anyway).
- Fix (storage.js only): every main-thread failure `finish(source)` in `createDerivative` is now `finish(null)`, and the docstring states failure returns null. No call-site changes: a first idea (add `!== val` guards at the call sites) would have broken the round-2 eviction specs, which rely on the jsdom early return handing the source back so `setStoredImg` stores it as the thumb in tests — so the fix went into the derivation itself and both early returns (`!source`/no-document, jsdom UA) still return `source`. Result on failure: no thumb persisted, `thumbKnown` not set, the next startup's backfill retries; the grid keeps showing the full image via the existing memCache fallback.
- Tests: 2 new Playwright specs in `tests/derivative-failure.spec.js` — a corrupt upload stores the original but no thumb (`hasStoredThumb`/`hasThumbBlob` false, original retrievable); the startup backfill (corrupt image seeded straight into IndexedDB) does not persist the original as a thumb (IDB thumb key absent). Both proven to catch the bug by a negative control (old behaviour restored via sed: both failed; fix restored: both passed).

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, full Playwright suite 107/107 on the re-run. The first full run was 106/107 on `paint-before-thumbs` timing out under full-suite load (20 worker derivations of 2560×1440 images inside the test's 30s limit); the spec passes twice alone in ~10s and a debug probe showed all 20 thumbnails deriving fine on the new code — a load flake of the same class as the notes-images one, not a regression (the success path for valid images is untouched by this change). Push: attempted twice (2026-11-23 ~02:58 IST and ~03:57 IST); both times the approval card timed out before the user saw it, so the push was NOT performed. GitHub main is still at a37f0f55. It waits for the user's approval — do not retry unasked.

### Bug 7 — Stale async image continuations in TradeDetail resurrect / misplace charts (2026-11-23)
The image-load effect's `cancelled` flag is set only by the effect cleanup (unmount or dep change), which a delete never trips — the effect does not re-run for one. So a chart deleted while its full image was still loading reappeared ~100–500ms later when the in-flight continuation set `fullImg`/`mediumImg`, and `persistChart`'s medium continuation had no guard at all (an uploaded medium could land after the user moved to another day).
- Fix (TradeDetail.jsx only): an image generation epoch, `imgGenRef`. The load effect bumps it on each run and every continuation checks it (the `resolveMediumAsync`/`getStoredImgAsync` `.then` callbacks, and `preload`'s `onload`); `deleteChart` bumps it first, before clearing state; `persistChart` captures it at the start of an upload and checks it after each `await setStoredImg` and in `applyUpload`'s medium continuation. Real hole found while testing: `preload`'s `onload` checked the generation, but `img.decode()` is async and its `done` callback did not re-check — a delete landing between onload and decode-resolve let the stale tier through. Proved by a debug probe (storage empty after the delete, yet the container reappeared), then fixed by re-checking the generation inside `done`.
- The upload-then-navigate vector turned out to be unreachable in the current UI: moving between days always goes through the journal, which unmounts TradeDetail, so the stale setters belong to an unmounted component and are discarded (a control that removed the `persistChart` guards still passed). It stays fixed anyway — the prev/next-day arrows, if ever built, would navigate within the same component instance, where the guard is what stands between the upload and the wrong day.
- Tests: 1 new Playwright spec in `tests/stale-image.spec.js` — a chart deleted while its full image is still loading stays deleted (deep link, delete the moment the container appears, still gone after 3s and after a reload). Making it honest took several rounds: gradient chart PNGs compress to a few hundred KB and decode in ~50ms whatever their dimensions, so the full image always won the race against the delete click; CPU throttling backfired (it slows the render that reveals the container while the decode runs off-thread, unthrottled, and finishes first); a force click flaked (mousedown/mouseup landing on different elements when the layout shifted). What worked: a 4K noise PNG (every pixel random — large and slow to decode, ~1s, while the 1600px medium still lands in ~100ms) plus a tight in-page wait and a normal click. Negative control: with the `deleteChart` bump removed the spec fails 3/3 with the deleted chart reappearing; with the fix it passes 3/3.

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, full Playwright suite **108/108** (3.8m) on the finished code. Push: attempted 2026-11-23 ~03:57 IST, but the service restarted mid-push; GitHub main was checked immediately after and is still at a37f0f55, so the push was NOT performed. It waits for the user's approval — do not retry unasked.

### Bug 8 — Comment box swallows tool clicks/drags (2026-11-23)
The comment box's `onPointerDown` called `stopPropagation()` unconditionally, so with a draw tool active (line/arrow/pencil) a pointerdown starting on a comment box never reached the overlay's `onPointerDown` (which calls `placeAnnotation` / `startPencilDraw`) — the tool silently did nothing over a comment box.
- Fix (TradeDetail.jsx only): the handler now stops propagation **only when `annTool === 'select'`** (in select mode it prevents the container pan and is paired with the existing drag logic); for non-select tools the event bubbles to the overlay so the mark is placed / the pencil stroke starts, and the overlay `preventDefault`s, so the comment textarea never steals focus for the tool. The box's `onMouseDown` still stops unconditionally — no tool listens for mousedown, so it needs no change.
- Tests: 3 new Playwright specs in `tests/comment-tool-click.spec.js` — a line click starting on a comment box places the line; a pencil drag starting on a comment box draws a stroke; in select mode a click on a comment box places nothing and focuses the textarea. Negative control: on the unfixed code the line and pencil specs failed (0 marks placed), the select spec passed. Test lesson: the line lands at the click's y — the centre of the comment box, a little below its top edge — so the first version's assertion (top ≈ 30%, the placement point) got 34.6%; the spec now computes the expected top from the click coordinates.

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, comment-tool-click 3/3, full Playwright suite **111/111** (3.8m) on the finished code.

### Bug 9 — Dataset switch leaves a stale search / date filter (2026-11-23)
Switching datasets called `setSearch('')` but never cancelled the pending search-debounce timer, so a search typed just before the switch re-applied itself to the new dataset within 100ms — and the date filter was never reset at all, so it kept filtering the new dataset by the old one's dates.
- Fix (WeeklyJournal.jsx only): `handleSwitchDataset` now clears the search through `clearSearch()` (which cancels the pending timer and clears both the draft and the committed search) and resets the date filter (`setDateFilter(null)` + removing the `sb_date_filter` session key). The comment above the debounced search, which had documented the pending commit winning as if it were intended, now says the switch cancels it.
- Tests: 2 new Playwright specs in `tests/dataset-switch-filter.spec.js` — a search typed just before the switch (the switch is driven in-page, inside the 100ms debounce window) does not follow to the new dataset; an active date filter does not follow either (dot gone after the switch, and switching back shows the row again). Negative control: both specs failed on the unfixed code (search value re-appeared; the filter dot stayed).

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, dataset-switch-filter 2/2, full Playwright suite **114/121** on the finished code — the 7 failures are all specs for bugs not yet fixed (GoTo 2, duplicate-tags 1, shortcuts 3, object-URL 1), each failing on the unfixed code as designed; nothing else failed. (Bug 12's third spec — Ctrl+N outside any input — failed here only because the press landed during the loading screen, before WeeklyJournal's shortcut handler mounts; the spec now waits for the journal first.)

### Bug 10 — GoTo button silently does nothing on an incomplete form (2026-11-23)
The GoTo modal's "Go to" button called `onClose()` unconditionally — with no date picked, or only one end of a range, it closed the modal and applied nothing, with no hint why.
- Fix (WeeklyJournal.jsx only): the button is now `disabled` until the active tab's form is complete (`dateVal` on the Date tab, `rangeFrom && rangeTo` on the Custom range tab), with a dimmed, not-allowed style while disabled. The onClick guards stay as a second line of defence.
- Tests: 2 new Playwright specs in `tests/goto-modal.spec.js` — the Date tab stays disabled until a date is picked (then enables, applies, and the filter dot appears); the Custom range tab stays disabled with only From filled and enables once To is filled. Negative control: both specs failed on the unfixed code (the button was enabled with an empty form).

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, goto-modal 2/2, full Playwright suite **117/121** on the finished code — the 4 failures are all specs for bugs not yet fixed (duplicate-tags 1, shortcuts 2, object-URL 1), each failing on the unfixed code as designed; nothing else failed. Bug 12's third spec (Ctrl+N outside any input) now passes, confirming the timing fix in that spec.

### Bug 11 — Duplicate tags allowed (2026-11-23)
`addTag` took any tag, so "gapup" then "GapUp" landed as two chips (with colliding React keys), and `removeTag` then removed all matches at once.
- Fix (TradeDetail.jsx only): `addTag` now ignores a tag that already exists, compared case-insensitively, and still clears the input so the user isn't left holding the rejected text. `removeTag` is unchanged — it already removes all matches, which stays the consistent behaviour for any duplicates saved before this fix.
- Tests: 2 new Playwright specs in `tests/duplicate-tags.spec.js` — adding the same tag twice in different cases keeps one chip and clears the input; removing one tag keeps the other. Negative control: the duplicate spec failed on the unfixed code (2 chips), the remove spec already passed.

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, duplicate-tags 2/2, full Playwright suite **117/121** on the re-run — the 3 expected failures are the specs for bugs 12–13, which test not-yet-fixed code; the only other failure was the notes-images editor-mount flake (notes-images:66, `notes-editor` never visible within the 30s test timeout). Flake evidence, checked before accepting: the file passed 3/3 in isolation once, then failed 1/3 and 2/3 in two more isolated runs with the identical signature on *different* specs (:36, then :66) — a timing flake in the lazy-Quill mount, not a regression (bug 11 touches only `addTag`, which shares no code path with the editor mount, and a regression would fail the same spec deterministically).

### Bug 12 — Keyboard shortcuts fire while typing in inputs (2026-11-23)
The journal's window keydown handler checked only `ctrl` — Ctrl+N in the search box added a week, and Ctrl+= / Ctrl+- zoomed the grid mid-keystroke.
- Fix (WeeklyJournal.jsx only): the handler now returns early when the event target is an `INPUT`, a `TEXTAREA`, or a contentEditable element (which covers the Quill editor). Shortcuts outside any input are unchanged.
- Tests: 3 new Playwright specs in `tests/shortcuts-while-typing.spec.js` — Ctrl+N in the search box adds no week; Ctrl+= in the search box leaves the grid at 100% (label and stored zoom "1"); Ctrl+N outside any input still adds a week. Negative control: the first two specs failed on the unfixed code (a row was added; the zoom left 100%). Test lessons: a press during the loading screen misses the handler entirely (WeeklyJournal isn't mounted yet), so the third spec waits for the journal first; and `sb_zoom` is persisted as "1" on mount, so the zoom assertion compares against "1", not null — the first version asserted a bare Promise by mistake (`expect(page.evaluate(...))` without awaiting it).

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, shortcuts-while-typing 3/3, full Playwright suite **120/121** — the only failure was the bug-13 spec, which tests not-yet-fixed code.

### Bug 13 — Object URLs leaked by derivative generation (2026-11-23)
Two spots in storage.js created a blob: URL and never revoked it: `getImageDimensions`' `<img>` fallback (`img.src = URL.createObjectURL(blob)`) and `createDerivative`'s main-thread path (`img.src = URL.createObjectURL(source)` for Blob sources). One leaked URL per call, accumulating over a long session.
- Fix (storage.js only): `getImageDimensions` now revokes its URL on every exit — load, error, and the 1s timeout (a late onload/onerror after the timeout revokes again, which is a harmless no-op). `createDerivative` revokes inside `finish`, the single exit point — by then the pixels are already drawn to canvas, so the image no longer needs its URL; string sources create no URL and revoke nothing. The worker path creates no object URLs, and jsdom never reaches either spot, so this is only observable in a real browser.
- Test: 1 new Playwright spec in `tests/object-url-leaks.spec.js` — wraps `URL.revokeObjectURL` to record calls, then calls both functions directly in the page and asserts ≥2 blob: URLs were revoked (one from each function). Negative control: with the fix reverted the spec fails (1 revoked URL); fix restored byte-for-byte (sha256 verified), spec passes. Test lessons: in a real browser `getImageDimensions` takes the `createImageBitmap` path (no URL), so the spec hides `createImageBitmap` for one call to exercise the `<img>` fallback; `createDerivative` takes the worker path when one exists (no URL), so the spec hides `Worker` for the call to force the main-thread path — the first version of the spec expected ≥2 without forcing either path and failed 1-vs-2 on the fixed code, which is what exposed the worker-path masking.

**Verification:** build passes, oxlint 0 errors (19 warnings), vitest 51/51, object-url-leaks 1/1, full Playwright suite **121/121** — all specs green, including every bug-6–13 spec.

## Performance round (2026-11-23)

User approved the 5-item list from the 2026-11-22 scan, in impact order, one step at a time with the same per-step verification as the bug round (build, oxlint, vitest, full Playwright suite, commit per step, exe at the end).

### Perf 1 — No node_modules in the exe (2026-11-23)
The asar shipped 5,334 node_modules entries (52 MB) even though `main.cjs` requires only electron/fs/path and the whole renderer is Vite-bundled into dist. Measured first: the entries span all of `dependencies` (react, quill, tailwindcss, lodash, caniuse-lite, …), not just the build-only ones.
- Fix (package.json only): `tailwindcss`, `postcss`, `autoprefixer`, `@tailwindcss/forms` moved from `dependencies` to `devDependencies` via `npm install --save-dev` (lockfile updated by npm, from cache), and `"!**/node_modules/**"` added to the electron-builder `files` list (which already allowlisted only `dist/**/*` + `main.cjs` — the allowlist alone did not keep node_modules out). No app code changed.
- Verification: Win exe **100,037,202 bytes** (was 106,827,363 — 6,790,161 bytes smaller; the scan's ~96 MB estimate was close, the node_modules content compressed to ~6.8 MB in the exe). Asar: **0 node_modules entries**, /dist/ matches the disk build (only the known `/dist/assets` directory entry differs). Packaged launch proven: a Linux build from the same asar was run under Xvfb and its DevTools endpoint showed the page at `file:///.../app.asar/dist/index.html`, title "Snowball — Trading Journal" — the file path, not the dev server. (Two test artefacts, not app bugs: running Electron as root needs `--no-sandbox`, and running an unpacked app loads the dev URL because `isPackaged` is false — the asar run is the real check. The first packaged-launch attempt also self-killed via a `pkill` pattern that matched the shell's own command line.) oxlint 0 errors (19 warnings), vitest 51/51. Full Playwright suite 121/121.

### Perf 2 — Evict medium/full-res image URLs + LRU-cap the medium cache (2026-11-23)
Detail-page images kept their object URLs alive after leaving the page, and every medium ever created stayed cached, so a long session accumulated live image URLs. (storage.js + TradeDetail.jsx)
- Fix: medium URLs are LRU-capped at 20 (`MEDIUM_URL_CACHE_MAX = 20`, `mediumLru` Map in insertion order, `cacheMediumUrl` routes every medium-URL creation site, cache hits touch the LRU, `evictOldMediumUrls` revokes+deletes the least-recently-used past 20 — only when memCache still holds the tracked blob: URL). `evictDetailImageUrls(weekId, dayName)` is exported and called from TradeDetail's image-load effect cleanup (unmount + day change), revoking that day's img_/med_ URLs unless 'DELETED'. LRU bookkeeping is also cleaned on delete/clear/week-delete and the initStorage memCache clear. Evicted mediums re-create from IndexedDB on demand — no data loss.
- New spec: tests/medium-eviction.spec.js (2 specs). Spec 1 seeds 6 non-adjacent days (non-adjacent so `preloadNeighbourImages` can never re-create a visited day's medium, keeping counts deterministic), visits each detail, and asserts both tiers are cached during the visit and evicted after back-nav. Spec 2 seeds 25 days (5 weeks × Mon–Fri), asserts exactly the last 20 mediums stay cached after the upload path AND after a reload + `resolveMediumAsync` loop, and that an evicted medium re-creates from IndexedDB.
- Negative controls (both passed): spec 1 failed with the eviction call commented out ("Monday medium still cached after leaving"); spec 2 failed with the cap temporarily 1000 (25 cached, expected 20). Fix restored (cap = 20, eviction call present, no temp markers).
- Verification: vitest 51/51, oxlint 0 errors (19 warnings), full Playwright suite 123/123 (a runtime restart wiped the first full-suite run; code was verified intact and the suite re-run).

### Perf 3 — Debounce notes/remarks autosave (2026-11-23)
Every keystroke in the notes or remarks queued a whole-week-document IndexedDB write, so a burst of typing fired a write per edit. (storage.js + TradeDetail.jsx + WeeklyJournal.jsx)
- Fix: week-doc saves are trailing-debounced 500ms (`WEEK_SAVE_DEBOUNCE_MS = 500`, `weekSaveTimers` Map; `scheduleWeekSave` now only bumps the search version and (re)sets the timer; `firePendingSave` runs the same write chain as before). Flushes happen on TradeDetail unmount, RemarksModal close, and through all existing `flushAllWeekDocs` callers, so nothing is ever lost by navigating away. Unload safety net: `flushPendingWeekSavesSync()` (beforeunload + visibilitychange-hidden, registered once from initStorage) clears pending timers and writes the docs synchronously up to the first await — and because an IDB write started during unload does not reliably commit under load (proven by a spec that kept failing with an empty editor after a reload), it first stashes the pending docs in localStorage (`sb_pending_week_saves`, via `stashPendingWeekSavesSync` + `buildWeekDoc`), and `replayPendingWeekSaves()` at the top of initStorage writes the stash into IDB on the next load and removes the key only after a successful replay (a parse failure removes it; a write failure keeps it for a retry).
- Tests: new vitest src/data/storage-debounce.test.js (3 tests): 20 notes edits interleaved ~60ms apart → 0 wk_ puts immediately, exactly 1 put after the debounce, with the last text; `flushAllWeekDocs` writes immediately with no second write; notes survive a `beforeunload` dispatch + re-`initStorage` (stash+replay). New Playwright spec tests/autosave-debounce.spec.js (3 specs): 20 keystrokes → exactly 1 wk_ put (counted via an `IDBObjectStore.prototype.put` init-script patch), and the put doc contains the typed text; type → click back immediately → the unmount flush's put lands within 300ms → reload → reopen → text intact; type → `page.reload()` immediately → editor contains the text. All 3 use `test.setTimeout(120000)` inside the body (the `{ timeout }` 2nd-arg form does not take effect in this repo).
- Negative control (passed): with `scheduleWeekSave` temporarily reverted to the old immediate-queue version, the interleaved vitest failed with "expected 20 to be +0" (20 puts for 20 spread-out edits). An earlier attempt with a *synchronous* burst did NOT fail on the old code (the old chain coalesces same-tick edits) — hence the interleaved design. Fix restored.
- Test lessons (2026-11-23): the `notes-editor` testid is on Quill's ROOT element itself (it IS `.ql-editor`) — never query a `.ql-editor` descendant; `ensureNotesEditor` has a post-reload race (after a reload the app is still mounting, so the one-shot placeholder grab finds nothing and the lazy editor never mounts) — the shared helper now waits for the notes section (editor OR placeholder) to attach before the grab, and its waits were raised to 30s because the first mount in a run pays the cold Vite transform of the detail-page + Quill chunks under load (notes-images spec 1 also got `test.setTimeout(120000)`); counting wk_ puts in Playwright works by patching `IDBObjectStore.prototype.put` via `addInitScript` (idb-keyval's `set` calls `store.put(value, key)`, key is the 2nd arg).
- Verification: vitest 54/54 (3 files, incl. the 3 new debounce tests), oxlint 0 errors (19 warnings), full Playwright suite 126/126 (the first two full runs after the change were interrupted by runtime restarts / showed load flakes — backup-roundtrip overlay click, hover-preload medium preloaded on a quick pass, paint-before-thumbs 0 imgs after 60s — all three passed in isolation; the notes-images editor-mount flake was a real helper race, fixed as above; the re-run count is 126/126).

### Perf 4 — Backup import no longer freezes the UI (2026-11-24)
Importing a backup did the whole parse + validation + base64 decode synchronously on the main thread (`importDatabase` in storage.js): a synchronous `JSON.parse` of the whole backup, then `dataURLtoBlob` (atob) for every image. The export path's own comment notes a single `JSON.stringify` on 100 MB of base64 can freeze for 3+ seconds; the import side was the same shape. (src/data/backupParse.js [new] + src/data/storage.js + src/workers/imageWorker.js + src/pages/WeeklyJournal.jsx)
- Measured first (Node probes + in-browser probes, 2026-11-24): `JSON.parse` costs ~1ms/MB (a 161 MB backup parses in ~85 ms — so the parse alone is NOT the seconds-long freeze; the atob decode of ~150 MB of base64 is the bulk of it). Synthetic `makeChartPng(2560,1440)` is only 39,918 bytes (its grid pattern deflates well), so synthetic-chart backups badly understate real import sizes — a responsiveness spec needs noise data (random pixels don't compress) to reach a realistic backup size.
- Fix: the parse + validation + normalise + image-decode moved into the image worker, sharing one pure module so the bug-1 guarantees are identical on both paths. New `src/data/backupParse.js` (pure, no DOM/IDB imports) exports `dataURLtoBlob` (moved verbatim from storage.js) and `parseBackup(jsonString, { currentDataset, datasets, defaultDatasetId })` (async): JSON.parse → array/pair/`sb_` shape checks (same errors as the old import) → normalise (whole-DB / single-dataset-marker / legacy branches copied verbatim, parameterised) → split image/other (image = string value starting `data:image`, thumbs `__thumb_` excluded) → decode each image with `dataURLtoBlob` (same 'corrupted (bad base64 data)' / 'is empty' errors naming the key; yields every 20 images via setTimeout 0) → returns `{ otherEntries, imageBlobs, importTargetId, wipeAll, wipePrefix }`. `src/workers/imageWorker.js` imports it and answers a third message `{ id, parseBackup: true, buffer, ... }` — a parse failure answers `{ id, parseError }` (not `error`), so the caller surfaces it with NO fallback (the backup is invalid); a transport failure still answers `{ id, error }` and the caller falls back. `importDatabase` now takes a **Blob or a string**: a string is parsed on the main thread via the shared `parseBackup` (existing string callers — vitest, week-docs / paint-before-thumbs / lazy-thumb-urls / hover-preload specs — are unchanged); a Blob's bytes are read with `arrayBuffer()` and **TRANSFERRED** to the worker (see the redesign note below), and the fallback re-reads the Blob as text (the transfer only detaches the ArrayBuffer copy, the Blob itself is unaffected, so a worker failure still imports correctly). `callWorker` gained an optional `transfer` list for `postMessage`. `flushAllWeekDocs()` still runs after the (now fully validated) parse and before the wipe, so a failed import changes nothing. `handleImport` passes the File itself instead of `file.text()`.
- Redesign (the first version failed its own spec): the first cut sent the backup to the worker as a **string**. The responsiveness spec then failed with max rAF gap **2766.5 ms** (threshold 100 ms). Probes on a 161 MB backup showed why: `JSON.parse` 85 ms, `postMessage` structured-clone of the string **321 ms**, `TextEncoder.encode` **1425 ms**, `TextDecoder.decode` 141 ms, ArrayBuffer **transfer 28 ms**. So the string clone alone is a ~300 ms main-thread block — the very freeze this step removes — and `TextEncoder` on the main thread is far worse. A phase-isolation probe (worker parse round-trip / IDB writes / initStorage, each measured separately) showed no single phase blocking: worker parse maxGap 83 ms (wall ~2 s, off-thread), IDB writes 10 ms, initStorage 0 ms. Adding the spec's baseline `JSON.parse` before the phases raised the worker-parse gap to ~300 ms — the baseline parse leaves ~160 MB of garbage and a major GC can land during the import. The fix is the transfer: the main thread never holds or clones the huge string — the File's bytes move to the worker zero-copy, and the worker does the `TextDecoder` + parse off-thread. The spec was also split into two tests on fresh pages (one proves the backup is big enough to discriminate, the other measures the import) so the baseline parse's garbage can't pollute the measurement, and it passes a Blob instead of a string. A latent spec bug was found and fixed along the way: the data check read `img.size` off `getStoredImgAsync`, which returns a `blob:` URL, not a Blob — the check now fetches the URL and measures the Blob.
- New spec: tests/import-responsiveness.spec.js (2 tests, shared `buildBackup` helper: one 1280×720 noise chart, ~2.7 MB PNG, reused across 40 days → ~161 MB backup, stored on `window` as a Blob). Test 1 asserts the backup is > 100 MB and its direct `JSON.parse` takes > 120 ms (fails loudly if the backup is too small to discriminate). Test 2 imports it while recording rAF gaps and asserts frames > 10 and maxGap < 100 ms, then checks the data landed (fetched image Blob > 1,000,000 bytes, week label 'Week 0', 1 dataset).
- Negative control (passed): with `window.Worker` hidden via `addInitScript` (forcing the main-thread fallback), the import test failed on maxGap — **816.6 ms** — while the real path passes at **50.1 ms**. So the spec genuinely discriminates the worker path from the fallback. Temp control spec deleted after the run.
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64 (4 files, incl. the 10 new backupParse tests in src/data/backupParse.test.js: whole-DB / single-dataset / legacy shapes, corrupt JSON, non-array, bad pair shape, no `sb_` keys, mixed datasets, corrupt + empty images, thumbs skipped). Responsiveness spec 2/2 passed, maxGap **50.1 ms**, frames 99. Full Playwright suite **128/128 (4.3m)** — the first two runs after the change were 126/128: the baseline test's 120 ms threshold was too tight for a parse that measures ~85–115 ms (lowered to 50 ms — the > 100 MB size check is the real guard), and the notes-images editor mount takes longer than 30 s under full-suite load (the shared helper's editor-visible wait was raised 30 s → 60 s and the two specs without a 120 s timeout got one; both failures passed in isolation at 5/5, confirming load flakes, not a regression). The re-run count is 128/128.

### Perf 5 — Scroll-back no longer flashes the full-res image (2026-11-24)
After round-2 improvement 4 evicted a row's thumb Blob (30 s after it scrolled off-screen), scrolling back briefly showed the FULL-RES image while the thumb reloaded: `getStoredThumb` fell back to the cached `img_` URL when no thumb was in memCache, so the grid decoded a huge chart — the scroll jank the whole thumbnail tier exists to avoid — and flashed it for the ~10–50 ms the thumb reload takes. (src/data/storage.js only)
- Fix: one guard in `getStoredThumb`, before the `img_` fallback: `if (thumbKnown.has(thumbKey(weekId, dayName))) return null;`. A thumb known to exist in IndexedDB but evicted from memCache now reads back as null, so the cell holds its placeholder; the DayCell effect already calls `loadThumb` in exactly this case, and `notifyThumbs` re-renders the cell when the thumb is back (an IndexedDB read, ~10–50 ms). The full-res fallback stays for cells whose thumb was never created (legacy images, backfill pending) — there `thumbKnown` has no key, so the fallback still applies and nothing is visually missing at startup.
- New spec: tests/scrollback-placeholder.spec.js (1 test). Seeds 20 weeks so the journal actually scrolls (at 100% zoom a row is ~94px, so 6 rows fit the 720px viewport and scrolling never unmounts the first row — with 20 rows it does, which is what schedules the eviction), seeds a 2560×1440 gradient chart on the first week's Monday, scrolls to the bottom and back so the cell remounts and picks up the 480px thumb, asserts naturalWidth 480, scrolls out (unmount → cleanup revokes the thumb URL and schedules the 30 s eviction), forces the eviction with `scheduleThumbEviction(weekId, 'Monday', 0)` + 100 ms, asserts in-page `{ getStoredThumb === null, hasStoredThumb === true, hasThumbBlob === false }`, then starts a 5 ms interval recorder of the cell img's naturalWidth, scrolls back to the top, and asserts the cell recovers to 480 and the recorder never saw 2560.
- Spec failures on the way (both are real lessons, not flakiness): (1) with only 6 weeks the `toHaveCount(0)` after scrolling failed — the row never unmounted. Raised to 20 weeks. (2) After a `page.reload()` the naturalWidth-480 poll timed out even though storage reported thumb/known/hasBlob all true. Probes showed the journal had auto-scrolled to the bottom and saved `sb_scroll_top` ≈ 1707 in sessionStorage, so the reload restored that position and the top row was unmounted — the fix was to clear the saved scroll keys before reloading. But the deeper problem was the reload itself (see the negative-control note): the first version of the spec, with the reload, PASSED even with the guard removed.
- Negative control — the first attempt did NOT discriminate, and catching that matters: with the guard commented out, the spec still passed 1/1 (8.9s). Root cause, proven by probes: after a reload the full-res `img_` is NOT in memCache (`getStoredImg` → null — only thumbs are loaded by `loadThumbnails`, and the backfill only caches full-res URLs for images WITHOUT thumbs), so the `img_` fallback had nothing to return and the `after === null` assertion passed vacuously. The spec was rewritten with NO reload: the chart is seeded in-page (`setStoredImg` caches the full-res URL in memCache under `img_`, which is the real upload-session state where the flash happens), the row is remounted by scrolling so the cell picks up the thumb, then the eviction is forced and the scroll-back measured. The redo negative control PASSED properly: with the guard removed the spec failed, `getStoredThumb` returning the full-res `blob:` URL instead of null. Guard restored (verified: 2 occurrences of `thumbKnown.has(thumbKey`, no TEMP markers) and the spec passes again 1/1 (8.5s).
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64, full Playwright suite **129/129 (4.3m)**. The first two full runs after the change were 128/129, both on the known notes-images spec 1 editor-mount load flake (editor never visible within the 60 s wait under full-suite load; perf 5 does not touch the notes editor, and the spec passes 3/3 in isolation at 12.1s). The third full run is green at 129/129.

## Insert a row above/below from the Week column (2026-11-24)

- Request: right-click a cell in the Week column → "Add above" / "Add below" inserts a new empty week directly above or below that row, between it and its neighbour. The menu is matte black with bold white text, matching the header buttons.
- Implementation (WeeklyJournal.jsx only; no storage change — row order is the order of the `extra_weeks` array, so insertion is a splice):
  - `createEmptyWeek()` (module level) builds the same empty week the + button creates; `addRow` now uses it too, so a row added either way is identical.
  - `insertRow(weekId, position)` finds the row's index in `getExtraWeeks()`, splices the new week at `index` (above) or `index + 1` (below), then the same discipline as `addRow`: `setExtraWeeks` + `setAllTrades`, UI updated instantly from memory, the IndexedDB write awaited. Scrolls the new row into view only if it landed off-screen (`scrollIntoView` `block: 'nearest'`).
  - The Week label cell (`week-label-<id>`) has an `onContextMenu` handler, passed to the memoised `WeekRow` as `onWeekContextMenu`. Right-clicks on the Month/Dates inputs return early, so they keep the browser's native text menu (cut/copy/paste); everywhere else in the cell opens the custom menu at the cursor, clamped into the viewport.
  - The menu is one `fixed` div at journal level (outside Virtuoso, so virtualization never unmounts it): two pill buttons (`rounded-full`, hairline `#424242` border so the round edges read even at rest, bold white text, hover `#2f2f2f`) with a hairline divider between them. The menu sizes to its labels — no fixed width. It closes on an outside press, Escape, any scroll, or a right-click that is not on another Week cell (that one re-opens the menu at the new cell).
  - The look went through two demo rounds from real screenshots of the running app (not generated mockups): round 1 had full-width buttons with labels "Add row above" / "Add row below"; the user asked to shrink the space, round the edges and drop "row" from the labels; round 2 had compact `py-1.5` pills labelled "Add above" / "Add below", but the round edges were invisible (black buttons on a black menu), and the menu was still 200px wide; the final version adds the hairline pill border and drops the fixed width, so the menu is only as wide as the labels need. Screenshots in ~/workspace/your_files/snowball-insert-row-menu.png.
- New spec: tests/insert-row.spec.js (4 tests). Seeds 3 labelled weeks, then: "Add above" on the middle row puts the new empty week at position 2 with the other three in order, and the order survives a reload; "Add below" on the first row puts it at position 2; "Add below" on the last row appends at the end; the menu closes on Escape and on an outside click, and a right-click on the Month input opens no custom menu.
- Spec failure on the way: the "Add above" test's post-reload order check read `[]` — the `page.evaluate` ran while the page still showed "Loading journal…", before `initStorage` had filled memCache. Fixed by waiting for the first row's label to be visible after the reload (same wait the seed helper already uses).
- Negative control PASSED: with the splice temporarily replaced by `push` (always append), the "Add above" test failed; fix restored (verified: `next.splice(position` present, no TEMP markers) and the spec passes 4/4.
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64, insert-row spec 4/4, full Playwright suite **133/133 (4.5m)**. The first full run was 132/133 on the known notes-images spec 1 editor-mount load flake (editor never visible within the 60 s wait under load; the spec passes 3/3 in isolation); the re-run is green. Pushed to main as commit 4478916af8eec4807dabd2f7edb7e0c5d56e629e. New Windows exe (100,039,111 bytes, asar verified — 24 /dist/ entries vs 23 disk, 0 node_modules) built and uploaded to Drive, replacing the file at the same link (file id 1xJkjEqCcsfwAYZHa1rKCR7h2rDAeZrtM).

## Download the fullscreen chart with its markers as a full-quality PNG (2026-11-24)

- Request: a download button in the fullscreen chart (the lightbox), near the close button, that downloads the chart without reducing the quality, with the markers added via the toolbar included. Format was left to the assistant; the user asked for a report first, then a screenshot, then — on the question of where it saves — "ask every time".
- Format verdict: **PNG** (lossless). JPG would re-compress and smudge chart lines/text; a PDF would only wrap the same raster image. A JPEG original loses nothing further in a PNG export (its pixels are preserved); a PNG original is pixel-identical plus the marks. With marks the file cannot be byte-identical to the original.
- Method: **native-resolution canvas compositing from the stored original — never a screenshot.** A screenshot would cap at screen size and bake in the toolbar, crosshairs and zoom controls. The export draws the original at its natural size onto a canvas and re-draws each mark from its stored % coordinates, scaled to native size. The toolbar, crosshair lines, zoom controls and selection highlights (amber line, resize handles, delete ×) are excluded; pan/zoom state does not affect the export. No chart → no button; no marks → the chart alone at full quality.
- Implementation (new `src/data/exportChart.js` + `src/pages/TradeDetail.jsx`):
  - `exportChartPng(img, annotations, displayedWidth)` → Promise<Blob> (PNG), plus exported `drawAnnotation(ctx, ann, W, H, scale)`. Canvas is `img.naturalWidth × img.naturalHeight`; `scale = naturalWidth / displayedWidth`. Line: 2·scale black filled rect + shadow (rgba(0,0,0,0.65), blur 4·scale, offsetY 1·scale). Arrows: polygons from the AnnArrow viewBox point sets (up: [12,1],[21,13],[15.5,13],[15.5,31],[8.5,31],[8.5,13],[3,13]; down: mirrored), width 26·scale, height (26·32/24)·scale, anchored up → top edge at y%, down → bottom edge at y%, centred horizontally, fill colour + rgba(0,0,0,0.5) stroke + drop shadow. Comment: **skipped entirely when its text is empty**; otherwise box at (x%, y%), width `(a.w ?? 180)·scale`, height `a.h·scale` or auto from wrapped lines clamped to [48, 200]·scale; fill rgba(0,0,0,0.85), border rgba(255,255,255,0.4), radius 4·scale, padding 8·scale, font `700 ${13·scale}px Inter, sans-serif`, line-height 13·1.5·scale, word-wrap via measureText, text clipped to the box. Pencil: white polyline 8·scale under black polyline 4.5·scale, round caps/joins; a single-point stroke draws a dot (white r=4·scale, black r=2.25·scale).
  - The button (`data-testid="chart-download-btn"`, `download` Material Symbols icon) sits immediately left of the close button (`absolute top-4 right-16`, 8px gap), same 40px circle and styling as the close button, rendered only when `hasChart`. Its look was shown to the user first as a real screenshot of the running app (`~/workspace/your_files/snowball-download-btn.png`) and approved.
  - `downloadChart` (useCallback, after `persistAnnotations`): returns early unless `hasChart && picRect`; loads the ORIGINAL via `getStoredImgAsync(weekId, dayName)` into a fresh `Image`, `await img.decode()`, composites with `picRect.width`, then **asks every time**: the native Save As dialog (`window.showSaveFilePicker`, suggested name `Snowball <weekStart> <weekEnd> <dayName>.png`, sanitized, PNG-only filter) — so the user picks the folder and filename on each download. If the dialog API is unavailable it falls back to a plain anchor download into the Downloads folder, the way the backup export already does. Cancelling the dialog (AbortError) or a failed export leaves the lightbox exactly as it was (caught silently).
- New spec: tests/chart-download.spec.js (3 tests). Seeds a 2560×1440 chart, places one of every mark (line, green up arrow, comment with text, pencil stroke), then: (1) the Save As path produces a 2560×1440 PNG whose pixels prove every mark is baked in — darkest pixel in the line's column ≤ 6 (pure black), > 50 green-arrow pixels, > 20 white comment-text pixels, > 100 white pencil-edge pixels (fixture background is rgb(10,10,10), grid lines rgb(74,143,255), so all four are distinguishable); also asserts the suggested name matches `Snowball *.png` and the PNG-only filter. (2) Cancelling the dialog leaves the lightbox open with all 4 marks. (3) With `showSaveFilePicker` undefined, the fallback fires a real `download` event with the same suggested name and the same full-size PNG + pixel checks.
- Headless-dialog lesson (proven by two probes, 2026-11-24): headless Chromium cannot show the picker — `showSaveFilePicker` is called correctly (suggestedName `Snowball Monday.png`) and Chrome itself aborts it immediately (AbortError, "The user aborted a request"), so no `filechooser` event ever fires and the dialog cannot be driven in a test. The first test therefore stubs only the picker (the OS UI, not app code) with a fake handle that captures the blob the app hands it; the PNG is then verified byte-for-byte from disk, exactly as a real save would write it. In a real browser and in the Electron app (Electron 44 / Chromium 134, File System Access API supported in the renderer) the native dialog appears.
- Negative control PASSED: with the annotation loop in `exportChartPng` commented out, the two pixel-checking tests failed and the cancel test still passed; the file was restored byte-for-byte (sha256 `0d0198374263ae9e1cfca32307135daf5daefcede3e2bc3c5a6614da75d4b1fe` before and after).
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64, download spec 3/3, full Playwright suite **135/136** — three consecutive runs, each 135 passed with the same single failure, notes-images spec 1 (`notes-editor` never visible within the 120 s wait), the known editor-mount load flake; it passes in isolation in 8.0 s and the download change does not touch the notes editor. Pushed to main as commit 37a3515a7a160947454c4ca5fded795bc1e7b9a6.

## Previous / next day arrows on the notes page (2026-11-26)

- Request: previous / next day arrows on the detail (notes) page, with a screenshot first to see how they look. This is detail-page idea (1) of the six proposed 2026-11-19; plan-vs-review notes, one-tap outcome + points, same-tag history and export-this-day are still unbuilt.
- Placement went through two screenshot rounds from the real running app: round 1 had the arrows flanking the day name in the header (`‹ Wednesday ›`); the user asked for them in the space between the chart's sides and the page margin, like the Back button; round 2 put them on the chart itself (absolute, over the image edges); the user corrected that too — they belong in the margins, not on the chart. Final: two fixed circles, one in each margin gutter (`fixed left-4 md:left-6` / `right-4 md:right-6`, `top-1/2 -translate-y-1/2`, `z-40`), same translucent style as the Back button (`bg-[#212121]/50 backdrop-blur-md border border-[#424242]/50`), so they never cover the chart and stay put while the page scrolls. They sit under the lightbox (z-40 vs z-[60]), so they can't be hit while the fullscreen chart is open. Screenshot in ~/workspace/your_files/snowball-day-nav.png.
- Size/style: 48px circles (w-12 h-12), chevron icons 26px, **thick and white** as the user asked — `text-white` plus `fontVariationSettings: "'FILL' 0, 'wght' 700"` on the button (inherited by the icon). The weight style lives on the button, not the icon span: the font-subset scanner (`scripts/subset-font.cjs`) treats any single-quoted lowercase word inside a `material-symbols-outlined … </span>` match as an icon name, so `'wght'` on the span made `decode-font` fail the dev server ("icons used in src but not in the subset font: wght") — moving it to the button fixed the build with no font change.
- Behaviour (TradeDetail.jsx + trades.js): `DAYS` is now exported from trades.js. `dayList = getExtraWeeks().flatMap(w => DAYS.map(d => ({ weekId: w.id, day: d })))` — grid order, Mon–Fri week by week, empty days included. `prevDay`/`nextDay` are null at the ends and the buttons disable there (`disabled:opacity-30`). `goToDay(target)` rebuilds the target week with `getTradeById`, sets sessionStorage `sb_last_week_id`/`sb_last_day`, and navigates to `/trade/<weekId>` with the same router state `goToDetail` sends (the target day's `img` is null — the image effect loads it from storage, same as a deep link). **No URL change**: the route stays `/trade/<weekId>`, the day travels in router state + sessionStorage, so a reload lands on the new day and Back returns to the right cell. Nothing is lost moving days: the existing day-change effects re-load chart/notes/tags/annotations/date, and the notes autosave timer is module-level. Not in this step: arrows inside the fullscreen lightbox, keyboard left/right.
- Font: the two chevron icons (`chevron_left`, `chevron_right`) were added to the subset first (`node scripts/subset-font.cjs` — 24 icons, subset font 5,904 bytes); the regenerated `src/assets/fonts/material-symbols-outlined.woff2`, `material-symbols-outlined.subset.woff2.b64` and `scripts/material-symbols-icons.txt` are part of this change.
- New spec: tests/day-navigation.spec.js (6 tests). Seeds 2 labelled weeks, then: next steps forward within the week and prev steps back; next on Friday crosses to Monday of the next week (URL changes week) and prev crosses back; prev disabled on the first week's Monday, next disabled on the last week's Friday; a reload after navigating lands on the new day; the chart follows the day (2560×1440 uploaded on Wednesday, 1280×720 on Thursday, Original badge proves which is shown); the notes follow the day (seeded via `setNotes` + `flushWeekDoc`, editor text swaps from the Wednesday marker to the Thursday marker).
- Spec failure on the way: all 6 failed on the first run — `openDay` used a single `.click()` on the day cell, but journal cells open the detail page on **double-click** (`onDoubleClick={goToDetail}`); fixed to `.dblclick()`, then 6/6.
- Negative control PASSED: with the `navigate(...)` call in `goToDay` commented out, the first spec failed; restored byte-for-byte (sha256 `fcbd5dc1d693bc100a1c2f79c792933afab92b04c2c185e3974ebef7382b4a6b` before and after).
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64, day-navigation spec 6/6, full Playwright suite **142/142 (5.0m)** on the re-run. The first full run was 141/142 on the known notes-images editor-mount load flake — this time spec 2 ("right-click selects the picture"), `notes-editor` never visible within the wait at helpers/notes-editor.js:40; it failed once in isolation (126 s, full test timeout) then passed in isolation in 7.9 s, and the re-run is green, so it is the same flake class, not a regression (the change does not touch the notes editor). Pushed to main as commit 083f5cd3d760cbfdd398b27d472fd0069efc3a67. New Windows exe (100,040,111 bytes, asar verified — 24 /dist/ entries vs 23 disk, 0 node_modules) built and uploaded to Drive, replacing the file at the same link (file id 1xJkjEqCcsfwAYZHa1rKCR7h2rDAeZrtM).

## Compact detail-page header, matte black date / day / tags (2026-11-27)

- Request: on the notes page, shrink the extra space in the top area where the date, day and tag sit, make them fit comfortably, remove the excess area — and give the date, day and tag texts the button theme: matte black with thick white font. Screenshot first.
- What was eating the space (measured, not guessed): the panel's top padding was 32px (`p-xl`), the header rows were 12px apart (`gap-3`), the date pill was `py-1.5`, and the tag input was 40px tall on its own — the @tailwindcss/forms plugin gives text inputs 8px vertical padding by default, and nothing had overridden it, so the empty tags row was the tallest thing in the header. The header block measured 83px before (30px date row + 6 + 40px tags row + 6 + 1px divider) with the chart ~125px+ below the panel top.
- Changes (TradeDetail.jsx only, header block): panel top padding 32px → 16px (`p-xl` → `px-xl pt-4 pb-xl`; sides and bottom untouched); header rows 12px → 6px apart (`gap-3` → `gap-1.5`); the chart is pulled 8px up under the divider (`-mb-2` on the header block, against the main `gap-md` of 16px); date pill `px-3 py-1.5` → `px-2.5 py-1`; tag chips `py-1` → `py-0.5`; the Add-tag input gets `p-0` (kills the forms-plugin padding — the tags row drops 40px → ~24px). After: the header measures **71px** with a tag chip present, the chart top sits **96px** below the panel top.
- Styling — the same matte-black + bold-white as the header buttons: date pill `bg-[#000000] text-white font-bold border border-[#424242] hover:bg-[#1a1a1a]` (was `bg-surface-container-high`, grey text); day name `text-white font-bold` (was `text-on-surface`, weight 500); tag chips `bg-[#000000] text-white font-bold border border-[#424242]` (was `bg-surface-variant`, grey text) with the × in `text-white/60 hover:text-white`; the Add-tag input types in white bold (placeholder stays muted). The "Saved ✓" status, the "·" separator and everything below the chart are untouched. The look was shown to the user as a real screenshot of the running app (`~/workspace/your_files/snowball-header-compact.png`) and approved.
- New spec: tests/compact-header.spec.js (2 tests, new `data-testid="detail-header"` on the header block). (1) Computed styles: date pill bg rgb(0,0,0) / white / weight 700, day name white / 700, tag chip bg rgb(0,0,0) / white / 700. (2) Compactness: header height < 75px and chart-top-minus-panel-top < 110px, measured with a real chart seeded.
- Spec failure on the way: the compactness test first measured 83px, not the ~65px estimated — a probe showed the tags row alone was 40px (the forms-plugin input padding above), which is what `p-0` on the input fixes; the spec then passed 2/2. The tag-chip assertion also needed the duplicate-tags locator (`div:has(> input[placeholder="Add tag..."]) > span` with hasText) — an exact-text lookup fails because the chip's text content includes the × button's icon text.
- Negative control PASSED: with the date pill reverted to `bg-surface-container-high` (no white/bold), the styling spec failed; restored byte-for-byte (sha256 `03ddf51751b9a8dbb42e07a0317ceb13576a98853d63b8862fb6af03241af950` before and after).
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64, compact-header spec 2/2, full Playwright suite 143/144 on the re-run — the single failure is the known notes-images spec 2 editor-mount load flake (already proven to pass in isolation in this same round). The first full run was 142/144: the import-responsiveness spec (maxGap 583ms vs its <100ms threshold) plus the same notes-images flake; both passed in isolation (import maxGap 66.7ms), and the import spec passed on the re-run — load flakes under full-suite load, same class as before. The change touches neither the import path nor the notes editor. Pushed to main as commit c02d0ce817417e89cf863c914c7c56a6bbd69be9, verified on GitHub. New Windows exe (100,040,204 bytes, asar verified — 24 /dist/ entries vs 23 disk, 0 node_modules) built and uploaded to Drive, replacing the file at the same link (file id 1xJkjEqCcsfwAYZHa1rKCR7h2rDAeZrtM).

## Rounded comment box corners, single perimeter (2026-11-27)

- Request: the corners of the comment box added from the toolbar should be a little curved, like the toolbar box on the zoomed chart (lightbox). Screenshot first. Then, on seeing the screenshot, the user asked why there was a shadow second box behind it — and then ruled: one perimeter only, blue while typing or selected, white when unselected, never two overlapping coloured perimeters at once.
- Rounded corners: the comment box's corners were 2px (`rounded` — this theme's DEFAULT radius is 0.125rem); the toolbar is `rounded-full`, which in this theme is 12px (borderRadius.full is 0.75rem, not the usual 9999px). The box now uses `rounded-full` in all three places it is drawn: the lightbox textarea, its wrapper (so the selection outline follows the same curve), and the read-only box on the inline chart — plus the chart download, where drawComment's radius went from 4·scale to 12·scale so the PNG matches the screen. The look was shown as a real screenshot of the running app (toolbar + box together) and approved.
- The "shadow second box" (measured with a probe, not guessed): two outlines were stacking. (1) The blue box: the textarea's border turns blue (#2563eb) while the cursor is inside — Tailwind's preflight `textarea:focus` rule, the same quirk as v4.5.17 (the dotted resize border came out blue until `focus:border-amber-400` was added). (2) The white shadow: the wrapper's `ring-2 ring-white/70` selection ring, drawn around a wrapper 6px taller than the textarea — the textarea sits on the text baseline (inline-element gap), so the white ring hung below the blue box like a second box behind it. A third outline also lurked: the forms plugin's 1px blue focus ring (box-shadow) while typing.
- Single perimeter now (TradeDetail.jsx, lightbox comment only): the wrapper's ring is gone; the textarea's own border carries the one perimeter — blue (#2563eb) when selected or focused, white (white/40) when unselected — and `focus:[box-shadow:none]` kills the forms plugin's focus ring, so focus adds no second outline. The textarea is now `block`, so the wrapper hugs it exactly (no 6px gap — the resize handles stay aligned with the box's corners). The right-click resize state keeps its amber dotted border, unchanged from v4.5.17. The read-only inline box and the export stay white-bordered (the export has no selection state).
- New spec: tests/comment-perimeter.spec.js (2 tests). (1) Typing (focused + selected) → 1px solid rgb(37,99,235), box-shadow none, wrapper shadow none; Escape once (blurred, still selected) → stays blue, still one outline; Escape again (deselected, lightbox still open) → 1px solid rgba(255,255,255,0.4), shadow none. (2) Right-click resize → 2px dotted rgb(251,191,36), shadow none, wrapper shadow none.
- Negative control PASSED: with the wrapper ring restored, the first spec failed; restored (ring gone, 0 occurrences in the file) and the spec passed 2/2 again.
- Verification: build passes, oxlint 0 errors (19 warnings), vitest 64/64, comment-perimeter spec 2/2, full Playwright suite 146/146 — clean, no flakes. Pushed to main as commit ef4eca07ad2ef16e189520d273a48a9297a1c7f0, verified on GitHub. New Windows exe (100,041,467 bytes, asar verified — 24 /dist/ entries vs 23 disk, 0 node_modules) built and uploaded to Drive, replacing the file at the same link (file id 1xJkjEqCcsfwAYZHa1rKCR7h2rDAeZrtM).
