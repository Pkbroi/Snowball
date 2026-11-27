import { test, expect } from '@playwright/test';
import { ensureNotesEditor } from './helpers/notes-editor.js';

// Search outline must survive a detail visit (2026-11-27). Opening the
// detail page made Quill re-serialise the stored notes (plain spaces
// became &nbsp;) and a multi-word notes term ("loss here") stopped
// matching the visited day, so its outline — and the row, when it was
// the only match — vanished on return. Two fixes: getNotesText /
// getRemarksText decode entities for the search index, and the editors
// no longer persist Quill's mount echo. The marking is deep blue
// (ring-blue-700) since this round.

async function addWeeks(page, n) {
  for (let i = 0; i < n; i++) await page.getByTestId('add-week-btn').click();
  await page.waitForTimeout(500);
  return page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid').replace('week-row-', '')));
}

async function searchState(page) {
  return page.evaluate(() => ({
    input: document.querySelector('[data-testid="search-input"]')?.value ?? '(no input)',
    rows: [...document.querySelectorAll('[data-testid^="week-row-"]')]
      .map((r) => r.getAttribute('data-testid').replace('week-row-', '')),
    outlined: [...document.querySelectorAll('[data-testid^="day-cell-"], [data-testid^="remarks-cell-"]')]
      .filter((el) => el.className.includes('ring-blue-700'))
      .map((el) => el.getAttribute('data-testid')),
  }));
}

test('phrase notes search keeps its outline — and its row — after visiting the cell', async ({ page }) => {
  await page.goto('/');
  const [A, B] = await addWeeks(page, 2);
  await page.evaluate(async ([a, b]) => {
    const s = await import('/src/data/storage.js');
    s.setTags(a, 'Monday', ['gapup']);
    s.setNotes(a, 'Monday', '<p>took a loss here</p>');
    s.setTags(b, 'Monday', ['gapup']);
    s.setNotes(b, 'Monday', '<p>clean trade today</p>');
  }, [A, B]);

  await page.getByTestId('search-input').fill('loss here');
  await page.waitForTimeout(500);
  let st = await searchState(page);
  expect(st.rows).toEqual([A]);
  expect(st.outlined).toEqual([`day-cell-${A}-Monday`]);
  await expect(page.getByTestId(`day-cell-${A}-Monday`)).toHaveClass(/ring-blue-700/);

  // Open the cell's detail page and let the notes editor mount — the
  // mount is what used to re-serialise (and rewrite) the notes.
  await page.getByTestId(`day-cell-${A}-Monday`).dblclick();
  await expect(page).toHaveURL(/\/trade\/.*/);
  await ensureNotesEditor(page);
  await page.waitForTimeout(500);

  // Come back: the row, the outline and the stored notes must all be
  // exactly as they were before the visit.
  await page.getByLabel('Back to Journal').click();
  await expect(page.getByTestId('add-week-btn')).toBeVisible();
  await page.waitForTimeout(500);
  st = await searchState(page);
  expect(st.input).toBe('loss here');
  expect(st.rows).toEqual([A]);
  expect(st.outlined).toEqual([`day-cell-${A}-Monday`]);
  await expect(page.getByTestId(`day-cell-${A}-Monday`)).toHaveClass(/ring-blue-700/);
  const notesA = await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    return s.getNotes(a, 'Monday');
  }, [A]);
  expect(notesA).toBe('<p>took a loss here</p>');
});

test('opening the remarks modal does not rewrite the stored remarks', async ({ page }) => {
  await page.goto('/');
  const [A] = await addWeeks(page, 1);
  await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    s.setRemarks(a, '<p>expiry week</p>');
  }, [A]);

  // A rem= phrase search outlines the remarks cell before the visit.
  await page.getByTestId('search-input').fill('rem=expiry week');
  await page.waitForTimeout(500);
  let st = await searchState(page);
  expect(st.rows).toEqual([A]);
  expect(st.outlined).toEqual([`remarks-cell-${A}`]);

  // Open the modal (the mount is what used to rewrite the remarks),
  // then close it without typing.
  await page.getByTestId(`remarks-cell-${A}`).click();
  await expect(page.locator('.remarks-modal-container')).toBeVisible();
  await expect(page.locator('.remarks-modal-container .ql-editor')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect(page.locator('.remarks-modal-container')).toHaveCount(0);
  await page.waitForTimeout(500);

  const remarksA = await page.evaluate(async ([a]) => {
    const s = await import('/src/data/storage.js');
    return s.getRemarks(a);
  }, [A]);
  expect(remarksA).toBe('<p>expiry week</p>');
  st = await searchState(page);
  expect(st.rows).toEqual([A]);
  expect(st.outlined).toEqual([`remarks-cell-${A}`]);
});
