import { test, expect } from '@playwright/test';

// Search is case-insensitive and precise: a query matches only the cells
// whose notes/tags/remarks/label actually contain it (any casing), and
// every matching cell gets a clear amber outline — including the remarks
// and week-label cells, which previously matched with no highlight at all.

async function addWeeks(page, n) {
  for (let i = 0; i < n; i++) await page.getByTestId('add-week-btn').click();
  await page.waitForTimeout(500);
  return page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid').replace('week-row-', '')));
}

async function search(page, q) {
  await page.getByTestId('search-input').fill(q);
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-testid^="week-row-"]')]
      .map((r) => r.getAttribute('data-testid').replace('week-row-', '')),
    outlined: [...document.querySelectorAll(
      '[data-testid^="day-cell-"], [data-testid^="remarks-cell-"], [data-testid^="week-label-"]',
    )].filter((el) => el.className.includes('ring-amber-400'))
      .map((el) => el.getAttribute('data-testid')),
  }));
}

test('notes: gapup matches only gapup cells, any casing', async ({ page }) => {
  await page.goto('/');
  const [A, B, C] = await addWeeks(page, 3);
  await page.evaluate(async ([a, b, c]) => {
    const s = await import('/src/data/storage.js');
    s.setNotes(a, 'Monday', '<p>GapUp</p>');
    s.setNotes(a, 'Tuesday', '<p>gapdown</p>');
    s.setNotes(b, 'Monday', '<p>GAPDOWN</p>');
    s.setNotes(c, 'Monday', '<p>gapup</p>');
  }, [A, B, C]);

  for (const q of ['gapup', 'GAPUP', 'GapUp']) {
    const r = await search(page, q);
    expect(r.rows).toEqual(expect.arrayContaining([A, C]));
    expect(r.rows).not.toContain(B);
    expect(r.outlined).toEqual(expect.arrayContaining([
      `day-cell-${A}-Monday`, `day-cell-${C}-Monday`,
    ]));
    expect(r.outlined).not.toContain(`day-cell-${A}-Tuesday`);
    expect(r.outlined).not.toContain(`day-cell-${B}-Monday`);
  }
});

test('tags: tag match outlines only that cell', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['GapUp']);
    s.setTags(a, 'Tuesday', ['gapdown']);
  }, [A]);
  const r = await search(page, 'gapup');
  expect(r.rows).toEqual([A]);
  expect(r.outlined).toEqual([`day-cell-${A}-Monday`]);
});

test('remarks: remarks match outlines the remarks cell, not day cells', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setRemarks(a, '<p>GapUp in remarks</p>');
  }, [A]);
  const r = await search(page, 'gapup');
  expect(r.rows).toEqual([A]);
  expect(r.outlined).toEqual([`remarks-cell-${A}`]);
});

test('week label: label match outlines the label cell', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.locator(`[data-testid="week-label-${A}"] input`).first().fill('GapUp');
  await page.locator(`[data-testid="week-label-${A}"] input`).first().blur();
  await page.waitForTimeout(300);
  const r = await search(page, 'gapup');
  expect(r.rows).toEqual([A]);
  expect(r.outlined).toEqual([`week-label-${A}`]);
});

test('trailing space still matches; empty cells never match', async ({ page }) => {
  await page.goto('/');
  const [A, B] = await addWeeks(page, 2);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setNotes(a, 'Monday', '<p>gapup</p>');
  }, [A]);
  const r = await search(page, 'gapup ');
  expect(r.rows).toEqual([A]);
  expect(r.outlined).toEqual([`day-cell-${A}-Monday`]);
  const r2 = await search(page, 'gapup');
  expect(r2.rows).not.toContain(B);
});
