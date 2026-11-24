import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Tests for the chart download button (lightbox, next to the close button):
// the chart downloads as a lossless PNG at its FULL original size, with
// the annotation marks baked in — never a screenshot of the lightbox.
// The save location is asked every time (native Save As dialog); the
// anchor-download fallback is covered too. The fixture is a 2560x1440
// dark chart (background rgb(10,10,10), blue grid lines every 40px), so
// a black line, a green arrow, white comment text and a pencil stroke
// are all distinguishable from the background by pixel colour.

async function openLightboxWithChart(page, testInfo) {
  const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(fixture, makeChartPng(2560, 1440));
  await page.goto('/');
  await page.getByTestId('add-week-btn').click();
  const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
  await expect(firstDayCell).toBeVisible();
  await firstDayCell.dblclick();
  await expect(page).toHaveURL(/\/trade\/.*/);
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('chart-image-container').dblclick();
  await expect(page.getByTestId('chart-lightbox')).toBeVisible();
  await expect(page.getByTestId('ann-overlay')).toBeVisible({ timeout: 15000 });
}

// One of every mark type: a horizontal line, a green up arrow, a comment
// with text, and a pencil stroke.
async function placeAllMarks(page) {
  const overlay = page.getByTestId('ann-overlay');
  const box = await overlay.boundingBox();
  const at = (px, py) => [box.x + (box.width * px) / 100, box.y + (box.height * py) / 100];

  await page.getByTestId('ann-tool-line').click();
  await page.mouse.click(...at(50, 70));
  await expect(page.locator('[data-testid="ann-mark"][data-ann-type="line"]')).toHaveCount(1);

  await page.getByTestId('ann-tool-arrow-green-up').click();
  await page.mouse.click(...at(30, 30));
  await expect(page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]')).toHaveCount(1);

  await page.getByTestId('ann-tool-comment').click();
  await page.mouse.click(...at(60, 60));
  await page.getByTestId('ann-comment-text').fill('held the level');
  await page.keyboard.press('Escape');

  await page.getByTestId('ann-tool-pencil').click();
  const [sx, sy] = at(20, 80);
  const [ex, ey] = at(40, 70);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(ex, ey, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('[data-testid="ann-mark"][data-ann-type="pencil"]')).toHaveCount(1);
}

function pngDimensions(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Draws the downloaded PNG into an in-page canvas and samples pixels.
// The fixture background is rgb(10,10,10); grid lines are rgb(74,143,255).
async function samplePng(page, filePath) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = (x0, y0, w, h) => ctx.getImageData(x0, y0, w, h).data;
    const countWhere = (x0, y0, x1, y1, pred) => {
      const d = data(x0, y0, x1 - x0, y1 - y0);
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2])) n++;
      return n;
    };
    // Darkest pixel in the line's column near y=70% (the line is 4px
    // thick at native size; the click lands within a px or two of 70%).
    let darkest = 255 * 3;
    const col = data(1280, 1000, 1, 16);
    for (let i = 0; i < col.length; i += 4) darkest = Math.min(darkest, col[i] + col[i + 1] + col[i + 2]);
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      lineDarkest: darkest,
      // Green arrow body: g high, r/b low. Grid blue (74,143,255) fails g>150.
      arrowGreen: countWhere(740, 430, 800, 505, (r, g, b) => g > 150 && r < 100 && b < 150),
      // White comment text: all channels >200. Grid blue fails r>200.
      commentWhite: countWhere(1552, 880, 1850, 920, (r, g, b) => r > 200 && g > 200 && b > 200),
      // Pencil white edge around the stroke midpoint (768, 1080).
      pencilWhite: countWhere(700, 1040, 840, 1120, (r, g, b) => r > 200 && g > 200 && b > 200),
    };
  }, b64);
}

test.describe('Chart download (full-quality PNG with markers)', () => {
  // NOTE on the Save As dialog: in a real browser and in the Electron
  // app the native dialog appears. Headless Chromium cannot show it —
  // it aborts showSaveFilePicker immediately (AbortError, "The user
  // aborted a request"), so no filechooser event ever fires and the
  // dialog cannot be driven here. The first test therefore stubs only
  // the picker itself (the OS UI, not app code) with a fake handle that
  // captures the blob the app hands it; the PNG the app produces is
  // then verified byte-for-byte from disk, exactly as a real save would
  // write it. The cancel and fallback tests cover the other two paths.
  test('Save As dialog writes a full-size PNG with every mark baked in', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.__pickerOpts = null;
      window.__savedBlob = null;
      window.showSaveFilePicker = async (opts) => {
        window.__pickerOpts = opts;
        return {
          createWritable: async () => ({
            write: async (blob) => { window.__savedBlob = blob; },
            close: async () => {},
          }),
        };
      };
    });
    await openLightboxWithChart(page, testInfo);
    await placeAllMarks(page);
    await page.getByTestId('chart-download-btn').click();
    await expect.poll(() => page.evaluate(() => !!window.__savedBlob), { timeout: 10000 }).toBe(true);
    const opts = await page.evaluate(() => window.__pickerOpts);
    expect(opts.suggestedName).toMatch(/^Snowball .*\.png$/);
    expect(opts.types[0].accept['image/png']).toContain('.png');

    // The blob the app handed to the picker, written out as a real file.
    const outPath = path.join(testInfo.outputDir, 'downloaded-chart.png');
    const b64 = await page.evaluate(async () => {
      const buf = await window.__savedBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(s);
    });
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));

    const buf = fs.readFileSync(outPath);
    expect(pngDimensions(buf)).toEqual({ width: 2560, height: 1440 });
    const s = await samplePng(page, outPath);
    expect(s.width).toBe(2560);
    expect(s.height).toBe(1440);
    expect(s.lineDarkest).toBeLessThanOrEqual(6); // the black line
    expect(s.arrowGreen).toBeGreaterThan(50);
    expect(s.commentWhite).toBeGreaterThan(20);
    expect(s.pencilWhite).toBeGreaterThan(100);
  });

  test('cancelling the Save As dialog leaves the lightbox exactly as it was', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.showSaveFilePicker = async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      };
    });
    await openLightboxWithChart(page, testInfo);
    await placeAllMarks(page);
    await page.getByTestId('chart-download-btn').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chart-lightbox')).toBeVisible();
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(4);
  });

  test('without the dialog API it falls back to a Downloads-folder download', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.showSaveFilePicker = undefined;
    });
    await openLightboxWithChart(page, testInfo);
    await placeAllMarks(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('chart-download-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^Snowball .*\.png$/);
    const outPath = path.join(testInfo.outputDir, 'fallback-chart.png');
    await download.saveAs(outPath);
    expect(pngDimensions(fs.readFileSync(outPath))).toEqual({ width: 2560, height: 1440 });
    const s = await samplePng(page, outPath);
    expect(s.lineDarkest).toBeLessThanOrEqual(6);
    expect(s.arrowGreen).toBeGreaterThan(50);
  });

});
