import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Rule-adherence point system: front-page Charts/Evaluation flip, the
// notes-page parameter panel, per-day scores that survive reload, and a
// parameter set that is global across days and editable in place.

const DEMO_SCORES = (w1, w2, w3) => [
  [w1, 'Monday',    { setup: 1, risk: 1, stoploss: 1, exit: 1, journal: 1, revenge: -1 }],
  [w1, 'Tuesday',   { setup: 1, risk: 1, stoploss: -1, exit: 1 }],
  [w1, 'Wednesday', { setup: 1, risk: -1, stoploss: -1 }],
  [w1, 'Thursday',  { setup: -1, risk: -1, stoploss: -1, revenge: -1, exit: 1 }],
  [w2, 'Monday',    { setup: 1, risk: 1, stoploss: -1 }],
  [w2, 'Tuesday',   { setup: -1, risk: -1, exit: -1, journal: 1 }],
  [w3, 'Monday',    { setup: 1, risk: 1, stoploss: 1, revenge: 1, exit: 1, journal: 1 }],
];
const CHART_CELLS = (w1, w2, w3) => [
  [w1, 'Monday'], [w1, 'Tuesday'], [w1, 'Wednesday'], [w1, 'Thursday'], [w1, 'Friday'],
  [w2, 'Monday'], [w2, 'Tuesday'],
  [w3, 'Monday'],
];

async function seed(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(400);
  }
  const weekIds = await page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-testid').replace('week-row-', '')),
  );
  expect(weekIds.length).toBe(3);
  const [w1, w2, w3] = weekIds;

  const png = makeChartPng(800, 450);
  const seeded = await page.evaluate(async ({ pngB64, cells }) => {
    const { setStoredImg, getStoredThumb } = await import('/src/data/storage.js');
    const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'chart.png', { type: 'image/png' });
    for (const [weekId, day] of cells) await setStoredImg(weekId, day, file);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (cells.every(([w, d]) => getStoredThumb(w, d))) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }, { pngB64: png.toString('base64'), cells: CHART_CELLS(w1, w2, w3) });
  expect(seeded).toBe(true);

  await page.evaluate(async ({ scores }) => {
    const { setRuleScores, flushAllWeekDocs } = await import('/src/data/storage.js');
    for (const [weekId, day, map] of scores) setRuleScores(weekId, day, map);
    await flushAllWeekDocs();
  }, { scores: DEMO_SCORES(w1, w2, w3) });
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator('[data-testid^="week-row-"]').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-testid^="day-cell-"] img').first()).toBeVisible({ timeout: 15000 });
  return { w1, w2, w3 };
}

async function openEvaluation(page, weekId, day) {
  await page.getByTestId(`day-cell-${weekId}-${day}`).dblclick();
  await expect(page.getByTestId('notes-view-toggle')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('notes-view-evaluation-btn').click();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('eval-panel')).toBeVisible({ timeout: 10000 });
}

test('front page flips to the evaluation report and back', async ({ page }) => {
  test.setTimeout(180000);
  const { w1 } = await seed(page);

  await page.getByTestId('view-evaluation-btn').click();
  await page.waitForTimeout(1000);
  const monday = page.getByTestId(`day-cell-${w1}-Monday`);
  await expect(monday).toContainText('+4');
  await expect(monday).toContainText('5 followed · 1 broke');
  const thursday = page.getByTestId(`day-cell-${w1}-Thursday`);
  await expect(thursday).toContainText('-3');
  await expect(thursday).toContainText('1 followed · 4 broke');
  await expect(page.getByTestId(`day-cell-${w1}-Friday`)).toContainText('Not scored yet');

  await page.getByTestId('view-charts-btn').click();
  await page.waitForTimeout(1000);
  await expect(monday.locator('img')).toBeVisible();
});

