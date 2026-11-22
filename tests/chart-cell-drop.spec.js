import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Bug 3: dropping a file onto a cell that already has a chart used to
// navigate the whole app away to the raw image (the image branch had no
// drop/paste handlers), leaving the app unusable until restart. Pasting
// onto a chart cell silently did nothing. The fix gives the image branch
// the same handlers as the empty branch (the drop replaces the chart),
// the detail page's chart container the same handlers as its dropzone,
// and adds a window-level dragover/drop guard so a file dropped anywhere
// else can never navigate the app away.

async function dispatchDrop(page, selector, b64, filename = 'chart.png') {
  await page.evaluate(async ({ selector, b64, filename }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, { selector, b64, filename });
}

async function dispatchPaste(page, selector, b64, filename = 'chart.png') {
  await page.evaluate(async ({ selector, b64, filename }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector(selector);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { selector, b64, filename });
}

async function addWeek(page) {
  await page.goto('/');
  await page.getByTestId('add-week-btn').click();
  await expect(page.locator('[data-testid^="day-cell-"]').first()).toBeVisible();
}

const firstCell = '[data-testid^="day-cell-"]';

test.describe('Drop/paste onto chart cells (bug 3)', () => {
  test('drop onto an empty cell uploads the chart and stays on the journal', async ({ page }) => {
    await addWeek(page);
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    await expect(page.locator(firstCell).first().locator('img')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/.*\/$/);
  });

  test('drop onto a cell with a chart replaces it and does not navigate away', async ({ page }) => {
    await addWeek(page);
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    const img = page.locator(firstCell).first().locator('img');
    await expect(img).toBeVisible({ timeout: 10000 });
    const srcBefore = await img.getAttribute('src');

    await dispatchDrop(page, firstCell, makeChartPng(400, 225).toString('base64'), 'replacement.png');
    // The thumbnail URL changes once the replacement lands.
    await expect.poll(async () => img.getAttribute('src'), { timeout: 10000 }).not.toBe(srcBefore);
    // Still on the journal, not on a raw image page.
    await expect(page).toHaveURL(/.*\/$/);
    await expect(page.getByTestId('add-week-btn')).toBeVisible();
    // The stored original is the replacement: the detail page's badge
    // reads its dimensions from the stored image metadata.
    await page.locator(firstCell).first().dblclick();
    await expect(page.getByTestId('original-badge')).toContainText('400 × 225', { timeout: 10000 });
  });

  test('paste onto a cell with a chart replaces it', async ({ page }) => {
    await addWeek(page);
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    const img = page.locator(firstCell).first().locator('img');
    await expect(img).toBeVisible({ timeout: 10000 });
    const srcBefore = await img.getAttribute('src');

    await page.locator(firstCell).first().click(); // focus the cell, as a real Ctrl+V would need
    await dispatchPaste(page, firstCell, makeChartPng(400, 225).toString('base64'), 'pasted.png');
    await expect.poll(async () => img.getAttribute('src'), { timeout: 10000 }).not.toBe(srcBefore);
    await expect(page).toHaveURL(/.*\/$/);
    await page.locator(firstCell).first().dblclick();
    await expect(page.getByTestId('original-badge')).toContainText('400 × 225', { timeout: 10000 });
  });

  test('drop onto the header does not navigate and does not upload', async ({ page }) => {
    await addWeek(page);
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    const img = page.locator(firstCell).first().locator('img');
    await expect(img).toBeVisible({ timeout: 10000 });
    const srcBefore = await img.getAttribute('src');

    await dispatchDrop(page, '[data-testid="search-input"]', makeChartPng(400, 225).toString('base64'));
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/.*\/$/);
    await expect(page.getByTestId('add-week-btn')).toBeVisible();
    expect(await img.getAttribute('src')).toBe(srcBefore);
  });

  test('drop onto the detail page chart replaces it', async ({ page }) => {
    await addWeek(page);
    await dispatchDrop(page, firstCell, makeChartPng(800, 450).toString('base64'));
    await expect(page.locator(firstCell).first().locator('img')).toBeVisible({ timeout: 10000 });
    await page.locator(firstCell).first().dblclick();
    await expect(page.getByTestId('original-badge')).toContainText('800 × 450', { timeout: 10000 });

    await dispatchDrop(page, '[data-testid="chart-image-container"]', makeChartPng(400, 225).toString('base64'), 'replacement.png');
    await expect(page.getByTestId('original-badge')).toContainText('400 × 225', { timeout: 10000 });
    await expect(page).toHaveURL(/trade/);
  });
});
