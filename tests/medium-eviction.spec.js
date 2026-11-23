import { test, expect } from '@playwright/test';

// Perf 2: medium (1600px) and full-res object URLs used to accumulate
// in memCache with no eviction at all (~15–30 MB over 30 detail
// visits). Two bounds now: leaving a detail page evicts that day's
// full + medium URLs, and the medium cache is LRU-capped at 20.
//
// The visited days are deliberately non-adjacent (no two visited days
// are neighbours in the same week), so preloadNeighbourImages can
// never re-create a visited day's medium after it was evicted —
// without that, a late idle-callback preload would make the final
// counts non-deterministic.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Seed one chart per (weekId, day) through the real setStoredImg API
// (worker derives thumb + medium, metadata + week doc saved), reusing
// a single canvas PNG for every day — the content is irrelevant here,
// only the tiers existing matters.
async function seedCharts(page, days) {
  await page.evaluate(async (days) => {
    const { setStoredImg, flushAllWeekDocs } = await import('/src/data/storage.js');
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 450;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 800, 450);
    g.addColorStop(0, '#123456'); g.addColorStop(1, '#654321');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 800, 450);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(100, 100, 600, 50);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    for (const { weekId, day } of days) {
      await setStoredImg(weekId, day, blob);
    }
    await flushAllWeekDocs();
  }, days);
}

async function getWeekIds(page) {
  return page.evaluate(async () => {
    const { getExtraWeeks } = await import('/src/data/storage.js');
    return getExtraWeeks().map((w) => w.id);
  });
}

async function cachedTiers(page, days) {
  return page.evaluate(async (days) => {
    const { getStoredMedium, getStoredImg } = await import('/src/data/storage.js');
    return days.map(({ weekId, day }) => ({
      weekId, day,
      med: getStoredMedium(weekId, day) != null,
      full: getStoredImg(weekId, day) != null,
    }));
  }, days);
}

test.describe('Medium / full image URL eviction (perf 2)', () => {
  test('leaving a detail page evicts its full and medium URLs', { timeout: 180000 }, async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 3; i++) await page.getByTestId('add-week-btn').click();
    const weekIds = await getWeekIds(page);
    expect(weekIds.length).toBe(3);

    // Non-adjacent days: no visited day is a neighbour of another.
    const visits = [
      { weekId: weekIds[0], day: 'Monday' },
      { weekId: weekIds[0], day: 'Wednesday' },
      { weekId: weekIds[0], day: 'Friday' },
      { weekId: weekIds[1], day: 'Tuesday' },
      { weekId: weekIds[1], day: 'Thursday' },
      { weekId: weekIds[2], day: 'Monday' },
    ];
    await seedCharts(page, visits);
    await page.reload();
    await expect(page.getByTestId('add-week-btn')).toBeVisible({ timeout: 15000 });

    for (const { weekId, day } of visits) {
      await page.evaluate(({ weekId, day }) => {
        sessionStorage.setItem('sb_last_day', day);
        location.hash = `#/trade/${weekId}`;
      }, { weekId, day });
      await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
      // Both tiers are cached for this day now.
      await page.waitForFunction(async ({ weekId, day }) => {
        const { getStoredMedium, getStoredImg } = await import('/src/data/storage.js');
        return getStoredMedium(weekId, day) != null && getStoredImg(weekId, day) != null;
      }, { weekId, day }, { timeout: 15000 });
      await page.getByTestId('back-button').click();
      await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 15000 });
      // Back on the journal: both tiers for this day are gone.
      const [after] = await cachedTiers(page, [{ weekId, day }]);
      expect(after.med, `${day} medium still cached after leaving`).toBe(false);
      expect(after.full, `${day} full image still cached after leaving`).toBe(false);
    }

    // And nothing came back: all six visited days are still evicted.
    const final = await cachedTiers(page, visits);
    for (const { day, med, full } of final) {
      expect(med, `${day} medium reappeared`).toBe(false);
      expect(full, `${day} full image reappeared`).toBe(false);
    }
  });

  test('medium cache caps at 20, least-recently-used first', { timeout: 180000 }, async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 5; i++) await page.getByTestId('add-week-btn').click();
    const weekIds = await getWeekIds(page);
    expect(weekIds.length).toBe(5);
    const days = weekIds.flatMap((weekId) => DAYS.map((day) => ({ weekId, day })));
    expect(days.length).toBe(25);

    await seedCharts(page, days);

    // Phase A — the upload path: seeding 25 mediums leaves only the
    // last 20 cached; the first 5 were evicted as the cap was hit.
    await page.waitForFunction(async (days) => {
      const { getStoredMedium } = await import('/src/data/storage.js');
      return days.filter(({ weekId, day }) => getStoredMedium(weekId, day) != null).length === 20;
    }, days, { timeout: 15000 });
    const afterSeed = await cachedTiers(page, days);
    expect(afterSeed.filter((d) => d.med).length).toBe(20);
    afterSeed.slice(0, 5).forEach((d) => expect(d.med, `${d.day} should have been evicted`).toBe(false));
    afterSeed.slice(5).forEach((d) => expect(d.med, `${d.day} should still be cached`).toBe(true));

    // Phase B — the resolve path: after a reload, resolving all 25 in
    // order leaves the same last-20 cached.
    await page.reload();
    await expect(page.getByTestId('add-week-btn')).toBeVisible({ timeout: 15000 });
    await page.evaluate(async (days) => {
      const { resolveMediumAsync } = await import('/src/data/storage.js');
      for (const { weekId, day } of days) await resolveMediumAsync(weekId, day);
    }, days);
    const afterResolve = await cachedTiers(page, days);
    expect(afterResolve.filter((d) => d.med).length).toBe(20);
    afterResolve.slice(0, 5).forEach((d) => expect(d.med, `${d.day} should have been evicted`).toBe(false));
    afterResolve.slice(5).forEach((d) => expect(d.med, `${d.day} should still be cached`).toBe(true));

    // No data lost: an evicted medium re-creates from IndexedDB.
    const first = days[0];
    await page.evaluate(async ({ weekId, day }) => {
      const { resolveMediumAsync } = await import('/src/data/storage.js');
      await resolveMediumAsync(weekId, day);
    }, first);
    const [reloaded] = await cachedTiers(page, [first]);
    expect(reloaded.med).toBe(true);
    const afterReload = await cachedTiers(page, days);
    expect(afterReload.filter((d) => d.med).length).toBe(20);
  });
});
