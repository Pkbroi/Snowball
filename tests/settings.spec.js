import { test, expect } from '@playwright/test';

test.describe('Settings panel (top-right, app theme)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  const openSettings = async (page) => {
    await page.getByTestId('settings-btn').click();
    await expect(page.getByTestId('settings-panel')).toBeVisible();
  };

  test('opens as a panel in the top-right corner, above the Remarks column, journal visible behind it', async ({ page }) => {
    await openSettings(page);
    const panel = page.getByTestId('settings-panel');
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    // Just under the 48px header, right edge 16px from the screen's right edge.
    expect(box.y).toBeGreaterThanOrEqual(56);
    expect(box.y).toBeLessThanOrEqual(64);
    expect(viewport.width - (box.x + box.width)).toBeLessThanOrEqual(20);
    // A floating panel, not a full page: narrower than the viewport, journal still visible.
    expect(box.width).toBeLessThanOrEqual(400);
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.getByTestId('dataset-selector')).toBeVisible();
    // App theme: pure black panel, bold white heading.
    await expect(panel).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    const heading = panel.locator('h2').first();
    await expect(heading).toHaveText('Settings');
    await expect(heading).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(heading).toHaveCSS('font-weight', '700');
  });

  test('Format offers two options: wipe this Index × Year, or delete the whole index', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByTestId('format-wipe-btn')).toContainText('Wipe Nifty 50 · 2026');
    await expect(page.getByTestId('format-wipe-btn')).toContainText('Wipe this Index × Year only');
    await expect(page.getByTestId('format-delete-btn')).toContainText('Delete Nifty 50 — all years');
    await expect(page.getByTestId('format-delete-btn')).toContainText('Delete this index with all its data');
    // Deep red warning icons, not the old pale rose.
    await expect(page.getByTestId('format-wipe-btn').locator('.material-symbols-outlined'))
      .toHaveCSS('color', 'rgb(220, 38, 38)');
  });

  test('wipe asks for confirmation with a data-loss warning; Cancel backs out', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('format-wipe-btn').click();
    const confirm = page.getByTestId('format-confirm');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('format-confirm-title')).toHaveText('Wipe Nifty 50 · 2026');
    await expect(confirm).toContainText('permanently wipe');
    await expect(confirm).toContainText('cannot be undone');
    await expect(page.getByTestId('format-confirm-ok')).toContainText('Yes, wipe');
    // Deep red confirm button.
    await expect(page.getByTestId('format-confirm-ok')).toHaveCSS('background-color', 'rgb(220, 38, 38)');
    await page.getByTestId('format-confirm-cancel').click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId('format-wipe-btn')).toBeVisible();
    await expect(page.getByTestId('format-delete-btn')).toBeVisible();
  });

  test('Escape backs out of the confirmation, then closes the panel', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('format-delete-btn').click();
    await expect(page.getByTestId('format-confirm')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('format-confirm')).toBeHidden();
    await expect(page.getByTestId('settings-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-panel')).toBeHidden();
  });

  test('confirming wipe empties only the current Index × Year', async ({ page }) => {
    // A week in Nifty 50 / 2026 and a week in Bank Nifty / 2026.
    await page.getByTestId('add-week-btn').click();
    await page.getByTestId('add-dataset-btn').click();
    await page.getByTestId('add-dataset-index-input').fill('Bank Nifty');
    await page.getByTestId('add-dataset-year-input').fill('2026');
    await page.getByTestId('add-dataset-submit').click();
    await page.getByTestId('add-week-btn').click();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);

    await openSettings(page);
    await page.getByTestId('format-wipe-btn').click();
    await page.getByTestId('format-confirm-ok').click();
    await page.waitForLoadState('load');

    // Nifty 50 / 2026 is empty; Bank Nifty / 2026 kept its week.
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(0);
    await page.getByTestId('dataset-index-select').selectOption('Bank Nifty');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
  });

  test('confirming delete removes the whole index, every year, and lands on a remaining dataset', async ({ page }) => {
    // Nifty 50 / 2026 and Nifty 50 / 2025 both hold a week; Bank Nifty / 2026 holds one too.
    await page.getByTestId('add-week-btn').click();
    await page.getByTestId('add-dataset-btn').click();
    await page.getByTestId('add-dataset-index-input').fill('Nifty 50');
    await page.getByTestId('add-dataset-year-input').fill('2025');
    await page.getByTestId('add-dataset-submit').click();
    await page.getByTestId('add-week-btn').click();
    await page.getByTestId('add-dataset-btn').click();
    await page.getByTestId('add-dataset-index-input').fill('Bank Nifty');
    await page.getByTestId('add-dataset-year-input').fill('2026');
    await page.getByTestId('add-dataset-submit').click();
    await page.getByTestId('add-week-btn').click();
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.getByTestId('dataset-year-select')).toHaveValue('2026');

    await openSettings(page);
    await page.getByTestId('format-delete-btn').click();
    const confirm = page.getByTestId('format-confirm');
    await expect(page.getByTestId('format-confirm-title')).toHaveText('Delete Nifty 50 — all years');
    await expect(confirm).toContainText('every year');
    await expect(confirm).toContainText('cannot be undone');
    await page.getByTestId('format-confirm-ok').click();
    await page.waitForLoadState('load');

    // Nifty 50 is gone from the index list entirely (both years); journal lands on Bank Nifty.
    // Auto-retrying assertions: a one-shot read can land mid-reload and throw.
    await expect(page.getByTestId('dataset-index-select').locator('option', { hasText: 'Nifty 50' })).toHaveCount(0);
    await expect(page.getByTestId('dataset-index-select').locator('option', { hasText: 'Bank Nifty' })).toHaveCount(1);
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Bank Nifty');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
  });

  test('deleting the only index recreates a fresh empty default journal', async ({ page }) => {
    await page.getByTestId('add-week-btn').click();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);

    await openSettings(page);
    await page.getByTestId('format-delete-btn').click();
    await page.getByTestId('format-confirm-ok').click();
    await page.waitForLoadState('load');

    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Nifty 50');
    await expect(page.getByTestId('dataset-year-select')).toHaveValue('2026');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(0);
  });
});