test('detail page scores survive a reload', async ({ page }) => {
  test.setTimeout(180000);
  const { w1 } = await seed(page);

  // Friday is unscored in the seed.
  await openEvaluation(page, w1, 'Friday');
  await expect(page.getByTestId('rule-check-total')).toHaveText('0');
  await page.getByTestId('param-setup').getByRole('button', { name: 'Followed +1' }).click();
  await expect(page.getByTestId('rule-check-total')).toHaveText('+1');
  await page.getByTestId('param-risk').getByRole('button', { name: 'Broke −1' }).click();
  await expect(page.getByTestId('rule-check-total')).toHaveText('0');

  await page.getByRole('button', { name: 'BACK' }).click();
  await expect(page.locator('[data-testid^="week-row-"]').first()).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(page.locator('[data-testid^="week-row-"]').first()).toBeVisible({ timeout: 30000 });
  await openEvaluation(page, w1, 'Friday');
  await expect(page.getByTestId('rule-check-total')).toHaveText('0');
  await expect(page.getByTestId('eval-panel')).toContainText('1 followed · 1 broke · 4 n/a');
});

test('parameters are global, default to N/A, and can be edited and deleted', async ({ page }) => {
  test.setTimeout(180000);
  const { w1 } = await seed(page);

  await openEvaluation(page, w1, 'Monday');
  await page.getByTestId('param-add-toggle-btn').click();
  await expect(page.getByTestId('param-add-row')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('param-add-name').fill('No FOMO trade');
  await page.getByTestId('param-add-points').fill('2');
  await page.getByTestId('param-add-btn').click();
  await expect(page.getByText('No FOMO trade')).toBeVisible({ timeout: 5000 });
  // The add line closes itself after adding; '+' reopens it for the next one.
  await expect(page.getByTestId('param-add-row')).toHaveCount(0);

  // Next day (day-arrow path): the parameter is there, N/A selected.
  await page.getByTestId('next-day-btn').click();
  await expect(page.getByTestId('eval-panel')).toBeVisible({ timeout: 10000 });
  const tuesdayRow = page.locator('[data-testid^="param-row-"]', { hasText: 'No FOMO trade' });
  await expect(tuesdayRow).toBeVisible({ timeout: 5000 });
  await expect(tuesdayRow.getByRole('button', { name: 'N/A' })).toHaveClass(/bg-white/);

  // Edit it through the right-click menu: rename + re-weight.
  const box = await tuesdayRow.boundingBox();
  await page.mouse.click(box.x + box.width - 120, box.y + box.height / 2, { button: 'right' });
  await expect(page.getByTestId('param-ctx-menu')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('param-ctx-edit').click();
  await expect(page.getByTestId('param-edit-name')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('param-edit-name')).toHaveValue('No FOMO trade');
  await expect(page.getByTestId('param-edit-points')).toHaveValue('2');
  await page.getByTestId('param-edit-name').fill('No FOMO');
  await page.getByTestId('param-edit-points').fill('3');
  await page.getByTestId('param-edit-save').click();
  const renamedRow = page.locator('[data-testid^="param-row-"]', { hasText: 'No FOMO' });
  await expect(renamedRow).toBeVisible({ timeout: 5000 });
  await expect(renamedRow.getByRole('button', { name: 'Followed +3' })).toBeVisible();

  // Delete it through the right-click menu: gone from the panel and the grid.
  const box2 = await renamedRow.boundingBox();
  await page.mouse.click(box2.x + box2.width - 120, box2.y + box2.height / 2, { button: 'right' });
  await expect(page.getByTestId('param-ctx-menu')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('param-ctx-delete').click();
  await expect(page.getByText('No FOMO')).toHaveCount(0);
  await page.getByRole('button', { name: 'BACK' }).click();
  await expect(page.locator('[data-testid^="week-row-"]').first()).toBeVisible({ timeout: 30000 });
  await page.getByTestId('view-evaluation-btn').click();
  await page.waitForTimeout(1000);
  await expect(page.locator('[title="No FOMO: n/a"]')).toHaveCount(0);
});
