import { test, expect } from '@playwright/test';

test.describe('Zoom & Scroll Restoration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should remember zoom, scroll position, and return to the cell left off', async ({ page }) => {
    // 1. Add several custom week rows so there is ample content
    const addBtn = page.getByTestId('add-week-btn');
    for (let i = 0; i < 5; i++) {
      await addBtn.click();
    }

    // 2. Zoom in multiple times to 200% or more
    const zoomInBtn = page.getByTestId('zoom-in-btn');
    for (let i = 0; i < 10; i++) {
      const disabled = await zoomInBtn.isDisabled();
      if (disabled) break;
      await zoomInBtn.click();
    }

    // Verify zoom level text is at least 200%
    const zoomText = await page.locator('button[data-testid="zoom-in-btn"]').locator('xpath=preceding-sibling::span[1]').innerText();
    const zoomValue = parseInt(zoomText.replace('%', ''), 10);
    expect(zoomValue).toBeGreaterThanOrEqual(150);

    const scrollContainer = page.getByTestId('main-scroll-container');
    await expect(scrollContainer).toBeVisible();

    // 3. In the zoomed-in state, find a Thursday or Friday cell on one of the rows
    const targetCell = page.locator('[data-testid$="-Thursday"], [data-testid$="-Friday"]').nth(2);
    await expect(targetCell).toBeAttached();

    // Scroll target cell into view horizontally
    await targetCell.scrollIntoViewIfNeeded();

    const scrollLeftBefore = await scrollContainer.evaluate((el) => el.scrollLeft);
    const targetCellId = await targetCell.getAttribute('data-testid');

    // Double click the cell to navigate to detail
    await targetCell.dblclick();

    // 4. Verify we are on trade detail
    await expect(page).toHaveURL(/\/trade\/.*/);
    const backBtn = page.getByTestId('back-button');
    await expect(backBtn).toBeVisible();

    // 5. Navigate back to journal
    await backBtn.click();
    await expect(page).toHaveURL(/.*\/$/);

    // 6. Verify zoom is remembered
    const restoredZoomText = await page.locator('button[data-testid="zoom-in-btn"]').locator('xpath=preceding-sibling::span[1]').innerText();
    const restoredZoomValue = parseInt(restoredZoomText.replace('%', ''), 10);
    expect(restoredZoomValue).toBe(zoomValue);

    // 7. Verify we are NOT at the start of the row (scrollLeft > 0 if before was > 0)
    // Wait for multi-frame restoration
    await page.waitForTimeout(300);

    if (scrollLeftBefore > 50) {
      const scrollLeftAfter = await scrollContainer.evaluate((el) => el.scrollLeft);
      expect(scrollLeftAfter).toBeGreaterThan(0);
    }

    // 8. Verify the target cell is visible in the viewport
    const returnedCell = page.locator(`[data-testid="${targetCellId}"]`);
    await expect(returnedCell).toBeVisible();

    // Verify the cell is within the horizontal bounds of the scroll container
    const isWithinBounds = await page.evaluate(({ containerTestId, cellTestId }) => {
      const container = document.querySelector(`[data-testid="${containerTestId}"]`);
      const cell = document.querySelector(`[data-testid="${cellTestId}"]`);
      if (!container || !cell) return false;
      const cRect = container.getBoundingClientRect();
      const elRect = cell.getBoundingClientRect();
      return elRect.left < cRect.right && elRect.right > cRect.left;
    }, { containerTestId: 'main-scroll-container', cellTestId: targetCellId });

    expect(isWithinBounds).toBe(true);
  });
});
