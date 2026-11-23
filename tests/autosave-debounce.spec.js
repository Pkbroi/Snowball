import { test, expect } from '@playwright/test';
import { ensureNotesEditor } from './helpers/notes-editor.js';

// Perf 3: notes/remarks autosave wrote the whole week document once
// per keystroke (20 keystrokes → 20 IndexedDB puts). Saves are now
// trailing-debounced 500ms at the single choke point (scheduleWeekSave),
// with a flush on leaving the detail page, closing the remarks modal,
// and on page unload — so a fast navigation or reload cannot lose the
// last keystrokes.

const TYPED = 'debounce-check-phrase';

async function openDetail(page) {
  await page.goto('/');
  await page.getByTestId('add-week-btn').click();
  await page.locator('[data-testid^="day-cell-"]').first().dblclick();
  const editor = await ensureNotesEditor(page);
  await editor.click();
  return editor;
}

// Count week-document puts: idb-keyval's set() calls
// IDBObjectStore.put(value, key), so patching put observes every
// write. Installed before the app loads, so nothing is missed.
async function installPutCounter(page) {
  await page.addInitScript(() => {
    window.__wkPuts = [];
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (typeof key === 'string' && key.includes('wk_')) {
        window.__wkPuts.push({ key, value });
      }
      return origPut.call(this, value, key);
    };
  });
}

async function wkPutCount(page) {
  return page.evaluate(() => window.__wkPuts.length);
}

async function resetPutCounter(page) {
  await page.evaluate(() => { window.__wkPuts = []; });
}

test.describe('Debounced autosave (perf 3)', () => {
  test('20 keystrokes in the notes write the week document once', async ({ page }) => {
    test.setTimeout(120000);
    await installPutCounter(page);
    await openDetail(page);
    await resetPutCounter(page);
    await page.keyboard.type(TYPED, { delay: 10 });
    // Nothing written yet — the 500ms debounce has not fired.
    expect(await wkPutCount(page)).toBe(0);
    await page.waitForFunction(() => window.__wkPuts.length === 1, null, { timeout: 10000 });
    const [put] = await page.evaluate(() => window.__wkPuts);
    expect(put.value.days.Monday.notes).toContain(TYPED);
  });

  test('typing then leaving immediately does not lose the notes', async ({ page }) => {
    test.setTimeout(120000);
    await installPutCounter(page);
    await openDetail(page);
    await resetPutCounter(page);
    await page.keyboard.type(TYPED, { delay: 10 });
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 15000 });
    // The unmount flush wrote within 300ms — the 500ms debounce never
    // had a chance. Without the flush the put would land at ~500ms.
    await page.waitForFunction(() => window.__wkPuts.length === 1, null, { timeout: 300 });
    await page.reload();
    await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-testid^="day-cell-"]').first().dblclick();
    const editor = await ensureNotesEditor(page);
    // The `notes-editor` testid is set on Quill's root itself
    // (.ql-editor), so the editor IS the text element — there is no
    // `.ql-editor` descendant to query.
    await expect(editor).toContainText(TYPED, { timeout: 15000 });
  });

  test('typing then reloading immediately does not lose the notes', async ({ page }) => {
    test.setTimeout(120000);
    await installPutCounter(page);
    await openDetail(page);
    await resetPutCounter(page);
    await page.keyboard.type(TYPED, { delay: 10 });
    await page.reload();
    // The reload lands back on the detail page (the hash survives),
    // and the notes come from IndexedDB — only the unload flush could
    // have written them in time. (ensureNotesEditor waits for the
    // notes section to render before scrolling it into view.)
    const editor = await ensureNotesEditor(page);
    await expect(editor).toContainText(TYPED, { timeout: 15000 });
  });
});
