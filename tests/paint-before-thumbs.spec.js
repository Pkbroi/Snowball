import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Paint before thumbnails (perf step 6): the journal must render from
// its metadata while thumbnails stream in afterwards — no more
// "Preparing images…" screen blocking on every thumb. Seeded with 20
// full-res charts that have NO thumbnails yet, so the grid has real
// streaming work to do (the backfill generates the thumbs).
test.describe('Paint before thumbnails (perf step 6)', () => {
  test('grid paints before the cell images stream in, then all arrive', async ({ page }) => {
    const pngBytes = makeChartPng(2560, 1440);
    const dataUrl = 'data:image/png;base64,' + pngBytes.toString('base64');
    const p = 'sb_ds_nifty-50_2026__';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const entries = [
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
    ];
    const weeks = [];
    for (let w = 0; w < 4; w++) {
      const id = `week-stream-${w}`;
      weeks.push({
        id, weekStart: '', weekEnd: '', remarks: '', isCustom: true,
        days: days.map((d) => ({
          day: d, img: null, outcome: null, notes: '', instrument: null, timeframe: null, session: null, rr: null,
        })),
      });
      for (const d of days) entries.push([`${p}img_${id}_${d}`, dataUrl]);
    }
    entries.push([`${p}extra_weeks`, weeks]);
    const backup = JSON.stringify(entries);

    await page.goto('/');
    await page.evaluate(async (json) => {
      const s = await import('/src/data/storage.js');
      await s.importDatabase(json);
    }, backup);

    // The journal paints from metadata alone — the old blocking
    // "Preparing images…" progress never appears.
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.locator('text=Preparing images')).toHaveCount(0);

    // At paint time the thumbnails have not streamed in yet: the cells
    // are empty (no <img> in them), even though 20 charts exist.
    const imgsAtPaint = await page.locator('[data-testid^="day-cell-"] img').count();
    expect(imgsAtPaint).toBeLessThan(20);

    // …and they all stream in afterwards. Generous timeout: 20 worker
    // derivations on a loaded suite machine take a while, and the spec's
    // point is that they all arrive, not how fast.
    await expect(page.locator('[data-testid^="day-cell-"] img')).toHaveCount(20, { timeout: 60000 });
  });
});
