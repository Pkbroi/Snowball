import { expect } from '@playwright/test';

// The notes editor mounts lazily (perf step 8): it loads when the notes
// section scrolls into view, or when the placeholder is clicked/focused.
// Specs must call this before touching the editor — the `notes-editor`
// testid does not exist until the mount happens.
export async function ensureNotesEditor(page) {
  const editor = page.getByTestId('notes-editor');
  // Wait for the notes section to render first: right after a
  // navigation (or a reload) the page is still mounting, and the
  // one-shot placeholder grab below only scrolls it into view if it
  // exists when it checks — if it checks too early, nothing scrolls
  // (The attach wait is 30s because the first mount in a run pays the
  // cold Vite transform of the detail-page + Quill chunks, which is
  // slow on this machine under load; the editor-visible wait below is
  // 60s for the same reason; the test timeout still caps the total,
  // so a genuinely broken mount fails at the test timeout.)
  await page.locator('[data-testid="notes-editor"], [data-testid="notes-editor-placeholder"]').first().waitFor({ state: 'attached', timeout: 30000 });
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
  // The editor-visible wait is 60s (not 30s): under full-suite load the
  // lazy Quill chunk transform + mount can take longer than 30s, and
  // the editor never became visible inside the old 30s wait in the
  // perf-4 full runs. The test timeout (120s — every notes-images spec
  // sets it) still caps the total, so a genuinely broken mount fails
  // at the test timeout.
  await expect(editor).toBeVisible({ timeout: 60000 });
  return editor;
}
