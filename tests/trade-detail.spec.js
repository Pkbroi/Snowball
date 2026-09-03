import { test, expect } from '@playwright/test';

test.describe('Trade Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Add a week row so we have cells to click
    await page.getByTestId('add-week-btn').click();
  });

  test('should navigate from weekly journal to trade detail', async ({ page }) => {
    // Find the first day cell and double click it
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toBeVisible();
    
    await firstDayCell.dblclick();

    // Verify we navigated to the trade detail page
    await expect(page).toHaveURL(/\/trade\/.*/);
    
    // Verify the back button exists
    await expect(page.getByTestId('back-button')).toBeVisible();
    
    // Verify the notes editor exists
    await expect(page.getByTestId('notes-editor')).toBeVisible();
  });

  test('should display auto-save indicator when notes are typed', async ({ page }) => {
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await firstDayCell.dblclick();

    const editor = page.getByTestId('notes-editor');
    await editor.fill('Testing auto save');

    // Wait for the "Saved ✓" indicator to appear
    const saveIndicator = page.locator('text="Saved ✓"').first();
    await expect(saveIndicator).toBeVisible();
  });

  test('should navigate back to journal when back button is clicked', async ({ page }) => {
    // Navigate to trade detail
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await firstDayCell.dblclick();

    // Click back button
    const backBtn = page.getByTestId('back-button');
    await backBtn.click();

    // Verify we navigated back
    await expect(page).toHaveURL(/.*\/$/);
  });
});
