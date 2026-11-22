import { expect } from '@playwright/test';

// The notes editor mounts lazily (perf step 8): it loads when the notes
// section scrolls into view, or when the placeholder is clicked/focused.
// Specs must call this before touching the editor — the `notes-editor`
// testid does not exist until the mount happens.
export async function ensureNotesEditor(page) {
  const editor = page.getByTestId('notes-editor');
  if ((await editor.count()) === 0) {
    // Scrolling the placeholder into view triggers the mount — but the
    // IntersectionObserver may mount the editor on its own first, which
    // unmounts the placeholder mid-scroll. That is the outcome we want,
    // so a detached-placeholder error is swallowed here; the wait below
    // proves the editor actually arrived.
    await page.getByTestId('notes-editor-placeholder').scrollIntoViewIfNeeded().catch(() => {});
  }
  await expect(editor).toBeVisible();
  return editor;
}
