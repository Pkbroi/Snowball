import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Tests for the detail-page chart annotation toolkit (v4.5):
// a floating icon-only toolbar on top of the zoomed chart (lightbox) with
// a TradingView-style horizontal line, 2 green vertical arrows (entry),
// 2 red vertical arrows (exit), 1 yellow marker arrow, and a comment box
// whose font is always bold. Marks are stored per week+day, so they
// survive reload and travel with the whole-database backup.
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
  // The overlay is sized once the full image has decoded.
  await expect(page.getByTestId('ann-overlay')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('ann-toolbar')).toBeVisible();
}

test.describe('Chart annotations (v4.5)', () => {
  test('toolbar is icons only, with the line, 4 entry/exit arrows and yellow marker', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const toolbar = page.getByTestId('ann-toolbar');
    // No word labels anywhere on the bar — the symbols are enough.
    await expect(toolbar).not.toContainText('ENTRY');
    await expect(toolbar).not.toContainText('EXIT');
    await expect(toolbar).not.toContainText('GREEN');
    await expect(toolbar).not.toContainText('RED');
    for (const tool of ['select', 'line', 'arrow-green-up', 'arrow-green-down', 'arrow-red-up', 'arrow-red-down', 'arrow-yellow', 'comment']) {
      await expect(page.getByTestId(`ann-tool-${tool}`)).toBeVisible();
    }
    // Arming a tool inverts it; clicking it again disarms back to select.
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await expect(page.getByTestId('ann-tool-arrow-green-up')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await expect(page.getByTestId('ann-tool-arrow-green-up')).toHaveAttribute('aria-pressed', 'false');
  });

  test('placing every arrow type and the horizontal line', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const marks = page.locator('[data-testid="ann-mark"]');
    await expect(marks).toHaveCount(0);

    const placements = [
      ['arrow-green-up', 30, 30],
      ['arrow-green-down', 40, 45],
      ['arrow-red-up', 55, 35],
      ['arrow-red-down', 65, 55],
      ['arrow-yellow', 75, 25],
    ];
    for (const [tool, px, py] of placements) {
      await page.getByTestId(`ann-tool-${tool}`).click();
      const box = await overlay.boundingBox();
      await page.mouse.click(box.x + (box.width * px) / 100, box.y + (box.height * py) / 100);
      await expect(page.locator(`[data-testid="ann-mark"][data-ann-type="${tool}"]`)).toHaveCount(1);
    }
    await expect(marks).toHaveCount(5);

    // The line spans the full width at the clicked height.
    await page.getByTestId('ann-tool-line').click();
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);
    const line = page.locator('[data-testid="ann-mark"][data-ann-type="line"]');
    await expect(line).toHaveCount(1);
    const topPct = await line.evaluate((el) => parseFloat(el.style.top));
    expect(topPct).toBeCloseTo(70, 0);
    await expect(marks).toHaveCount(6);
  });

  test('comment box opens with the cursor inside, bold font, and saves text', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-comment').click();
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeFocused();
    const weight = await textarea.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(weight).toBe('700');
    await textarea.fill('breakout above 25,100');
    await expect(textarea).toHaveValue('breakout above 25,100');
  });

  test('marks persist when leaving the cell and coming back', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-arrow-green-up').click();
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]')).toHaveCount(1);
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.getByTestId('ann-comment-text').fill('held the level');
    await page.keyboard.press('Escape'); // leave the comment box
    await page.waitForTimeout(500); // past the placement-click guard
    // Click empty chart to close the lightbox, go back, and reopen the same cell.
    await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.9);
    await expect(page.getByTestId('chart-lightbox')).toHaveCount(0);
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/\/(\?|$)/);
    await page.locator('[data-testid^="day-cell-"]').first().dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('chart-image-container').dblclick();
    await expect(page.getByTestId('ann-overlay')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]')).toHaveCount(1);
    await expect(page.getByTestId('ann-comment-text')).toHaveValue('held the level');
  });

  test('selecting a mark and pressing Delete removes it', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-arrow-red-down').click();
    const box = await overlay.boundingBox();
    // Click clear of the top-centre toolbar band.
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
    const mark = page.locator('[data-testid="ann-mark"][data-ann-type="arrow-red-down"]');
    await expect(mark).toHaveCount(1);
    // Back to select: click the armed tool again, then click the mark.
    await page.getByTestId('ann-tool-arrow-red-down').click();
    await mark.click();
    await page.keyboard.press('Delete');
    await expect(mark).toHaveCount(0);
  });

  test('dragging a mark moves it', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-arrow-green-up').click();
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    const mark = page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]');
    await expect(mark).toHaveCount(1);
    const before = await mark.evaluate((el) => parseFloat(el.style.left));
    expect(before).toBeCloseTo(30, 0);

    // Back to select, then drag the mark right by 120px.
    await page.getByTestId('ann-tool-arrow-green-up').click();
    const mbox = await mark.boundingBox();
    await page.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(mbox.x + mbox.width / 2 + 120, mbox.y + mbox.height / 2, { steps: 10 });
    await page.mouse.up();
    const after = await mark.evaluate((el) => parseFloat(el.style.left));
    expect(after).toBeGreaterThan(before + 5);
  });

  test('marks stay glued to the chart when zooming in', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-arrow-yellow').click();
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
    const mark = page.locator('[data-testid="ann-mark"][data-ann-type="arrow-yellow"]');
    await expect(mark).toHaveCount(1);
    const relPos = async () => {
      const o = await overlay.boundingBox();
      const m = await mark.boundingBox();
      return { x: (m.x + m.width / 2 - o.x) / o.width, y: (m.y + m.height / 2 - o.y) / o.height };
    };
    const before = await relPos();
    expect(before.x).toBeCloseTo(0.6, 1);
    await page.getByTestId('ann-tool-arrow-yellow').click(); // disarm so the zoom click doesn't place
    await page.getByTestId('lightbox-zoom-in').click();
    await page.waitForTimeout(300);
    const after = await relPos();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });
});
