import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';
import { ensureNotesEditor } from './helpers/notes-editor.js';

// Previous / next day arrows in the page margins (fixed, like the Back
// button) step through the journal in grid order — Mon–Fri week by week,
// empty days included. Monday's prev is Friday of the week above,
// Friday's next is Monday of the week below; the ends are disabled.
// The route stays /trade/<weekId> — the day travels in router state and
// in sessionStorage (sb_last_day), so a reload lands on the new day.

async function seedTwoWeeks(page) {
  await page.goto('/');
  for (let i = 0; i < 2; i++) await page.getByTestId('add-week-btn').click();
  const weekIds = await page.evaluate(async () => {
    const { getExtraWeeks } = await import('/src/data/storage.js');
    return getExtraWeeks().map((w) => w.id);
  });
  await page.evaluate(async (weekIds) => {
    const { setWeekLabel } = await import('/src/data/storage.js');
    const labels = [
      { weekStart: 'November', weekEnd: '3 – 7' },
      { weekStart: 'November', weekEnd: '10 – 14' },
    ];
    for (let i = 0; i < 2; i++) await setWeekLabel(weekIds[i], labels[i]);
  }, weekIds);
  // Let the debounced week-doc save land before the reload.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByTestId(`week-label-${weekIds[0]}`)).toBeVisible();
  return weekIds;
}

async function openDay(page, weekId, day) {
  // Day cells open the detail page on DOUBLE-click (single click only
  // selects the cell).
  await page.getByTestId(`day-cell-${weekId}-${day}`).dblclick();
  await expect(page).toHaveURL(new RegExp(`/trade/${weekId}`));
  await expect(page.getByTestId('prev-day-btn')).toBeVisible();
  await expect(page.getByText(day, { exact: true }).first()).toBeVisible();
}

function chartFixture(testInfo, w, h) {
  const fixture = path.join(testInfo.outputDir, `chart-${w}x${h}.png`);
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(fixture, makeChartPng(w, h));
  return fixture;
}

test.describe('Previous / next day arrows', () => {
  test('next steps forward within the week, prev steps back', async ({ page }) => {
    test.setTimeout(120000);
    const [w1] = await seedTwoWeeks(page);
    await openDay(page, w1, 'Monday');
    await expect(page.getByTestId('prev-day-btn')).toBeDisabled();
    await page.getByTestId('next-day-btn').click();
    await expect(page.getByText('Tuesday', { exact: true }).first()).toBeVisible();
    await page.getByTestId('next-day-btn').click();
    await expect(page.getByText('Wednesday', { exact: true }).first()).toBeVisible();
    await page.getByTestId('prev-day-btn').click();
    await expect(page.getByText('Tuesday', { exact: true }).first()).toBeVisible();
    // Same week throughout — the route never changes week.
    await expect(page).toHaveURL(new RegExp(`/trade/${w1}`));
  });

  test('next on Friday crosses to Monday of the next week, prev crosses back', async ({ page }) => {
    test.setTimeout(120000);
    const [w1, w2] = await seedTwoWeeks(page);
    await openDay(page, w1, 'Friday');
    await page.getByTestId('next-day-btn').click();
    await expect(page).toHaveURL(new RegExp(`/trade/${w2}`));
    await expect(page.getByText('Monday', { exact: true }).first()).toBeVisible();
    await page.getByTestId('prev-day-btn').click();
    await expect(page).toHaveURL(new RegExp(`/trade/${w1}`));
    await expect(page.getByText('Friday', { exact: true }).first()).toBeVisible();
  });

  test('prev disabled on the first day, next disabled on the last day', async ({ page }) => {
    test.setTimeout(120000);
    const [w1, w2] = await seedTwoWeeks(page);
    await openDay(page, w1, 'Monday');
    await expect(page.getByTestId('prev-day-btn')).toBeDisabled();
    await expect(page.getByTestId('next-day-btn')).toBeEnabled();
    // Back to the journal to open a day of the other week.
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId(`week-label-${w2}`)).toBeVisible();
    await openDay(page, w2, 'Friday');
    await expect(page.getByTestId('next-day-btn')).toBeDisabled();
    await expect(page.getByTestId('prev-day-btn')).toBeEnabled();
  });

  test('a reload after navigating lands on the new day', async ({ page }) => {
    test.setTimeout(120000);
    const [w1] = await seedTwoWeeks(page);
    await openDay(page, w1, 'Monday');
    await page.getByTestId('next-day-btn').click();
    await page.getByTestId('next-day-btn').click();
    await expect(page.getByText('Wednesday', { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('prev-day-btn')).toBeVisible();
    await expect(page.getByText('Wednesday', { exact: true }).first()).toBeVisible();
  });

  test('the chart shown follows the day', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const [w1] = await seedTwoWeeks(page);
    const big = chartFixture(testInfo, 2560, 1440);
    const small = chartFixture(testInfo, 1280, 720);
    await openDay(page, w1, 'Wednesday');
    await page.locator('input[type="file"]').first().setInputFiles(big);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('original-badge')).toContainText('2560 × 1440');
    // Thursday has no chart yet — the dropzone shows instead.
    await page.getByTestId('next-day-btn').click();
    await expect(page.getByTestId('chart-dropzone')).toBeVisible();
    await page.locator('input[type="file"]').first().setInputFiles(small);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('original-badge')).toContainText('1280 × 720');
    // Back to Wednesday: the big chart is back.
    await page.getByTestId('prev-day-btn').click();
    await expect(page.getByTestId('original-badge')).toContainText('2560 × 1440');
  });

  test('the notes shown follow the day', async ({ page }) => {
    test.setTimeout(120000);
    const [w1] = await seedTwoWeeks(page);
    await page.evaluate(async (weekId) => {
      const { setNotes, flushWeekDoc } = await import('/src/data/storage.js');
      setNotes(weekId, 'Wednesday', '<p>wed notes marker</p>');
      setNotes(weekId, 'Thursday', '<p>thu notes marker</p>');
      await flushWeekDoc(weekId);
    }, w1);
    await page.waitForTimeout(700);
    await openDay(page, w1, 'Wednesday');
    const editor = await ensureNotesEditor(page);
    await expect(editor).toContainText('wed notes marker');
    await page.getByTestId('next-day-btn').click();
    await expect(page.getByText('Thursday', { exact: true }).first()).toBeVisible();
    const editor2 = await ensureNotesEditor(page);
    await expect(editor2).toContainText('thu notes marker');
    await expect(editor2).not.toContainText('wed notes marker');
  });
});
