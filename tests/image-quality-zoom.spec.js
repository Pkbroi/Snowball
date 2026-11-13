import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Regression tests for the image-quality + zoom bug report (see BUG-REPORT.md):
//  - uploads must NOT be downscaled to 1920px / compressed to 1MB
//    (browser-image-compression in 8794d9b did exactly that)
//  - the lightbox must show the FULL-RES image and FILL the screen
//    (it was fed the 480px grid thumbnail, so it stayed 480px wide)
//  - the journal grid must still use the small thumbnail (fast scrolling)
//
// The 2560x1440 test chart is generated at runtime (pure-Node PNG encoder
// below) instead of being committed as a binary fixture, so the whole
// change stays text-only.

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode a 2560x1440 chart-like image (dark background, fine grid lines) as PNG. */
function makeChartPng(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      const grid = x % 40 === 0 || y % 40 === 0;
      raw[i] = grid ? 74 : 10; // R
      raw[i + 1] = grid ? 143 : 10; // G
      raw[i + 2] = grid ? 255 : 10; // B
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe('Image quality & lightbox zoom', () => {
  test('uploaded chart keeps full resolution and the lightbox fills the screen', async ({ page }, testInfo) => {
    const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(fixture, makeChartPng(2560, 1440));

    await page.goto('/');
    await page.getByTestId('add-week-btn').click();

    // Open the first (empty) day cell -> trade detail
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toBeVisible();
    await firstDayCell.dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);

    // Upload a 2560x1440 chart via the hidden file input
    await page.locator('input[type="file"]').first().setInputFiles(fixture);
    const container = page.getByTestId('chart-image-container');
    await expect(container).toBeVisible({ timeout: 15000 });

    // Full resolution, not downscaled to 1920 and not the 480px thumbnail
    const inlineImg = container.locator('img');
    await expect
      .poll(async () => inlineImg.evaluate((img) => img.naturalWidth), { timeout: 15000 })
      .toBe(2560);

    // Double-click to expand (the "zoom in" the bug report refers to)
    await container.dblclick();
    const lightbox = page.getByTestId('chart-lightbox');
    await expect(lightbox).toBeVisible();
    const lightboxImg = page.getByTestId('chart-lightbox-image');
    await expect(lightboxImg).toBeVisible();

    // Lightbox shows the same full-res image…
    await expect
      .poll(async () => lightboxImg.evaluate((img) => img.naturalWidth), { timeout: 15000 })
      .toBe(2560);

    // …and fills the viewport (object-contain, w-full h-full), not a
    // small image centred at its natural size.
    const viewport = page.viewportSize();
    const box = await lightboxImg.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.max(box.width / viewport.width, box.height / viewport.height)).toBeGreaterThan(0.9);

    // Escape closes the lightbox
    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();

    // Back on the journal, the grid cell uses the small thumbnail —
    // fast to scroll, and proof the two tiers are not mixed up.
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/.*\/$/);
    const cellImg = page.locator('[data-testid^="day-cell-"] img').first();
    await expect(cellImg).toBeVisible();
    await expect
      .poll(async () => cellImg.evaluate((img) => img.naturalWidth), { timeout: 15000 })
      .toBeLessThanOrEqual(480);
  });
});
