import { test, expect } from '@playwright/test';

// Tag search language (2026-11-27): tag=(gapup+loss) for days with both
// tags, tag=(gapup+loss) + loss for both tags AND 'loss' in the notes,
// '+' = AND (intersection), ',' = OR (union), '+' binds tighter than ','.
// Tags match exactly, notes/remarks match as substrings, everything is
// case-insensitive. A bare word searches the notes only.

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

test('tag=(gapup+loss) matches only days with both tags', async ({ page }) => {
  await page.goto('/');
  const [A, B, C] = await addWeeks(page, 3);
  await page.evaluate(async ([a, b, c]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup', 'loss']);
    s.setTags(a, 'Tuesday', ['gapup']);
    s.setTags(b, 'Monday', ['loss', 'breakout']);
    s.setTags(c, 'Monday', ['gapup', 'loss']);
  }, [A, B, C]);
  const r = await search(page, 'tag=(gapup+loss)');
  expect(r.rows).toEqual(expect.arrayContaining([A, C]));
  expect(r.rows).not.toContain(B);
  expect(r.outlined).toEqual(expect.arrayContaining([
    `day-cell-${A}-Monday`, `day-cell-${C}-Monday`,
  ]));
  expect(r.outlined).not.toContain(`day-cell-${A}-Tuesday`);
  expect(r.outlined).not.toContain(`day-cell-${B}-Monday`);
});

test("user example: tag=(gapup+loss) + loss also requires 'loss' in the notes", async ({ page }) => {
  await page.goto('/');
  const [A, C] = await addWeeks(page, 2);
  await page.evaluate(async ([a, c]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup', 'loss']);
    s.setNotes(a, 'Monday', '<p>took a loss here</p>');
    s.setTags(c, 'Monday', ['gapup', 'loss']);
    s.setNotes(c, 'Monday', '<p>clean trade</p>');
  }, [A, C]);
  // Both tags alone: both weeks, both days.
  const r1 = await search(page, 'tag=(gapup+loss)');
  expect(r1.rows).toEqual(expect.arrayContaining([A, C]));
  expect(r1.outlined).toEqual(expect.arrayContaining([
    `day-cell-${A}-Monday`, `day-cell-${C}-Monday`,
  ]));
  // Adding '+ loss': only the day with 'loss' in its notes survives.
  const r2 = await search(page, 'tag=(gapup+loss) + loss');
  expect(r2.rows).toEqual([A]);
  expect(r2.outlined).toEqual([`day-cell-${A}-Monday`]);
});

test('OR: tag=(gapup,breakout) and top-level tag=(gapup) , tag=(breakout)', async ({ page }) => {
  await page.goto('/');
  const [A, B, C] = await addWeeks(page, 3);
  await page.evaluate(async ([a, b, c]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup']);
    s.setTags(b, 'Monday', ['breakout']);
    s.setTags(c, 'Monday', ['loss']);
  }, [A, B, C]);
  for (const q of ['tag=(gapup,breakout)', 'tag=(gapup) , tag=(breakout)']) {
    const r = await search(page, q);
    expect(r.rows).toEqual(expect.arrayContaining([A, B]));
    expect(r.rows).not.toContain(C);
    expect(r.outlined).toEqual(expect.arrayContaining([
      `day-cell-${A}-Monday`, `day-cell-${B}-Monday`,
    ]));
    expect(r.outlined).not.toContain(`day-cell-${C}-Monday`);
  }
});

test('precedence: + binds tighter than ,', async ({ page }) => {
  await page.goto('/');
  const [A, B, C] = await addWeeks(page, 3);
  await page.evaluate(async ([a, b, c]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup']);
    s.setNotes(a, 'Monday', '<p>took a loss</p>');
    s.setTags(b, 'Monday', ['gapup']);
    s.setNotes(b, 'Monday', '<p>clean</p>');
    s.setNotes(c, 'Monday', '<p>breakout day</p>');
  }, [A, B, C]);
  // (gapup AND loss) OR breakout-notes: A (both) and C (breakout) match;
  // B has the tag but no 'loss' in its notes.
  const r = await search(page, 'tag=gapup + loss , breakout');
  expect(r.rows).toEqual(expect.arrayContaining([A, C]));
  expect(r.rows).not.toContain(B);
  expect(r.outlined).toEqual(expect.arrayContaining([
    `day-cell-${A}-Monday`, `day-cell-${C}-Monday`,
  ]));
  expect(r.outlined).not.toContain(`day-cell-${B}-Monday`);
});

test('case-insensitive, and tag=gapup works without brackets', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['GapUp', 'Loss']);
    s.setNotes(a, 'Monday', '<p>took a LOSS</p>');
  }, [A]);
  for (const q of ['TAG=(GAPUP+LOSS) + LOSS', 'tag=gapup', 'TAG=GAPUP']) {
    const r = await search(page, q);
    expect(r.rows).toEqual([A]);
    expect(r.outlined).toEqual([`day-cell-${A}-Monday`]);
  }
});

test('tags match exactly: tag=(gap) matches the gap tag, not gapup', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup']);
    s.setTags(a, 'Tuesday', ['gap']);
  }, [A]);
  const r = await search(page, 'tag=(gap)');
  expect(r.rows).toEqual([A]);
  expect(r.outlined).toEqual([`day-cell-${A}-Tuesday`]);
});

test('rem= outlines the remarks cell only; tag + rem= narrows to that week', async ({ page }) => {
  await page.goto('/');
  const [A, B] = await addWeeks(page, 2);
  await page.evaluate(async ([a, b]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup']);
    s.setRemarks(a, '<p>expiry week</p>');
    s.setTags(b, 'Monday', ['gapup']);
    s.setRemarks(b, '<p>normal week</p>');
  }, [A, B]);
  // rem= alone: both weeks stay (their remarks cells are the match) but
  // no day cell is outlined — the days matched nothing themselves.
  const r1 = await search(page, 'rem=expiry');
  expect(r1.rows).toEqual([A]);
  expect(r1.outlined).toEqual([`remarks-cell-${A}`]);
  // tag + rem=: only the gapup day in the expiry week.
  const r2 = await search(page, 'tag=gapup + rem=expiry');
  expect(r2.rows).toEqual([A]);
  expect(r2.outlined).toEqual(expect.arrayContaining([
    `day-cell-${A}-Monday`, `remarks-cell-${A}`,
  ]));
});

test('bare word no longer matches tags, remarks or the week label', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup']);
    s.setRemarks(a, '<p>gapup in remarks</p>');
  }, [A]);
  await page.locator(`[data-testid="week-label-${A}"] input`).first().fill('GapUp');
  await page.locator(`[data-testid="week-label-${A}"] input`).first().blur();
  await page.waitForTimeout(300);
  const r = await search(page, 'gapup');
  expect(r.rows).toEqual([]);
  expect(r.outlined).toEqual([]);
});
