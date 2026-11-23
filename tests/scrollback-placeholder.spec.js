import { test, expect } from '@playwright/test';

// Perf 5: after round-2 improvement 4 evicted a row's thumb Blob (30 s
// after it scrolled off-screen), scrolling back briefly showed the
// FULL-RES image while the thumb reloaded — getStoredThumb fell back
// to the cached img_ URL when no thumb was in memCache, so the grid
// decoded a huge chart (the scroll jank the thumbnail tier exists to
// avoid) and flashed it. Now getStoredThumb returns null when a thumb
// is known to exist in IndexedDB but its Blob was evicted, so the cell
// holds its placeholder until loadThumb brings the thumb back. The
// full-res fallback stays for cells whose thumb was never created
// (legacy images, backfill pending) — there thumbKnown has no key.

// The chart is 2560px wide, the thumb 480px, so the cell img's
// naturalWidth tells them apart: 2560 = full-res flash, 480 = thumb.
// Twenty weeks are seeded so the journal actually scrolls: at 100%
// zoom a row is ~94px tall, so 6 rows (~650px with the header) fit
// in the 720px viewport and scrolling to the bottom never unmounts
// the first row — with 20 rows it does (Virtuoso), which is what
// schedules the eviction.
//
// There is NO reload in this spec, deliberately: setStoredImg caches
// the full-res URL in memCache (img_), and a reload would clear it —
// then the getStoredThumb fallback would have nothing to return and
// the spec would pass vacuously even without the guard (that is
// exactly what the first version did: it passed with the guard
// removed). The real flash happens in an upload session, where the
// full-res URL is cached from setStoredImg, so the spec reproduces
// that: seed in-page, remount the row so the cell picks up the thumb
// (in-page seeding does not notify), then evict and scroll back.
async function seedChart(page, weekId, day) {
  await page.evaluate(async ({ weekId, day }) => {
    const { setStoredImg, flushAllWeekDocs } = await import('/src/data/storage.js');
    const canvas = document.createElement('canvas');
    canvas.width = 2560; canvas.height = 1440;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 2560, 1440);
    g.addColorStop(0, '#123456'); g.addColorStop(1, '#654321');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 2560, 1440);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(200, 200, 1200, 100);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await setStoredImg(weekId, day, blob);
    await flushAllWeekDocs();
  }, { weekId, day });
}

test.describe('Scroll-back placeholder (perf 5)', () => {
  test('scrolling back to a row whose thumb was evicted never shows the full-res image', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/');
    for (let i = 0; i < 20; i++) await page.getByTestId('add-week-btn').click();
    const weekIds = await page.evaluate(async () => {
      const { getExtraWeeks } = await import('/src/data/storage.js');
      return getExtraWeeks().map((w) => w.id);
    });
    const weekId = weekIds[0];
    await seedChart(page, weekId, 'Monday');
    const container = page.getByTestId('main-scroll-container');
    const cell = page.getByTestId(`day-cell-${weekId}-Monday`);
    // Remount the row so the cell picks up the thumb that setStoredImg
    // just created (in-page seeding does not notify the grid). The
    // remount also proves the full-res URL is cached: getStoredThumb
    // must return the thumb, not the full-res placeholder.
    await container.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(cell).toHaveCount(0);
    await container.evaluate((el) => { el.scrollTop = 0; });
    await expect(cell.locator('img')).toBeVisible();
    // The cell shows the 480px thumb, not the 2560px original.
    await expect.poll(async () => cell.locator('img').evaluate((el) => el.naturalWidth), { timeout: 30000 }).toBe(480);

    // Scroll the row out of view (Virtuoso unmounts it: the cleanup
    // revokes the thumb URL and schedules the Blob eviction with the
    // 30 s grace), then force the eviction to fire immediately so the
    // spec does not wait 30 s. This is the exact state a scroll-back
    // remount used to meet: thumb known, Blob gone, full-res URL still
    // cached in memCache from setStoredImg.
    await container.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(cell).toHaveCount(0);
    const evicted = await page.evaluate(async (weekId) => {
      const s = await import('/src/data/storage.js');
      const full = s.getStoredImg(weekId, 'Monday');
      s.scheduleThumbEviction(weekId, 'Monday', 0);
      await new Promise((r) => setTimeout(r, 100));
      return {
        full,
        after: s.getStoredThumb(weekId, 'Monday'),
        known: s.hasStoredThumb(weekId, 'Monday'),
        hasBlob: s.hasThumbBlob(weekId, 'Monday'),
      };
    }, weekId);
    expect(evicted.full).toBeTruthy();
    expect(evicted.known).toBe(true);
    expect(evicted.hasBlob).toBe(false);
    // The fix: a known-but-evicted thumb reads back as null, NOT the
    // full-res image that is sitting in memCache. (Negative control:
    // without the thumbKnown guard this returns the full-res URL.)
    expect(evicted.after).toBeNull();

    // Record every width the cell img takes while the thumb reloads:
    // a 5 ms poller catches a full-res flash if one occurs (the old
    // code set the full-res src synchronously on remount and kept it
    // for the ~10–50 ms the thumb reload takes).
    await page.evaluate(() => {
      window.__seenWidths = [];
      window.__widthTimer = setInterval(() => {
        const img = document.querySelector('[data-testid^="day-cell-"] img');
        if (img && img.naturalWidth) window.__seenWidths.push(img.naturalWidth);
      }, 5);
    });
    await container.evaluate((el) => { el.scrollTop = 0; });
    // The cell recovers to the 480px thumb.
    await expect.poll(async () => cell.locator('img').evaluate((el) => el.naturalWidth), { timeout: 30000 }).toBe(480);
    const seen = await page.evaluate(() => {
      clearInterval(window.__widthTimer);
      return window.__seenWidths;
    });
    expect(seen).toContain(480);
    expect(seen).not.toContain(2560);
  });
});
