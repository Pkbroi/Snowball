import { test, expect } from '@playwright/test';

// Bug 6: createDerivative used to return the source unchanged on
// failure, and the thumb callers only checked `instanceof Blob` — so
// a failed derivation stored the full-res image as the thumb (and
// marked it known, so nothing ever retried). Now a failed derivation
// returns null, and no thumb is persisted. A corrupt image still
// stores its original losslessly and shows via the full-image
// fallback; the thumb is derived again on the next startup backfill.

async function dispatchDrop(page, selector, file) {
  await page.evaluate(async ({ selector, name, type, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const f = new File([bytes], name, { type });
    const dt = new DataTransfer();
    dt.items.add(f);
    const el = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, { selector, name: file.name, type: file.type, b64: file.b64 });
}

const firstCell = '[data-testid^="day-cell-"]';
// Bytes that are not an image at all — decoding fails everywhere,
// while storage itself never validates the bytes.
const garbageB64 = Buffer.from('this is not an image at all, just text pretending to be a png').toString('base64');

test.describe('Derivative failure (bug 6)', () => {
  test('a corrupt upload stores the original but no thumb', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const testid = await page.locator(firstCell).first().getAttribute('data-testid');
    const weekId = testid.replace('day-cell-', '').replace('-Monday', '');
    await dispatchDrop(page, firstCell, { name: 'chart.png', type: 'image/png', b64: garbageB64 });
    // The cell image appearing means setStoredImg resolved — the
    // thumb attempt (awaited in the fallback path) is finished.
    await expect(page.locator(firstCell).first().locator('img')).toHaveCount(1, { timeout: 10000 });

    const thumbState = await page.evaluate(async (wid) => {
      const s = await import('/src/data/storage.js');
      return { known: s.hasStoredThumb(wid, 'Monday'), blob: s.hasThumbBlob(wid, 'Monday') };
    }, weekId);
    // No thumb persisted, and none marked known — the next startup
    // backfill will retry the derivation.
    expect(thumbState.known).toBe(false);
    expect(thumbState.blob).toBe(false);
    // The original itself is stored losslessly, as always.
    const stored = await page.evaluate(async (wid) => {
      const s = await import('/src/data/storage.js');
      const url = await s.getStoredImgAsync(wid, 'Monday');
      return !!url;
    }, weekId);
    expect(stored).toBe(true);
  });

  test('startup backfill does not persist the original as a thumb', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const testid = await page.locator(firstCell).first().getAttribute('data-testid');
    const weekId = testid.replace('day-cell-', '').replace('-Monday', '');
    // Seed a corrupt image straight into IndexedDB, bypassing the
    // upload path, so only the startup backfill can derive a thumb.
    await page.evaluate(async ({ wid, b64 }) => {
      const { set } = await import('/node_modules/.vite/deps/idb-keyval.js');
      const s = await import('/src/data/storage.js');
      const ds = s.getCurrentDataset().id;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      await set(`sb_ds_${ds}__img_${wid}_Monday`, blob);
    }, { wid: weekId, b64: garbageB64 });

    await page.reload();
    // The cell showing the image proves the backfill processed the
    // key (it sets the full-image fallback in memCache first).
    await expect(page.locator(firstCell).first().locator('img')).toHaveCount(1, { timeout: 10000 });
    await page.waitForTimeout(2000); // derivation fails fast; let it finish
    const thumbState = await page.evaluate(async (wid) => {
      const { get } = await import('/node_modules/.vite/deps/idb-keyval.js');
      const s = await import('/src/data/storage.js');
      const ds = s.getCurrentDataset().id;
      const persisted = await get(`sb_ds_${ds}__thumb_${wid}_Monday`);
      return { known: s.hasStoredThumb(wid, 'Monday'), blob: s.hasThumbBlob(wid, 'Monday'), persisted: !!persisted };
    }, weekId);
    expect(thumbState.known).toBe(false);
    expect(thumbState.blob).toBe(false);
    expect(thumbState.persisted).toBe(false);
  });
});
