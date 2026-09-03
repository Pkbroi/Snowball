import { test, expect } from '@playwright/test';

test.describe('Weekly Journal', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the index page before each test
    await page.goto('/');
  });

  test('should load the header correctly', async ({ page }) => {
    await expect(page.locator('text=Snowball')).toBeVisible();
    await expect(page.getByTestId('search-input')).toBeVisible();
  });

  test('should allow adding a new custom week row', async ({ page }) => {
    // Count initial rows (just counting how many week rows there are)
    // The initial rows are rendered from localStorage/default state.
    // Let's check how many elements match the pattern week-row-
    const initialRows = await page.locator('[data-testid^="week-row-"]').count();

    // Click the add week button
    await page.getByTestId('add-week-btn').click();

    // Verify row count    // It should exist
    const newWeekRow = page.locator('div[data-testid^="week-row-week-custom-"]').first();
    await expect(newWeekRow).toBeVisible();
  });

  test('should allow deleting a custom week row', async ({ page }) => {
    // Add a custom week
    await page.getByTestId('add-week-btn').click();
    
    const rowLocator = page.locator('div[data-testid^="week-row-week-custom-"]').first();
    await expect(rowLocator).toBeVisible();

    // Setup dialog handler to automatically accept the confirmation
    page.on('dialog', dialog => dialog.accept());
    
    const deleteBtn = page.locator('button[data-testid^="delete-week-week-custom-"]').first();
    
    // Since the button is visible on hover (opacity-0 group-hover:opacity-100),
    // we use force: true to click it directly.
    await deleteBtn.click({ force: true });
    
    // Row should be gone
    await expect(rowLocator).not.toBeVisible();
  });

  test('should search and filter rows', async ({ page }) => {
    // Add a week so the list isn't empty
    await page.getByTestId('add-week-btn').click();
    
    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('NonExistentQuery1234');
    
    // Should show "No rows matched"
    await expect(page.locator('text=No rows matched "NonExistentQuery1234"')).toBeVisible();

    await searchInput.fill(''); // clear
  });

  test('should open settings modal', async ({ page }) => {
    await page.getByTestId('settings-btn').click();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();
    // Close modal by pressing escape
    await page.keyboard.press('Escape');
    await expect(page.locator('h2:has-text("Settings")')).not.toBeVisible();
  });
});
