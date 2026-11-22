import { expect } from '@playwright/test';

// The notes editor mounts lazily (perf step 8): it loads when the notes
// section scrolls into view, or when the placeholder is clicked/focused.
// Specs must call this before touching the editor — the `notes-editor`
// testid does not exist until the mount happens.
export async function ensureNotesEditor(page) {
  const editor = page.getByTestId('notes-editor');
  if ((await editor.count()) === 0) {
    // Scroll the placeholder into view so the IntersectionObserver
    // mounts the editor. The placeholder is grabbed with elementHandle
    // (a one-shot lookup, no waiting): locator.evaluate / 
    // scrollIntoViewIfNeeded would wait up to 30s for a placeholder
    // that never comes back once the editor mounts — that wait ate the
    // whole test timeout in the notes-images spec under suite load.
    // If there is no placeholder either, the editor is mid-mount (the
    // chunk is loading) and the wait below covers it. The wait is
    // generous because the lazy Quill chunk fetch is slow under load.
    const handle = await page.getByTestId('notes-editor-placeholder').elementHandle().catch(() => null);
    if (handle) {
      await handle.evaluate((el) => el.scrollIntoView({ block: 'nearest' })).catch(() => {});
    }
  }
  await expect(editor).toBeVisible({ timeout: 15000 });
  return editor;
}
