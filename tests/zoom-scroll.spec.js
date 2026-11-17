import { test, expect } from '@playwright/test';

// Regression tests for the zoomed-scroll bug (see BUG-REPORT.md v4.1):
// at 110%+ zoom, scrolling from the middle to the last rows left the
// upper rows of the viewport unrendered (they "disappeared"), and the
// list's total height kept growing as you scrolled. Root cause: CSS
// `zoom` on the grid made Virtuoso measure rows in visual px while
// scrolling in layout px. Zoom is now real layout scaling (calc() with
// a --tz variable) and Virtuoso remounts on zoom change so no stale
// sizes measured at the old zoom survive.
test.describe('Zoomed scrolling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 30; i++) await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(500);
  });

  const container = (page) => page.getByTestId('main-scroll-container');
  const metrics = (page) => container(page).evaluate((el) => ({
    scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
  }));
  const scrollTo = (page, y) => container(page).evaluate((el, top) => { el.scrollTop = top; }, y);
  const rowIds = (page) => page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid')));

  for (const [label, clicks] of [['110%', 1], ['120%', 2], ['150%', 5]]) {
    test(`zoom ${label}: bottom, middle and top rows all load, total height stable`, async ({ page }) => {
      // Capture the first and last week ids at 100% zoom.
      await scrollTo(page, 1e9);
      await page.waitForTimeout(500);
      const idsAtBottom = await rowIds(page);
      const lastId = idsAtBottom[idsAtBottom.length - 1];
      await scrollTo(page, 0);
      await page.waitForTimeout(500);
      const firstId = (await rowIds(page))[0];

      // Zoom in.
      for (let i = 0; i < clicks; i++) await page.getByTestId('zoom-in-btn').click();
      await page.waitForTimeout(800);
      const heights = [];

      // Bottom: the last week must render.
      await scrollTo(page, 1e9);
      await page.waitForTimeout(800);
      heights.push((await metrics(page)).scrollHeight);
      await expect(page.locator(`[data-testid="${lastId}"]`)).toBeVisible();
      expect((await rowIds(page)).length).toBeGreaterThanOrEqual(5);

      // Middle: rows must render (not a blank window), total unchanged.
      const mid = (await metrics(page)).scrollHeight / 2;
      await scrollTo(page, mid);
      await page.waitForTimeout(800);
      heights.push((await metrics(page)).scrollHeight);
      const midIds = await rowIds(page);
      expect(midIds.length).toBeGreaterThanOrEqual(5);
      expect(midIds).not.toContain(firstId);
      expect(midIds).not.toContain(lastId);

      // Top: the first week must render, total still unchanged.
      await scrollTo(page, 0);
      await page.waitForTimeout(800);
      heights.push((await metrics(page)).scrollHeight);
      await expect(page.locator(`[data-testid="${firstId}"]`)).toBeVisible();

      // The list's total height must not drift while scrolling — a
      // drifting total was the visible symptom of Virtuoso's window
      // being computed from stale/wrong row sizes.
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(50);
    });
  }

  test('zooming while scrolled mid-list does not jump back to the top', async ({ page }) => {
    await scrollTo(page, 1e9);
    await page.waitForTimeout(500);
    const mid = (await metrics(page)).scrollHeight / 2;
    await scrollTo(page, mid);
    await page.waitForTimeout(500);
    await page.getByTestId('zoom-in-btn').click();
    await page.getByTestId('zoom-in-btn').click();
    await page.waitForTimeout(800);
    const after = await metrics(page);
    expect(after.scrollTop).toBeGreaterThan(0);
    // …and the bottom is still reachable with the last row rendering.
    await scrollTo(page, 1e9);
    await page.waitForTimeout(800);
    const ids = await rowIds(page);
    expect(ids.length).toBeGreaterThanOrEqual(5);
  });
});

test.describe('Zoom out', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 30; i++) await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(500);
  });

  const container = (page) => page.getByTestId('main-scroll-container');
  const metrics = (page) => container(page).evaluate((el) => ({
    scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
  }));
  const scrollTo = (page, y) => container(page).evaluate((el, top) => { el.scrollTop = top; }, y);
  const rowIds = (page) => page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid')));
  const zoomLabel = (page) => page.locator('[data-testid="zoom-in-btn"]').evaluate(
    (el) => el.parentElement?.textContent?.trim());

  for (const [label, clicks] of [['90%', 1], ['70%', 3], ['50%', 5]]) {
    test(`zoom out to ${label}: bottom, middle and top rows all load, total height stable`, async ({ page }) => {
      await scrollTo(page, 1e9);
      await page.waitForTimeout(500);
      const idsAtBottom = await rowIds(page);
      const lastId = idsAtBottom[idsAtBottom.length - 1];
      await scrollTo(page, 0);
      await page.waitForTimeout(500);
      const firstId = (await rowIds(page))[0];

      for (let i = 0; i < clicks; i++) await page.getByTestId('zoom-out-btn').click();
      await page.waitForTimeout(800);
      expect(await zoomLabel(page)).toContain(label.replace('%', ''));
      const heights = [];

      await scrollTo(page, 1e9);
      await page.waitForTimeout(800);
      heights.push((await metrics(page)).scrollHeight);
      await expect(page.locator(`[data-testid="${lastId}"]`)).toBeVisible();
      expect((await rowIds(page)).length).toBeGreaterThanOrEqual(5);

      const mid = (await metrics(page)).scrollHeight / 2;
      await scrollTo(page, mid);
      await page.waitForTimeout(800);
      heights.push((await metrics(page)).scrollHeight);
      const midIds = await rowIds(page);
      expect(midIds.length).toBeGreaterThanOrEqual(5);
      expect(midIds).not.toContain(firstId);
      expect(midIds).not.toContain(lastId);

      await scrollTo(page, 0);
      await page.waitForTimeout(800);
      heights.push((await metrics(page)).scrollHeight);
      await expect(page.locator(`[data-testid="${firstId}"]`)).toBeVisible();

      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(50);
    });
  }

  test('zooming out while scrolled mid-list does not jump back to the top', async ({ page }) => {
    await scrollTo(page, 1e9);
    await page.waitForTimeout(500);
    const mid = (await metrics(page)).scrollHeight / 2;
    await scrollTo(page, mid);
    await page.waitForTimeout(500);
    await page.getByTestId('zoom-out-btn').click();
    await page.getByTestId('zoom-out-btn').click();
    await page.waitForTimeout(800);
    expect((await metrics(page)).scrollTop).toBeGreaterThan(0);
    await scrollTo(page, 1e9);
    await page.waitForTimeout(800);
    expect((await rowIds(page)).length).toBeGreaterThanOrEqual(5);
  });

  test('zoom-out stops at 50% and the button disables', async ({ page }) => {
    for (let i = 0; i < 5; i++) await page.getByTestId('zoom-out-btn').click();
    await page.waitForTimeout(500);
    expect(await zoomLabel(page)).toContain('50');
    await expect(page.getByTestId('zoom-out-btn')).toBeDisabled();
  });
});
