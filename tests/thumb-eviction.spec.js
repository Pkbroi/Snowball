import { test, expect } from '@playwright/test';

// Off-screen thumbnail eviction (round-2 improvement 4): a row that
// scrolls out of view has its thumb Blob dropped from memory after a
// 30 s grace period; scrolling back reloads it from IndexedDB, so the
// image returns instead of a blank cell. A quick scroll-back (inside
// the grace period) is instant — the Blob is still cached. Seeded with
// real thumb Blobs in IndexedDB (no full images, so no backfill work).
const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

async function seedThumbs(page, weekCount) {
  await page.evaluate(async ({ redPng, weekCount, DAYS }) => {
    const { set } = await import('/node_modules/.vite/deps/idb-keyval.js');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const weeks = [];
    for (let w = 0; w < weekCount; w++) {
      const id = `week-ev-${w}`;
      weeks.push({
        id, weekStart: '', weekEnd: '', remarks: '', isCustom: true,
        days: DAYS.map((d) => ({
          day: d, img: null, outcome: null, notes: '', instrument: null, timeframe: null, session: null, rr: null,
        })),
      });
      for (const d of DAYS) {
        await set(`sb_ds_nifty-50_2026__thumb_${id}_${d}`, blob);
      }
    }
    await set('sb_ds_nifty-50_2026__extra_weeks', weeks);
  }, { redPng, weekCount, DAYS });
}

async function scrollTo(page, top) {
  await page.locator('[data-testid="main-scroll-container"]').evaluate((el, t) => { el.scrollTop = t; }, top);
}

test.describe('Off-screen thumbnail eviction (round-2 improvement 4)', () => {
  test('a quick scroll away and back is instant — the Blob is still cached', async ({ page }) => {
    await page.goto('/');
    await seedThumbs(page, 12);
    await page.reload();
    const firstImg = page.locator('[data-testid="day-cell-week-ev-0-Monday"] img');
    await expect(firstImg).toBeVisible({ timeout: 30000 });

    await scrollTo(page, 100000);
    await expect(page.getByTestId('week-row-week-ev-0')).toHaveCount(0);
    await scrollTo(page, 0);
    // Inside the 30 s grace period the Blob is still cached, so the
    // image is back immediately — no reload flicker.
    await expect(firstImg).toBeVisible({ timeout: 2000 });
  });

  test('after the grace period the image reloads from IndexedDB on scroll-back', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/');
    await seedThumbs(page, 12);
    await page.reload();
    const firstImg = page.locator('[data-testid="day-cell-week-ev-0-Monday"] img');
    await expect(firstImg).toBeVisible({ timeout: 30000 });

    await scrollTo(page, 100000);
    await expect(page.getByTestId('week-row-week-ev-0')).toHaveCount(0);
    // The 30 s grace period passes with the row off-screen: its thumb
    // Blob is evicted from memory (the IndexedDB copy stays).
    await page.waitForTimeout(32000);
    await scrollTo(page, 0);
    // The remount reloads the thumb from IndexedDB and the image returns.
    await expect(firstImg).toBeVisible({ timeout: 10000 });
  });
});
