import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Lazy thumbnail object URLs (perf step 7): only visible rows hold a
// blob URL. Scrolling a row out of view unmounts it and its URL is
// revoked; scrolling back re-creates the URL from the cached blob and
// the image loads again.
test.describe('Lazy thumbnail object URLs (perf step 7)', () => {
  test('off-screen rows revoke their thumbnail URLs; scrolling back re-creates them', async ({ page }) => {
    const thumbBytes = makeChartPng(480, 270);
    const thumbDataUrl = 'data:image/png;base64,' + thumbBytes.toString('base64');
    const p = 'sb_ds_nifty-50_2026__';
    const entries = [
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
    ];
    const weeks = [];
    for (let w = 0; w < 20; w++) {
      const id = `week-lazy-${w}`;
      weeks.push({
        id, weekStart: '', weekEnd: '', remarks: '', isCustom: true,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => ({
          day: d, img: null, outcome: null, notes: '', instrument: null, timeframe: null, session: null, rr: null,
        })),
      });
      // NOTE: importDatabase deliberately skips thumb_/med_ entries (the
      // backup format excludes derived tiers), so only the chart itself
      // is seeded — the backfill generates the thumbnail from it.
      entries.push([`${p}img_${id}_Monday`, thumbDataUrl]);
    }
    entries.push([`${p}extra_weeks`, weeks]);
    const backup = JSON.stringify(entries);

    // Record every revokeObjectURL call from page load onwards.
    await page.addInitScript(() => {
      window.__revokedThumbUrls = [];
      const orig = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (u) => {
        if (typeof u === 'string' && u.startsWith('blob:')) window.__revokedThumbUrls.push(u);
        orig(u);
      };
    });

    await page.goto('/');
    await page.evaluate(async (json) => {
      const s = await import('/src/data/storage.js');
      await s.importDatabase(json);
    }, backup);
    await page.reload();

    const firstCellImg = page.locator('[data-testid="day-cell-week-lazy-0-Monday"] img');
    await expect(firstCellImg).toBeVisible();
    // Wait until the backfilled thumbnail exists and the cell is showing
    // the thumbnail's lazy URL (not the full-image fallback the backfill
    // paints first) — only that URL is revoked on unmount. The thumb URL
    // differs from the full-image URL exactly once the thumb is generated.
    await expect.poll(async () => {
      const [src, thumb, full] = await page.evaluate(async () => {
        const s = await import('/src/data/storage.js');
        const img = document.querySelector('[data-testid="day-cell-week-lazy-0-Monday"] img');
        return [img?.getAttribute('src'), s.getStoredThumb('week-lazy-0', 'Monday'), s.getStoredImg('week-lazy-0', 'Monday')];
      });
      return !!src && src === thumb && thumb !== full;
    }, { timeout: 15000 }).toBe(true);
    const firstSrc = await firstCellImg.getAttribute('src');
    expect(firstSrc).toContain('blob:');

    // Scroll to the bottom so the first rows unmount.
    const container = page.locator('[data-testid="main-scroll-container"]');
    await container.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => {
      const revoked = await page.evaluate(() => window.__revokedThumbUrls);
      return revoked.includes(firstSrc);
    }, { timeout: 10000 }).toBe(true);

    // Scroll back: the row remounts, the URL is re-created from the
    // cached blob, and the image loads again — with a fresh URL.
    await container.evaluate((el) => { el.scrollTop = 0; });
    await expect(firstCellImg).toBeVisible();
    const newSrc = await firstCellImg.getAttribute('src');
    expect(newSrc).toContain('blob:');
    expect(newSrc).not.toBe(firstSrc);
    await expect(firstCellImg).toHaveJSProperty('naturalWidth', 480);
  });
});
