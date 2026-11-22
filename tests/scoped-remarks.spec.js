import { test, expect } from '@playwright/test';

// Scoped remarks refresh (perf step 10): closing a week's remarks modal
// recomputes only that week's front-page preview. Editing week 1 must
// update week 1's cell and leave week 2's cell exactly as it was — and
// vice versa. (The recompute itself is internal; this pins the
// user-visible behaviour the scoping protects.)
test.describe('Scoped remarks refresh (perf step 10)', () => {
  test('editing one week\'s remarks updates only that week\'s cell', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await page.getByTestId('add-week-btn').click();

    const cells = page.locator('[data-testid^="remarks-cell-"]');
    await expect(cells).toHaveCount(2);
    const firstCell = cells.first();
    const secondCell = cells.nth(1);

    // Edit the first week's remarks.
    await firstCell.click();
    await expect(page.locator('.remarks-modal-container')).toBeVisible();
    const editor = page.locator('.remarks-modal-container .ql-editor');
    await editor.click();
    await page.keyboard.type('Week one remark');
    await page.waitForTimeout(900); // let the save land
    await page.keyboard.press('Escape');
    await expect(page.locator('.remarks-modal-container')).toHaveCount(0);

    await expect(firstCell).toContainText('Week one remark');
    await expect(secondCell).not.toContainText('Week one remark');

    // Edit the second week's remarks; the first week's text must stay.
    await secondCell.click();
    await expect(page.locator('.remarks-modal-container')).toBeVisible();
    const editor2 = page.locator('.remarks-modal-container .ql-editor');
    await editor2.click();
    await page.keyboard.type('Week two remark');
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await expect(page.locator('.remarks-modal-container')).toHaveCount(0);

    await expect(secondCell).toContainText('Week two remark');
    await expect(firstCell).toContainText('Week one remark');
    await expect(firstCell).not.toContainText('Week two remark');
  });
});
