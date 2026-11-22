import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Hover-intent preload (perf step 9): pausing on a day cell (~150ms)
// pre-generates its 1600px medium, so opening the trade feels instant.
// A quick pass over the cell must NOT preload anything.
test.describe('Hover-intent preload (perf step 9)', () => {
  test.beforeEach(async ({ page }) => {
    // Disable the missing-thumb/medium backfill for this spec: it runs
    // via requestIdleCallback, and the stub below never invokes the
    // callback — so the ONLY way a medium appears is the hover preload
    // itself. Without this, the backfill would generate every medium
    // and the control assertions would be meaningless.
    await page.addInitScript(() => {
      window.requestIdleCallback = () => 0;
    });

    const chartBytes = makeChartPng(1600, 900);
    const chartDataUrl = 'data:image/png;base64,' + chartBytes.toString('base64');
    const p = 'sb_ds_nifty-50_2026__';
    const entries = [
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
    ];
    const weeks = [{
      id: 'week-hover-0', weekStart: '', weekEnd: '', remarks: '', isCustom: true,
      // day.img carries the chart here (not an IDB img entry): the cell
      // renders its image from it, while the medium is generated from
      // the seeded img key below — so the cell shows a chart even with
      // the backfill disabled, and the medium starts out absent.
      days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => ({
        day: d, img: (d === 'Monday' || d === 'Tuesday') ? chartDataUrl : null, outcome: null, notes: '', instrument: null, timeframe: null, session: null, rr: null,
      })),
    }];
    // importDatabase skips thumb_/med_ entries (the backup format
    // excludes derived tiers), so only the charts are seeded.
    entries.push([`${p}img_week-hover-0_Monday`, chartDataUrl]);
    entries.push([`${p}img_week-hover-0_Tuesday`, chartDataUrl]);
    entries.push([`${p}extra_weeks`, weeks]);

    await page.goto('/');
    await page.evaluate(async (json) => {
      const s = await import('/src/data/storage.js');
      await s.importDatabase(json);
    }, JSON.stringify(entries));
    await page.reload();
    const firstCellImg = page.locator('[data-testid="day-cell-week-hover-0-Monday"] img');
    await expect(firstCellImg).toBeVisible();
  });

  const mediumOf = (page, day) => page.evaluate(async (d) => {
    const s = await import('/src/data/storage.js');
    return s.getStoredMedium('week-hover-0', d);
  }, day);

  test('pausing on a cell for ~150ms pre-generates its medium; the unhovered cell stays empty', async ({ page }) => {
    const cell = page.locator('[data-testid="day-cell-week-hover-0-Monday"]');
    const box = await cell.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => mediumOf(page, 'Monday'), { timeout: 10000 }).toBeTruthy();
    expect(await mediumOf(page, 'Tuesday')).toBeNull();
  });

  test('a quick pass over a cell does not preload its medium', async ({ page }) => {
    const cell = page.locator('[data-testid="day-cell-week-hover-0-Monday"]');
    const box = await cell.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(50);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(400);
    expect(await mediumOf(page, 'Monday')).toBeNull();
  });
});
