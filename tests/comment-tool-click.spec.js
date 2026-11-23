import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Bug 8: the comment box's onPointerDown called stopPropagation()
// unconditionally, so a tool click or drag starting on a comment box
// never reached the annotation overlay — the line/arrow/pencil did
// nothing there. Only select mode needs to swallow the event (so the
// box can be dragged and the text edited without panning the chart);
// with a draw tool active the event must bubble to the overlay.
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

async function placeComment(page, px, py, text) {
  const overlay = page.getByTestId('ann-overlay');
  await page.getByTestId('ann-tool-comment').click();
  const box = await overlay.boundingBox();
  await page.mouse.click(box.x + (box.width * px) / 100, box.y + (box.height * py) / 100);
  const textarea = page.getByTestId('ann-comment-text');
  await expect(textarea).toBeVisible();
  await textarea.fill(text);
  await page.keyboard.press('Escape'); // leave the comment box
  await page.waitForTimeout(500); // past the placement-click guard
  return textarea;
}

test.describe('Comment box vs tools (bug 8)', () => {
  test('a line click starting on a comment box places the line', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const textarea = await placeComment(page, 30, 30, 'held the level');
    const tbox = await textarea.boundingBox();
    const cx = tbox.x + tbox.width / 2;
    const cy = tbox.y + tbox.height / 2;
    await page.getByTestId('ann-tool-line').click();
    await page.mouse.click(cx, cy);
    const line = page.locator('[data-testid="ann-mark"][data-ann-type="line"]');
    await expect(line).toHaveCount(1);
    // The line lands where the click was — the centre of the comment
    // box, which sits a little below the box's top edge (30%).
    const obox = await overlay.boundingBox();
    const expectedTop = ((cy - obox.y) / obox.height) * 100;
    const topPct = await line.evaluate((el) => parseFloat(el.style.top));
    expect(topPct).toBeCloseTo(expectedTop, 0);
  });

  test('a pencil drag starting on a comment box draws a stroke', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const textarea = await placeComment(page, 30, 30, 'held the level');
    const tbox = await textarea.boundingBox();
    const obox = await overlay.boundingBox();
    await page.getByTestId('ann-tool-pencil').click();
    await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(obox.x + obox.width * 0.6, obox.y + obox.height * 0.5, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="pencil"]')).toHaveCount(1);
  });

  test('in select mode a click on a comment box places nothing', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const textarea = await placeComment(page, 30, 30, 'held the level');
    const tbox = await textarea.boundingBox();
    // Select is the default tool after the comment is placed.
    await expect(page.getByTestId('ann-tool-select')).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(1); // the comment only
    await expect(page.getByTestId('ann-comment-text')).toBeFocused();
  });
});
