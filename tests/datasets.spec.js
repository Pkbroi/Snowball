import { test, expect } from '@playwright/test';

test.describe('Index / Year datasets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('defaults to Nifty 50 / 2026 and shows the selectors between search and zoom', async ({ page }) => {
    const indexSelect = page.getByTestId('dataset-index-select');
    const yearSelect = page.getByTestId('dataset-year-select');
    await expect(indexSelect).toBeVisible();
    await expect(yearSelect).toBeVisible();
    await expect(indexSelect).toHaveValue('Nifty 50');
    await expect(yearSelect).toHaveValue('2026');
    // Placement: after the search input, before the zoom-out button.
    const searchBox = await page.getByTestId('search-input').boundingBox();
    const selectorBox = await page.getByTestId('dataset-selector').boundingBox();
    const zoomBox = await page.getByTestId('zoom-out-btn').boundingBox();
    expect(selectorBox.x).toBeGreaterThan(searchBox.x + searchBox.width);
    expect(selectorBox.x + selectorBox.width).toBeLessThanOrEqual(zoomBox.x);
    // Adding goes through the index list now: '+ New' is its last line,
    // and the header '+' button is gone.
    const indexOptions = await page.getByTestId('dataset-index-select').locator('option').allTextContents();
    expect(indexOptions[indexOptions.length - 1]).toBe('+ New');
    await expect(page.getByTestId('add-dataset-btn')).toHaveCount(0);
  });

  test('adding a week, switching dataset, and switching back keeps each dataset separate', async ({ page }) => {
    await page.getByTestId('add-week-btn').click();
    const row = page.locator('div[data-testid^="week-row-week-custom-"]').first();
    await expect(row).toBeVisible();

    // Create Bank Nifty / 2026 via '+ New' at the end of the index list.
    await page.getByTestId('dataset-index-select').selectOption('__add_new__');
    await page.getByTestId('add-dataset-index-input').fill('Bank Nifty');
    await page.getByTestId('add-dataset-year-input').fill('2026');
    await page.getByTestId('add-dataset-submit').click();

    // New dataset: empty journal, selectors show Bank Nifty / 2026.
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Bank Nifty');
    await expect(page.getByTestId('dataset-year-select')).toHaveValue('2026');
    // The newly added index appears in the index dropdown list…
    const indexOptions = await page.getByTestId('dataset-index-select').locator('option').allTextContents();
    expect(indexOptions).toContain('Bank Nifty');
    expect(indexOptions).toContain('Nifty 50');
    // …and its year appears in the year dropdown list.
    const yearOptions = await page.getByTestId('dataset-year-select').locator('option').allTextContents();
    expect(yearOptions).toContain('2026');
    await expect(row).not.toBeVisible();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(0);

    // Switch back to Nifty 50 / 2026: the week is back.
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Nifty 50');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
  });

  test('same index, different year is a separate journal', async ({ page }) => {
    await page.getByTestId('add-week-btn').click();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);

    await page.getByTestId('dataset-index-select').selectOption('__add_new__');
    await page.getByTestId('add-dataset-index-input').fill('Nifty 50');
    await page.getByTestId('add-dataset-year-input').fill('2025');
    await page.getByTestId('add-dataset-submit').click();

    await expect(page.getByTestId('dataset-year-select')).toHaveValue('2025');
    // The newly added year appears in the year dropdown list.
    const yearOptions = await page.getByTestId('dataset-year-select').locator('option').allTextContents();
    expect(yearOptions).toContain('2025');
    expect(yearOptions).toContain('2026');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(0);

    await page.getByTestId('dataset-year-select').selectOption('2026');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
  });

  test('switching index/year stays fast with weeks loaded', async ({ page }) => {
    // Seed 6 weeks in Nifty 50 / 2026, then time both directions of a switch.
    // (6 fits in the viewport — the grid virtualises rows below the fold,
    // so a larger count would under-count in the DOM, not in the data.)
    for (let i = 0; i < 6; i++) await page.getByTestId('add-week-btn').click();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(6);

    await page.getByTestId('dataset-index-select').selectOption('__add_new__');
    await page.getByTestId('add-dataset-index-input').fill('Bank Nifty');
    await page.getByTestId('add-dataset-year-input').fill('2026');
    await page.getByTestId('add-dataset-submit').click();
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Bank Nifty');

    const t1 = Date.now();
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(6);
    const switchBackMs = Date.now() - t1;

    const t2 = Date.now();
    await page.getByTestId('dataset-index-select').selectOption('Bank Nifty');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(0);
    const switchAwayMs = Date.now() - t2;

    // Switching only reloads that dataset's metadata + thumbnails (full
    // images stay lazy), so it must feel instant, not like a reload.
    expect(switchBackMs).toBeLessThan(5000);
    expect(switchAwayMs).toBeLessThan(5000);
  });

  test('adding an existing combination just switches to it', async ({ page }) => {
    await page.getByTestId('dataset-index-select').selectOption('__add_new__');
    await page.getByTestId('add-dataset-index-input').fill('Nifty 50');
    await page.getByTestId('add-dataset-year-input').fill('2026');
    await page.getByTestId('add-dataset-submit').click();
    // No duplicate: the index select still lists Nifty 50 once.
    const options = await page.getByTestId('dataset-index-select').locator('option').allTextContents();
    expect(options.filter((o) => o === 'Nifty 50')).toHaveLength(1);
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Nifty 50');
  });
});
