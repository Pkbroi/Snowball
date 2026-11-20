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

  test('column headings are matte black with bold white text, week labels are bold', async ({ page }) => {
    await page.getByTestId('add-week-btn').click();
    const weekLabel = page.locator('[data-testid^="week-label-"]').first();
    await expect(weekLabel).toBeVisible();
    await weekLabel.locator('input').first().fill('Nov');
    await weekLabel.locator('input').nth(1).fill('17 – 21');

    // Headings row: pure black background, bold white text.
    const headings = page.locator('text=WEEK').first();
    const headerRow = headings.locator('xpath=ancestor::div[contains(@class, "grid")][1]');
    const headerStyle = await headerRow.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, weight: cs.fontWeight, color: cs.color };
    });
    expect(headerStyle.bg).toBe('rgb(0, 0, 0)');
    expect(headerStyle.weight).toBe('700');
    expect(headerStyle.color).toBe('rgb(255, 255, 255)');
    // Week label inputs: both lines bold.
    const weights = await weekLabel.evaluate((el) => [...el.querySelectorAll('input')].map((i) => getComputedStyle(i).fontWeight));
    expect(weights).toHaveLength(2);
    expect(weights[0]).toBe('700');
    expect(weights[1]).toBe('700');
  });

  test('search bar is matte black with bold white text, like the buttons', async ({ page }) => {
    const input = page.getByTestId('search-input');
    await input.fill('17');
    const style = await input.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, weight: cs.fontWeight, color: cs.color };
    });
    expect(style.bg).toBe('rgb(0, 0, 0)');
    expect(style.weight).toBe('700');
    expect(style.color).toBe('rgb(255, 255, 255)');
  });

  test('remarks typed in the modal show in the front-page cell: first 5 lines, bold white', async ({ page }) => {
    await page.getByTestId('add-week-btn').click();
    const cell = page.locator('[data-testid^="remarks-cell-"]').first();
    await expect(cell).toBeVisible();
    await cell.click();
    await expect(page.locator('.remarks-modal-container')).toBeVisible();
    const editor = page.locator('.remarks-modal-container .ql-editor');
    await editor.click();
    await page.keyboard.type('Line one of the remarks\nLine two here\nLine three here\nLine four here\nLine five here\nLine six here\nLine seven here');
    await page.waitForTimeout(900); // let the save land
    await page.keyboard.press('Escape');
    await expect(page.locator('.remarks-modal-container')).toHaveCount(0);
    // The cell updates without a reload: first 5 lines only, bold white.
    const text = await cell.innerText();
    expect(text).toContain('Line one of the remarks');
    expect(text).toContain('Line two here');
    expect(text).toContain('Line three here');
    expect(text).toContain('Line four here');
    expect(text).toContain('Line five here');
    expect(text).not.toContain('Line six');
    expect(text).not.toContain('Line seven');
    const textDiv = cell.locator('div').first();
    const style = await textDiv.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { weight: cs.fontWeight, color: cs.color };
    });
    expect(style.weight).toBe('700');
    expect(style.color).toBe('rgb(255, 255, 255)');
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
