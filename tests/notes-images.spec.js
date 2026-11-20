import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Pictures pasted/dropped into the notes editor: right-click to select,
// dotted outline + 8 handles to resize, × button to delete.

async function openDetailWithNotesImage(page) {
  await page.goto('/');
  await page.getByTestId('add-week-btn').click();
  await page.locator('[data-testid^="day-cell-"]').first().dblclick();
  const editor = page.getByTestId('notes-editor');
  await expect(editor).toBeVisible();
  const png = makeChartPng(800, 450);
  await editor.click();
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'note.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.querySelector('.ql-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  const img = editor.locator('img');
  await expect(img).toHaveCount(1, { timeout: 10000 });
  return { editor, img };
}

async function reopenCell(page) {
  await page.getByTestId('back-button').click();
  await expect(page).toHaveURL(/.*\/$/);
  await page.locator('[data-testid^="day-cell-"]').first().dblclick();
  const editor = page.getByTestId('notes-editor');
  await expect(editor).toBeVisible();
  return editor;
}

test.describe('Notes pictures', () => {
  test('right-click selects the picture: dotted outline, handles, delete button', async ({ page }) => {
    const { editor, img } = await openDetailWithNotesImage(page);
    const box = await img.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    const overlay = page.getByTestId('notes-img-overlay');
    await expect(overlay).toBeVisible();
    // Dotted perimeter, sized to the picture.
    const overlayStyle = await overlay.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth };
    });
    expect(overlayStyle.borderStyle).toBe('dotted');
    const overlayBox = await overlay.boundingBox();
    expect(Math.abs(overlayBox.width - box.width)).toBeLessThan(3);
    expect(Math.abs(overlayBox.height - box.height)).toBeLessThan(3);
    // 8 handles + the × button at the top-right corner.
    await expect(page.locator('[data-handle]')).toHaveCount(8);
    const delBtn = page.getByTestId('notes-img-delete');
    await expect(delBtn).toBeVisible();
    const delBox = await delBtn.boundingBox();
    expect(Math.abs(delBox.x + delBox.width / 2 - (box.x + box.width))).toBeLessThan(12);
    expect(Math.abs(delBox.y + delBox.height / 2 - box.y)).toBeLessThan(12);
    // The × deletes the picture, and the deletion sticks after reopening.
    await delBtn.click();
    await expect(editor.locator('img')).toHaveCount(0);
    await page.waitForTimeout(800); // let the autosave land
    const editor2 = await reopenCell(page);
    await expect(editor2.locator('img')).toHaveCount(0);
  });

  test('dragging a corner handle resizes the picture and the size persists', async ({ page }) => {
    const { editor, img } = await openDetailWithNotesImage(page);
    const before = await img.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
    expect(before.w).toBe(800);
    const box = await img.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(page.getByTestId('notes-img-overlay')).toBeVisible();
    const se = page.locator('[data-handle="se"]');
    await se.scrollIntoViewIfNeeded();
    const hbox = await se.boundingBox();
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(hbox.x + hbox.width / 2 - 120, hbox.y + hbox.height / 2 - 60, { steps: 10 });
    await page.mouse.up();
    const after = await img.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight, style: el.getAttribute('style') }));
    expect(after.w).toBeLessThan(before.w - 50);
    expect(after.h).toBeLessThan(before.h - 20);
    expect(after.style).toContain('width');
    // The new size survives leaving and coming back.
    await page.waitForTimeout(800); // let the autosave land
    const editor2 = await reopenCell(page);
    const img2 = editor2.locator('img');
    await expect(img2).toHaveCount(1, { timeout: 10000 });
    const persisted = await img2.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
    expect(persisted.w).toBe(after.w);
    expect(persisted.h).toBe(after.h);
  });

  test('left-click still shows the resize overlay', async ({ page }) => {
    const { img } = await openDetailWithNotesImage(page);
    await img.click();
    await expect(page.getByTestId('notes-img-overlay')).toBeVisible();
    await expect(page.locator('[data-handle]')).toHaveCount(8);
  });
});
