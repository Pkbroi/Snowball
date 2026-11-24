import { test, expect } from '@playwright/test';

// Right-click a Week cell → "Add above" / "Add below" inserts a new empty
// week directly above or below that row, between it and its neighbour.
// Row order is the order of the extra_weeks array, so insertion is a
// splice at the clicked row's index (above) or index + 1 (below); the
// same setExtraWeeks + setAllTrades discipline as the + button applies,
// so the new row survives a reload.

async function seedThreeWeeks(page) {
  await page.goto('/');
  for (let i = 0; i < 3; i++) await page.getByTestId('add-week-btn').click();
  const weekIds = await page.evaluate(async () => {
    const { getExtraWeeks } = await import('/src/data/storage.js');
    return getExtraWeeks().map((w) => w.id);
  });
  await page.evaluate(async (weekIds) => {
    const { setWeekLabel } = await import('/src/data/storage.js');
    const labels = [
      { weekStart: 'November', weekEnd: '3 – 7' },
      { weekStart: 'November', weekEnd: '10 – 14' },
      { weekStart: 'November', weekEnd: '17 – 21' },
    ];
    for (let i = 0; i < 3; i++) await setWeekLabel(weekIds[i], labels[i]);
  }, weekIds);
  // Let the debounced week-doc save land before the reload.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByTestId(`week-label-${weekIds[1]}`)).toBeVisible();
  return weekIds;
}

async function getWeekOrder(page) {
  return page.evaluate(async () => {
    const { getExtraWeeks, getWeekLabel } = await import('/src/data/storage.js');
    return getExtraWeeks().map((w) => {
      const lbl = getWeekLabel(w.id);
      return { id: w.id, start: lbl?.weekStart ?? w.weekStart, end: lbl?.weekEnd ?? w.weekEnd };
    });
  });
}

async function openMenu(page, weekId) {
  // Right-click the Week cell's top-left padding — not the Month/Dates
  // inputs, which keep the browser's native text menu.
  await page.getByTestId(`week-label-${weekId}`).click({ button: 'right', position: { x: 6, y: 6 } });
  await expect(page.getByTestId('week-ctx-menu')).toBeVisible();
}

test.describe('Insert row from the Week column', () => {
  test('Add above inserts between the row above and the current row', async ({ page }) => {
    test.setTimeout(120000);
    const [w1, w2, w3] = await seedThreeWeeks(page);
    await openMenu(page, w2);
    await expect(page.getByTestId('ctx-add-above')).toHaveText('Add above');
    await expect(page.getByTestId('ctx-add-below')).toHaveText('Add below');
    await page.getByTestId('ctx-add-above').click();
    await expect(page.getByTestId('week-ctx-menu')).toHaveCount(0);
    const order = await getWeekOrder(page);
    expect(order).toHaveLength(4);
    expect(order[0].id).toBe(w1);
    expect(order[1].start).toBe('');
    expect(order[1].end).toBe('');
    expect(order[2].id).toBe(w2);
    expect(order[3].id).toBe(w3);
    // The new row is a real empty week, not a copy: it has no label and
    // no chart, and it survives a reload in the same place.
    await page.reload();
    await expect(page.getByTestId(`week-label-${w1}`)).toBeVisible();
    const after = await getWeekOrder(page);
    expect(after).toHaveLength(4);
    expect(after[0].id).toBe(w1);
    expect(after[1].start).toBe('');
    expect(after[2].id).toBe(w2);
    expect(after[3].id).toBe(w3);
  });

  test('Add below inserts between the current row and the row below it', async ({ page }) => {
    test.setTimeout(120000);
    const [w1, w2, w3] = await seedThreeWeeks(page);
    await openMenu(page, w1);
    await page.getByTestId('ctx-add-below').click();
    const order = await getWeekOrder(page);
    expect(order).toHaveLength(4);
    expect(order[0].id).toBe(w1);
    expect(order[1].start).toBe('');
    expect(order[2].id).toBe(w2);
    expect(order[3].id).toBe(w3);
  });

  test('Add below on the last row appends at the end', async ({ page }) => {
    test.setTimeout(120000);
    const [w1, w2, w3] = await seedThreeWeeks(page);
    await openMenu(page, w3);
    await page.getByTestId('ctx-add-below').click();
    const order = await getWeekOrder(page);
    expect(order).toHaveLength(4);
    expect(order[0].id).toBe(w1);
    expect(order[1].id).toBe(w2);
    expect(order[2].id).toBe(w3);
    expect(order[3].start).toBe('');
  });

  test('menu closes on Escape, outside click, and right-click on an input keeps the native menu', async ({ page }) => {
    test.setTimeout(120000);
    const [, w2] = await seedThreeWeeks(page);
    await openMenu(page, w2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('week-ctx-menu')).toHaveCount(0);
    await openMenu(page, w2);
    await page.getByTestId(`day-cell-${w2}-Monday`).click();
    await expect(page.getByTestId('week-ctx-menu')).toHaveCount(0);
    // Right-clicking the Month input must not open the custom menu.
    await page.getByTestId(`week-label-${w2}`).locator('input').first().click({ button: 'right' });
    await expect(page.getByTestId('week-ctx-menu')).toHaveCount(0);
  });
});
