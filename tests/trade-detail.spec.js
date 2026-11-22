import { test, expect } from '@playwright/test';
import { ensureNotesEditor } from './helpers/notes-editor.js';

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
    
    // Verify the notes editor exists (it mounts lazily when the notes
    // section scrolls into view — see ensureNotesEditor).
    await ensureNotesEditor(page);
  });

  test('should display auto-save indicator when notes are typed', async ({ page }) => {
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await firstDayCell.dblclick();

    const editor = await ensureNotesEditor(page);
    await editor.fill('Testing auto save');

    // Wait for the "Saved ✓" indicator to appear
    const saveIndicator = page.locator('text="Saved ✓"').first();
    await expect(saveIndicator).toBeVisible();
  });

  test('notes text is bold by default, with nothing selected', async ({ page }) => {
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await firstDayCell.dblclick();

    const editor = await ensureNotesEditor(page);
    await editor.fill('Bold without selecting anything');
    await expect(editor).toContainText('Bold without selecting anything');
    // The editor itself and the typed paragraph both render bold (700).
    const weights = await editor.evaluate((el) => ({
      editor: getComputedStyle(el).fontWeight,
      paragraph: getComputedStyle(el.querySelector('p')).fontWeight,
    }));
    expect(weights.editor).toBe('700');
    expect(weights.paragraph).toBe('700');
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
