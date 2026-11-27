import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Tests for the trend line tool (TradingView-style diagonal line):
// two clicks draw it (first pins the start, second pins the end, with a
// dashed preview following the cursor in between); clicking the line
// selects it (amber, with a dot at each end); dragging a dot stretches
// that end to where it is dropped; double-click and drag moves the whole
// line; right-click shows the delete (×). The line is TradingView blue
// (#2962ff), so it stands apart from the black horizontal line, and it
// shows read-only on the notes-page chart and is baked into the
// fullscreen chart download (see chart-download.spec.js).
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
  await expect(page.getByTestId('ann-toolbar')).toBeVisible();
}

// Draw a trend line from (x1%, y1%) to (x2%, y2%) of the overlay.
async function drawTrendline(page, overlay, x1, y1, x2, y2) {
  const box = await overlay.boundingBox();
  const at = (xp, yp) => [box.x + (box.width * xp) / 100, box.y + (box.height * yp) / 100];
  await page.getByTestId('ann-tool-trendline').click();
  await page.mouse.click(...at(x1, y1));
  await page.mouse.move(...at(x2, y2));
  await page.mouse.click(...at(x2, y2));
  await expect(page.locator('[data-testid="ann-mark"][data-ann-type="trendline"]')).toHaveCount(1);
}

// The stored endpoints, read off the rendered SVG line (its x1/y1/x2/y2
// attributes are the stored % coords).
async function lineEnds(page) {
  const line = page.locator('[data-testid="ann-mark"][data-ann-type="trendline"] svg line').first();
  const read = (name) => line.evaluate((el, n) => parseFloat(el.getAttribute(n)), name);
  return { x1: await read('x1'), y1: await read('y1'), x2: await read('x2'), y2: await read('y2') };
}

test.describe('Trend line tool', () => {
  test('toolbar has the trend line button; arming inverts it, clicking again disarms', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const btn = page.getByTestId('ann-tool-trendline');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  test('two clicks draw the line; the tool disarms after the second click', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await drawTrendline(page, overlay, 25, 65, 75, 35);
    const ends = await lineEnds(page);
    expect(ends.x1).toBeCloseTo(25, 0);
    expect(ends.y1).toBeCloseTo(65, 0);
    expect(ends.x2).toBeCloseTo(75, 0);
    expect(ends.y2).toBeCloseTo(35, 0);
    await expect(page.getByTestId('ann-tool-trendline')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a dashed preview follows the cursor after the first click', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    const at = (xp, yp) => [box.x + (box.width * xp) / 100, box.y + (box.height * yp) / 100];
    await page.getByTestId('ann-tool-trendline').click();
    await page.mouse.click(...at(25, 65));
    await expect(page.getByTestId('ann-trendline-draft')).toBeVisible();
    await page.mouse.move(...at(60, 40));
    const draft = page.locator('[data-testid="ann-trendline-draft"] line');
    // ±2%: the overlay can shift a few px under full-suite load as the
    // image tiers settle, but the preview must still track the cursor.
    const dx2 = parseFloat(await draft.getAttribute('x2'));
    const dy2 = parseFloat(await draft.getAttribute('y2'));
    expect(dx2).toBeGreaterThan(58);
    expect(dx2).toBeLessThan(62);
    expect(dy2).toBeGreaterThan(38);
    expect(dy2).toBeLessThan(42);
    // Finishing the line clears the preview.
    await page.mouse.click(...at(60, 40));
    await expect(page.getByTestId('ann-trendline-draft')).toHaveCount(0);
  });

  test('a second click too close to the first is ignored, not a line', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    const at = (xp, yp) => [box.x + (box.width * xp) / 100, box.y + (box.height * yp) / 100];
    await page.getByTestId('ann-tool-trendline').click();
    await page.mouse.click(...at(50, 50));
    await page.mouse.click(...at(50.5, 50.5));
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="trendline"]')).toHaveCount(0);
    await expect(page.getByTestId('ann-trendline-draft')).toBeVisible();
    // The draft is still armed: a click elsewhere finishes the line.
    await page.mouse.click(...at(80, 20));
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="trendline"]')).toHaveCount(1);
    const ends = await lineEnds(page);
    expect(ends.x1).toBeCloseTo(50, 0);
    expect(ends.x2).toBeCloseTo(80, 0);
  });

  test('Escape cancels a half-drawn line', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-trendline').click();
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.65);
    await expect(page.getByTestId('ann-trendline-draft')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ann-trendline-draft')).toHaveCount(0);
    await expect(page.getByTestId('ann-tool-trendline')).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking the line selects it: amber, with a dot at each end', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await drawTrendline(page, overlay, 25, 65, 75, 35);
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.getByTestId('ann-trendline-dot-start')).toBeVisible();
    await expect(page.getByTestId('ann-trendline-dot-end')).toBeVisible();
    const stroke = await page.locator('[data-testid="ann-mark"][data-ann-type="trendline"] svg line').first().getAttribute('stroke');
    expect(stroke).toBe('#fbbf24');
  });

  test('dragging an endpoint dot stretches that end to where it is dropped', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await drawTrendline(page, overlay, 25, 65, 75, 35);
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.getByTestId('ann-trendline-dot-end')).toBeVisible();
    const dot = await page.getByTestId('ann-trendline-dot-end').boundingBox();
    const cx = dot.x + dot.width / 2;
    const cy = dot.y + dot.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.88, box.y + box.height * 0.18, { steps: 12 });
    await page.mouse.up();
    const ends = await lineEnds(page);
    expect(ends.x2).toBeCloseTo(88, 0);
    expect(ends.y2).toBeCloseTo(18, 0);
    // The other end did not move.
    expect(ends.x1).toBeCloseTo(25, 0);
    expect(ends.y1).toBeCloseTo(65, 0);
  });

  test('double-click and drag moves the whole line', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await drawTrendline(page, overlay, 25, 65, 75, 35);
    const box = await overlay.boundingBox();
    const mx = box.x + box.width * 0.5;
    const my = box.y + box.height * 0.5;
    // First click selects the line; the second press of the double-click
    // (detail 2) held and dragged moves the whole line.
    await page.mouse.move(mx, my);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(mx + 120, my + 60, { steps: 10 });
    await page.mouse.up();
    const ends = await lineEnds(page);
    // Both ends shifted by the same delta (120px right, 60px down on a
    // ~1280x720 overlay is about +9% x, +8% y).
    expect(ends.x1).toBeGreaterThan(25 + 5);
    expect(ends.x2).toBeGreaterThan(75 + 5);
    expect(ends.y1).toBeGreaterThan(65 + 5);
    expect(ends.y2).toBeGreaterThan(35 + 5);
    expect(ends.x2 - ends.x1).toBeCloseTo(50, 0);
    expect(ends.y1 - ends.y2).toBeCloseTo(30, 0);
  });

  test('right-click shows the delete button; deleting removes the line', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await drawTrendline(page, overlay, 25, 65, 75, 35);
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, { button: 'right' });
    await expect(page.getByTestId('ann-mark-delete')).toHaveCount(1);
    await page.getByTestId('ann-mark-delete').click();
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="trendline"]')).toHaveCount(0);
  });

  test('the line shows read-only on the notes-page chart', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await drawTrendline(page, overlay, 25, 65, 75, 35);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chart-lightbox')).toHaveCount(0);
    await expect(page.locator('[data-testid="inline-ann-mark"][data-ann-type="trendline"]')).toBeVisible();
  });
});
