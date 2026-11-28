import { test, expect } from '@playwright/test';

// Bug 9: switching datasets left stale filter state behind — the
// pending search-debounce timer was never cancelled (so the typed
// search re-applied to the new dataset within 100ms), and the date
// filter was never reset. handleSwitchDataset must clear both.
async function createBankNifty(page) {
  await page.getByTestId('dataset-index-select').selectOption('__add_new__');
  await page.getByTestId('add-dataset-index-input').fill('Bank Nifty');
  await page.getByTestId('add-dataset-year-input').fill('2026');
  await page.getByTestId('add-dataset-submit').click();
  await expect(page.getByTestId('dataset-index-select')).toHaveValue('Bank Nifty');
}

// Switch datasets in-page, without Playwright's actionability waits,
// so the switch lands inside the search debounce window (100ms).
async function switchDatasetFast(page, index) {
  await page.evaluate((idx) => {
    const sel = document.querySelector('[data-testid="dataset-index-select"]');
    sel.value = idx;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
}

test.describe('Dataset switch clears filters (bug 9)', () => {
  test('a search typed just before the switch does not follow to the new dataset', async ({ page }) => {
    await page.goto('/');
    await createBankNifty(page);
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Nifty 50');

    // Type, then switch inside the 100ms debounce window: the pending
    // commit must be cancelled, not applied to Bank Nifty afterwards.
    await page.getByTestId('search-input').fill('gapup');
    await switchDatasetFast(page, 'Bank Nifty');
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Bank Nifty');
    await page.waitForTimeout(300); // past the debounce window
    await expect(page.getByTestId('search-input')).toHaveValue('');
  });

  test('an active date filter does not follow to the new dataset', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
    await createBankNifty(page);
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Nifty 50');

    // Apply a date filter that matches nothing, so the row is hidden
    // and the filter dot shows on the calendar button.
    await page.locator('button[title="Go to date filter"]').click();
    await page.locator('input[type="date"]').first().fill('2020-01-01');
    await page.getByRole('button', { name: 'Go to', exact: true }).click();
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(0);
    await expect(page.locator('button[title="Go to date filter"] span.bg-primary')).toHaveCount(1);

    await page.getByTestId('dataset-index-select').selectOption('Bank Nifty');
    await expect(page.getByTestId('dataset-index-select')).toHaveValue('Bank Nifty');
    // The filter is gone: no dot, and switching back shows the row again.
    await expect(page.locator('button[title="Go to date filter"] span.bg-primary')).toHaveCount(0);
    await page.getByTestId('dataset-index-select').selectOption('Nifty 50');
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);
  });
});
