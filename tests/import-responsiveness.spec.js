import { test, expect } from '@playwright/test';

// Importing a large backup must not freeze the UI. The old code did a
// synchronous JSON.parse of the whole backup on the main thread (plus the
// base64 decode), so a ~150 MB backup blocked the UI for well over 100 ms.
// The parse + validation + decode now run in the image worker; the main
// thread only does the (already batched, yielding) IndexedDB writes. The
// backup's bytes are TRANSFERRED to the worker as an ArrayBuffer
// (zero-copy) — sending the string instead would structured-clone it on
// the main thread (~300 ms for 160 MB, measured), which is the very
// freeze this step removes, so the import takes a Blob, not a string.
//
// The spec builds a large backup in-page (one 1280x720 noise chart, whose
// data URL is reused across many days — the backup size, and therefore
// the parse cost, is what matters) and keeps it on window as a Blob, so
// the ~150 MB never crosses the Playwright protocol.
//
// Two tests, each on a fresh page (Playwright gives each test its own
// page): the first proves the backup is big enough to discriminate —
// its JSON.parse leaves ~160 MB of garbage, so it must NOT share a page
// with the responsiveness measurement, or a major GC during the import
// would pollute the measurement. The second imports the backup while
// recording the gaps between animation frames, and checks the data
// actually landed.

const CHARTS = 40;

// Build the backup in-page and keep it on window as a Blob. Returns only
// the byte length. One noise chart (random pixels, so the PNG does not
// compress — a realistic ~2.7 MB chart), reused across days.
const buildBackup = (page, count) =>
  page.evaluate(async (n) => {
    const w = 1280;
    const h = 720;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    let s = 123456789;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (rnd() * 255) | 0;
      d[i + 1] = (rnd() * 255) | 0;
      d[i + 2] = (rnd() * 255) | 0;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const dataUrl = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
    const entries = [
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
    ];
    for (let i = 0; i < n; i++) {
      entries.push([`sb_ds_nifty-50_2026__img_w${i}_Monday`, dataUrl]);
      entries.push([`sb_ds_nifty-50_2026__wk_w${i}`, { v: 1, label: `Week ${i}`, days: {} }]);
    }
    const json = JSON.stringify(entries);
    window.__backupBlob = new Blob([json], { type: 'application/json' });
    return json.length;
  }, count);

test.describe('Import responsiveness', () => {
  test('the backup is large enough to discriminate', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/');
    await page.getByTestId('add-week-btn').waitFor({ timeout: 15000 });

    const backupLen = await buildBackup(page, CHARTS);
    const backupMB = backupLen / 1048576;
    // Sanity: the backup really is large (guards against the noise chart
    // compressing to nothing and the test passing vacuously).
    expect(backupMB).toBeGreaterThan(100);

    // Baseline: how long does a direct JSON.parse of this backup take on
    // the main thread? That is part of the freeze the old code paid
    // (the bulk of it was the base64 decode — the negative control
    // measures the whole old-code freeze at ~800 ms). The backup must
    // be big enough to discriminate — if it parses too fast, the spec
    // fails loudly instead of passing vacuously. The parse of this
    // ~161 MB backup measures ~85 ms idle to ~115 ms under load, so
    // the threshold sits well below the observed range; the > 100 MB
    // size check above is the primary guard.
    const parseMs = await page.evaluate(async () => {
      const text = await window.__backupBlob.text();
      const t0 = performance.now();
      JSON.parse(text);
      return performance.now() - t0;
    });
    expect(parseMs).toBeGreaterThan(50);
  });

  test('importing a large backup does not freeze the UI', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/');
    await page.getByTestId('add-week-btn').waitFor({ timeout: 15000 });

    const backupLen = await buildBackup(page, CHARTS);
    expect(backupLen / 1048576).toBeGreaterThan(100);

    // Import while recording the gaps between animation frames. A gap is
    // how long the main thread was blocked (no frame could run).
    const { maxGapMs, frames } = await page.evaluate(async () => {
      const mod = await import('/src/data/storage.js');
      const gaps = [];
      let last = performance.now();
      let running = true;
      const tick = (t) => {
        if (!running) return;
        gaps.push(t - last);
        last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // Let the recorder settle for a frame before the import starts.
      await new Promise((r) => setTimeout(r, 50));
      gaps.length = 0;
      last = performance.now();
      await mod.importDatabase(window.__backupBlob);
      running = false;
      return { maxGapMs: Math.max(0, ...gaps), frames: gaps.length };
    });

    // The recorder must actually have run (a page that never paints
    // would record no gaps and pass vacuously).
    expect(frames).toBeGreaterThan(10);
    // The import's worst main-thread block must be far below the parse
    // time the old code paid — the parse and decode ran in the worker,
    // and the bytes were transferred, not cloned.
    expect(maxGapMs).toBeLessThan(100);
    console.log('import maxGapMs:', maxGapMs, 'frames:', frames);

    // And the data actually landed: a chart Blob and a week document.
    // getStoredImgAsync returns a blob: URL (not the Blob), so fetch
    // the URL to measure the stored image's bytes.
    const check = await page.evaluate(async () => {
      const mod = await import('/src/data/storage.js');
      const url = await mod.getStoredImgAsync('w0', 'Monday');
      const blob = url ? await (await fetch(url)).blob() : null;
      return {
        imgBytes: blob ? blob.size : 0,
        label: mod.getWeekLabel('w0'),
        datasets: mod.getDatasets().length,
      };
    });
    expect(check.imgBytes).toBeGreaterThan(1000000);
    expect(check.label).toBe('Week 0');
    expect(check.datasets).toBe(1);
  });
});
