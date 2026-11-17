import { test, expect } from '@playwright/test';

// Regression tests for the back-navigation bug (see BUG-REPORT.md v4.2):
// scrolling down, opening a cell's detail page and going back reloaded
// the journal from the top instead of returning to where you left off.
// Root cause: the journal's unmount cleanup ran after its scroll
// container was detached from the document, and a detached container
// reports scrollTop 0 — so it overwrote the position goToDetail() had
// just saved. The cleanup (and the throttled scroll writer) now skip
// the write once the container is detached.
test.describe('Back from detail page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 30; i++) await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(500);
  });

  const container = (page) => page.getByTestId('main-scroll-container');
  const scrollTop = (page) => container(page).evaluate((el) => el.scrollTop);
  const scrollTo = (page, y) => container(page).evaluate((el, top) => { el.scrollTop = top; }, y);
  const rowIds = (page) => page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid')));

  async function openMiddleCell(page) {
    await scrollTo(page, 1e9);
    await page.waitForTimeout(500);
    const mid = (await container(page).evaluate((el) => el.scrollHeight)) / 2;
    await scrollTo(page, mid);
    await page.waitForTimeout(800);
    const beforeTop = await scrollTop(page);
    const ids = await rowIds(page);
    const midRow = ids[Math.floor(ids.length / 2)].replace('week-row-', '');
    await page.getByTestId(`day-cell-${midRow}-Monday`).dblclick();
    await expect(page.getByLabel('Back to Journal')).toBeVisible();
    return { beforeTop, midRow };
  }

  test('returns to the same scroll position and the same cell', async ({ page }) => {
    const { beforeTop, midRow } = await openMiddleCell(page);
    expect(await page.evaluate(() => sessionStorage.getItem('sb_scroll_top'))).toBe(String(beforeTop));

    await page.getByLabel('Back to Journal').click();
    await page.waitForTimeout(1000);
    const afterTop = await scrollTop(page);
    expect(afterTop).toBeGreaterThan(0);
    expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(150);
    await expect(page.getByTestId(`day-cell-${midRow}-Monday`)).toBeVisible();
  });

  test('returns to the bottom when the cell was at the bottom', async ({ page }) => {
    await scrollTo(page, 1e9);
    await page.waitForTimeout(800);
    const ids = await rowIds(page);
    const lastRow = ids[ids.length - 1].replace('week-row-', '');
    const beforeTop = await scrollTop(page);
    await page.getByTestId(`day-cell-${lastRow}-Friday`).dblclick();
    await expect(page.getByLabel('Back to Journal')).toBeVisible();

    await page.getByLabel('Back to Journal').click();
    await page.waitForTimeout(1000);
    const afterTop = await scrollTop(page);
    expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(150);
    await expect(page.getByTestId(`day-cell-${lastRow}-Friday`)).toBeVisible();
  });
});
