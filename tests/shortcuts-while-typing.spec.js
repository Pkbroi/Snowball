import { test, expect } from '@playwright/test';

// Bug 12: the journal's window keydown handler fired Ctrl+N (add row)
// and Ctrl+= / Ctrl+- (zoom) while the user was typing in an input —
// Ctrl+N in the search box added a week, Ctrl+= zoomed the grid.
// Shortcuts must be ignored when the event target is an input,
// textarea, or contentEditable element (the Quill editor).
test.describe('Shortcuts while typing (bug 12)', () => {
  test('Ctrl+N in the search box does not add a week', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const rows = page.locator('div[data-testid^="week-row-week-custom-"]');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('search-input').click();
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(300);
    await expect(rows).toHaveCount(1);
  });

  test('Ctrl+= in the search box does not zoom the grid', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-input').click();
    await expect(page.getByText('100%', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(300);
    await expect(page.getByText('100%', { exact: true })).toBeVisible();
    // The zoom is persisted as "1" (100%) on mount; it must not have
    // moved to "1.1".
    const storedZoom = await page.evaluate(() => sessionStorage.getItem('sb_zoom'));
    expect(storedZoom).toBe('1');
  });

  test('Ctrl+N outside any input still adds a week', async ({ page }) => {
    await page.goto('/');
    // Wait for the journal to mount (the shortcut handler lives in
    // WeeklyJournal) before pressing — a press during the loading
    // screen would miss the handler entirely.
    await expect(page.getByTestId('add-week-btn')).toBeVisible();
    const rows = page.locator('div[data-testid^="week-row-week-custom-"]');
    await expect(rows).toHaveCount(0);
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+n');
    await expect(rows).toHaveCount(1);
  });
});
