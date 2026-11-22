import { test, expect } from '@playwright/test';
import { ensureNotesEditor } from './helpers/notes-editor.js';

// Lazy Quill (perf step 8): the editor chunk loads only when the notes
// section is needed. Short viewport so the notes section starts below
// the fold — otherwise the IntersectionObserver would mount it on load.
test.describe('Lazy Quill editor (perf step 8)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await page.locator('[data-testid^="day-cell-"]').first().dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
  });

  const quillChunkLoaded = () => performance.getEntriesByType('resource')
    .some((e) => e.name.includes('quill.snow'));

  test('editor is not mounted on load; it mounts when the notes section scrolls into view', async ({ page }) => {
    // Chart and tags render first; the notes area is a placeholder.
    await expect(page.getByTestId('notes-editor-placeholder')).toBeVisible();
    await expect(page.getByTestId('notes-editor')).toHaveCount(0);
    expect(await page.evaluate(quillChunkLoaded)).toBe(false);

    // Scrolling the notes section into view mounts the editor — the
    // helper tolerates the placeholder unmounting mid-scroll when the
    // IntersectionObserver fires first.
    const editor = await ensureNotesEditor(page);
    await expect(editor).toBeVisible();
    expect(await page.evaluate(quillChunkLoaded)).toBe(true);
  });

  test('typing works as soon as the editor mounts — no keystroke lost', async ({ page }) => {
    const editor = await ensureNotesEditor(page);
    await editor.fill('Lazy quill types fine');
    await expect(page.locator('text="Saved ✓"').first()).toBeVisible();
    await expect(editor).toContainText('Lazy quill types fine');
  });

  test('pointerdown on the placeholder mounts the editor and focuses it, without scrolling', async ({ page }) => {
    const placeholder = page.getByTestId('notes-editor-placeholder');
    await expect(placeholder).toBeVisible();
    await expect(page.getByTestId('notes-editor')).toHaveCount(0);
    await page.evaluate(() => {
      document.querySelector('[data-testid="notes-editor-placeholder"]')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    const editor = await ensureNotesEditor(page);
    await expect(editor).toBeVisible();
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      return !!active && !!active.closest('.ql-editor');
    });
    expect(focused).toBe(true);
  });

  test('placeholder previews the saved notes before the editor mounts', async ({ page }) => {
    const editor = await ensureNotesEditor(page);
    await editor.fill('Placeholder preview note');
    await expect(page.locator('text="Saved ✓"').first()).toBeVisible();

    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/.*\/$/);
    // Reload the journal so the window scroll resets to the top: the
    // detail page otherwise reopens at the old scroll position, with
    // the notes section already in view and the editor mounted.
    await page.reload();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await page.locator('[data-testid^="day-cell-"]').first().dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);

    const placeholder = page.getByTestId('notes-editor-placeholder');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText('Placeholder preview note');
    await expect(page.getByTestId('notes-editor')).toHaveCount(0);
  });
});
