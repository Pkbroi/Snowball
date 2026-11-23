import { test, expect } from '@playwright/test';

// Bug 7: async image continuations in TradeDetail were guarded only
// by the load effect's `cancelled` flag, which a delete never trips
// (the effect does not re-run for one) — so a chart deleted while
// its full image was still loading reappeared ~100–500ms later. The
// image generation epoch now drops every stale continuation.

const firstCell = '[data-testid^="day-cell-"]';

// A noise PNG: every pixel random, so the file is large and, more
// importantly, SLOW to decode (the decoder cannot skip flat runs).
// A gradient chart PNG compresses to a few hundred KB and decodes in
// ~50ms no matter its dimensions — the full image always won the
// race against the delete click. Noise makes the full decode take
// ~1s while the 1600px medium still lands in ~100ms.
async function dispatchNoiseDrop(page, selector, w, h) {
  await page.evaluate(async ({ selector, w, h }) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (Math.random() * 255) | 0;
      d[i + 1] = (Math.random() * 255) | 0;
      d[i + 2] = (Math.random() * 255) | 0;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const f = new File([blob], 'chart.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(f);
    const el = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, { selector, w, h });
}

test.describe('Stale image continuations (bug 7)', () => {
  test('a chart deleted while its full image is still loading stays deleted', { timeout: 180000 }, async ({ page, context }) => {
    // A 4K noise original: its full-image decode takes ~1s while the
    // 1600px medium lands in ~100ms, so the full load is still in
    // flight when the container appears on the medium.
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const testid = await page.locator(firstCell).first().getAttribute('data-testid');
    const weekId = testid.replace('day-cell-', '').replace('-Monday', '');
    await dispatchNoiseDrop(page, firstCell, 3840, 2160);
    await expect(page.locator(firstCell).first().locator('img')).toHaveCount(1, { timeout: 120000 });

    // Fresh tab, deep link: the tiers load from scratch at mount.
    const detail = await context.newPage();
    await detail.goto(`/#/trade/${weekId}`);
    // Tight in-page wait: the container appears the moment the
    // medium lands, and the delete must land before the full image
    // finishes decoding.
    await detail.waitForFunction(() => document.querySelector('[data-testid="chart-image-container"]'), null, { timeout: 60000 });
    await detail.locator('button[title="Remove image"]').click();
    await expect(detail.getByTestId('chart-image-container')).toHaveCount(0, { timeout: 5000 });
    // Past the window in which the stale continuation would land.
    await detail.waitForTimeout(3000);
    await expect(detail.getByTestId('chart-image-container')).toHaveCount(0);
    await expect(detail.getByTestId('chart-dropzone')).toBeVisible();
    // And the delete persisted — a reload must not resurrect it either.
    await detail.reload();
    await expect(detail.getByTestId('chart-dropzone')).toBeVisible({ timeout: 15000 });
    await expect(detail.getByTestId('chart-image-container')).toHaveCount(0);
  });
});
