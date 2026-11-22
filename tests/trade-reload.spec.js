import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Bug 5: the detail page depended entirely on router location.state,
// so a reload or deep link showed "Trade not found" — getTradeById
// was a stub returning null. Now the trade is rebuilt from storage:
// the week (extra weeks + label + remarks) and each day's notes,
// tags, date and image meta, with the last-visited day preferred.

async function dispatchDrop(page, selector, b64) {
  await page.evaluate(async ({ selector, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'chart.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, { selector, b64 });
}

const firstCell = '[data-testid^="day-cell-"]';

test.describe('Trade reload / deep link (bug 5)', () => {
  test('reloading the detail page restores the trade and chart', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    await expect(page.locator(firstCell).first().locator('img')).toBeVisible({ timeout: 10000 });
    await page.locator(firstCell).first().dblclick();
    await expect(page.getByTestId('original-badge')).toContainText('800 × 450', { timeout: 10000 });
    await expect(page.getByText('Monday', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText('Trade not found')).toHaveCount(0);
    await expect(page.getByTestId('original-badge')).toContainText('800 × 450', { timeout: 10000 });
    await expect(page.getByText('Monday', { exact: true })).toBeVisible();
  });

  test('deep link in a fresh tab opens the trade on the first day with content', async ({ page, context }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    await expect(page.locator(firstCell).first().locator('img')).toBeVisible({ timeout: 10000 });
    await page.locator(firstCell).first().dblclick();
    await expect(page.getByTestId('original-badge')).toContainText('800 × 450', { timeout: 10000 });
    const tradeUrl = page.url();

    // A new tab has a fresh sessionStorage — no last-visited day — so
    // the rebuild must pick the first day with content (Monday).
    const page2 = await context.newPage();
    await page2.goto(tradeUrl);
    await expect(page2.getByText('Trade not found')).toHaveCount(0);
    await expect(page2.getByTestId('original-badge')).toContainText('800 × 450', { timeout: 10000 });
    await expect(page2.getByText('Monday', { exact: true })).toBeVisible();
  });

  test('reload returns to the last-visited day', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await expect(page.locator(firstCell).first()).toBeVisible();
    // Tuesday is the second cell of the first (only) row.
    await page.locator(firstCell).nth(1).dblclick();
    await expect(page.getByText('Tuesday', { exact: true })).toBeVisible({ timeout: 10000 });

    await page.reload();
    await expect(page.getByText('Trade not found')).toHaveCount(0);
    await expect(page.getByText('Tuesday', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('a bogus trade id still shows Trade not found', async ({ page }) => {
    await page.goto('/#/trade/no-such-week');
    await expect(page.getByText('Trade not found')).toBeVisible({ timeout: 10000 });
  });
});
