import { test, expect } from '@playwright/test';

test.describe('Performance & Data Scaling', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the index page before each test
    await page.goto('/');
  });

  test('should handle adding 20 weeks rapidly without crashing', async ({ page }) => {
    test.setTimeout(60000); // Allow more time for rapid additions

    // Verify initial load
    await expect(page.locator('text=Snowball')).toBeVisible();

    // Click the "add week" button 20 times to simulate high data entry
    const addBtn = page.getByTestId('add-week-btn');
    
    for (let i = 0; i < 20; i++) {
      await addBtn.click();
    }

    // Use auto-retrying assertions instead of hardcoded timeouts
    // Verify that at least 20 custom weeks exist in the DOM
    const customRows = page.locator('div[data-testid^="week-row-week-custom-"]');
    await expect(customRows).toHaveCount(20, { timeout: 15000 });

    // Test search functionality under load
    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('NonExistentQueryForPerformance');
    await expect(page.locator('text=No rows matched "NonExistentQueryForPerformance"')).toBeVisible();
    await searchInput.fill('');
    
    // Validate UI responsiveness remains
    await expect(page.getByTestId('settings-btn')).toBeVisible();
  });
});
