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
// (v4.5.15) A black bold pencil: click-drag draws a freehand stroke; the
// pencil stays armed stroke after stroke until it is tapped again.
// Right-clicking a stroke selects it and shows a delete (×) button at its
// top end; strokes also show read-only on the inline chart.
// (v4.5.16) Comment boxes: double-click places the cursor (word
// selected); double-click and drag moves the whole box.
// (v4.5.17) Right-clicking a comment turns the box's own border dotted
// and shows 8 handles on its perimeter for free-form resizing, with the
// delete (×) button on the top dotted line — no second box around it.
// A single click puts the cursor inside the box. The size is stored
// per box.
// Trend line (TradingView-style): two clicks draw a diagonal line; a
// dashed preview follows the cursor after the first click; clicking the
// line selects it (amber, dots at both ends); dragging a dot stretches
// that end; double-click and drag moves the whole line. See
// tests/trendline.spec.js for its own specs.
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

// Draw one pencil stroke across the overlay, from (x1%, y1%) to (x2%, y2%).
async function drawPencilStroke(page, overlay, x1, y1, x2, y2) {
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + (box.width * x1) / 100, box.y + (box.height * y1) / 100);
  await page.mouse.down();
  await page.mouse.move(box.x + (box.width * x2) / 100, box.y + (box.height * y2) / 100, { steps: 12 });
  await page.mouse.up();
}

test.describe('Chart annotations (v4.5)', () => {
  test('toolbar is icons only, with the line, trend line, pencil, 4 entry/exit arrows and yellow marker', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const toolbar = page.getByTestId('ann-toolbar');
    // No word labels anywhere on the bar — the symbols are enough.
    await expect(toolbar).not.toContainText('ENTRY');
    await expect(toolbar).not.toContainText('EXIT');
    await expect(toolbar).not.toContainText('GREEN');
    await expect(toolbar).not.toContainText('RED');
    for (const tool of ['select', 'line', 'trendline', 'pencil', 'arrow-green-up', 'arrow-green-down', 'arrow-red-up', 'arrow-red-down', 'arrow-yellow', 'comment']) {
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
    // Close the lightbox with Escape (blur, deselect, close) — an empty
    // chart click no longer closes once a mark is on the chart.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chart-lightbox')).toHaveCount(0);
    // Go back, and reopen the same cell.
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
    // One-shot: placing already disarmed the tool, so click the mark directly.
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

    // One-shot: placing already disarmed the tool, so drag the mark directly.
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
    // One-shot: placing already disarmed the tool, so zooming can't place.
    await page.getByTestId('lightbox-zoom-in').click();
    await page.waitForTimeout(300);
    const after = await relPos();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  test('tools are one-shot: a second click without re-arming places nothing', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    // Arrow: place once, click again elsewhere right away — no second arrow,
    // and the tool is back to select.
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.4);
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]')).toHaveCount(1);
    await expect(page.getByTestId('ann-tool-arrow-green-up')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(1);
    // Line: same — one line, second click places nothing.
    await page.getByTestId('ann-tool-line').click();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8);
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="line"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(2);
    // Re-arming works: pick the tool again and it places once more.
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.4);
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]')).toHaveCount(2);
  });

  test('comment box grows taller as the comment fills it', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-comment').click();
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    const startHeight = await textarea.evaluate((el) => el.offsetHeight);
    const longText = ['first line', 'second line', 'third line', 'fourth line', 'fifth line', 'sixth line'].join('\n');
    await textarea.fill(longText);
    await expect(textarea).toHaveValue(longText);
    const grown = await textarea.evaluate((el) => ({ h: el.offsetHeight, scroll: el.scrollHeight }));
    expect(grown.h).toBeGreaterThan(startHeight + 40);
    // The whole comment is visible — no internal scrolling needed.
    expect(grown.scroll).toBeLessThanOrEqual(grown.h + 1);
  });

  test('empty chart click does nothing once a mark is on the chart', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    // No marks yet: an empty click still closes the lightbox.
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await expect(overlay).toBeHidden();
    // Reopen and place a mark.
    await page.getByTestId('chart-image-container').dblclick();
    await expect(page.getByTestId('ann-overlay')).toBeVisible({ timeout: 15000 });
    const box2 = await overlay.boundingBox();
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await page.mouse.click(box2.x + box2.width * 0.3, box2.y + box2.height * 0.4);
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(1);
    // Wait past the 300ms placement guard, then click empty chart — nothing happens.
    await page.waitForTimeout(500);
    await page.mouse.click(box2.x + box2.width * 0.8, box2.y + box2.height * 0.8);
    await expect(page.getByTestId('ann-overlay')).toBeVisible();
    // Escape still closes.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ann-overlay')).toBeHidden();
  });

  test('right-click a mark selects it and shows a delete button', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    // Arrow: left-clicking it selects it but shows no delete button;
    // right-clicking it does. (Right-click at the mark's centre, not the
    // placement point — an up arrow's tip sits exactly on that point.)
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    const arrow = page.locator('[data-testid="ann-mark"][data-ann-type="arrow-green-up"]');
    await expect(arrow).toHaveCount(1);
    const arrowBox = await arrow.boundingBox();
    await page.mouse.click(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2);
    await expect(page.getByTestId('ann-mark-delete')).toHaveCount(0);
    await page.mouse.click(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-mark-delete')).toHaveCount(1);
    await page.getByTestId('ann-mark-delete').click();
    await expect(arrow).toHaveCount(0);
    // Line: right-click near its right end, then delete.
    await page.getByTestId('ann-tool-line').click();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    const line = page.locator('[data-testid="ann-mark"][data-ann-type="line"]');
    await expect(line).toHaveCount(1);
    const lineBox = await line.boundingBox();
    await page.mouse.click(lineBox.x + lineBox.width * 0.95, lineBox.y + lineBox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-mark-delete')).toHaveCount(1);
    await page.getByTestId('ann-mark-delete').click();
    await expect(line).toHaveCount(0);
    // Comment: right-click the box, then delete.
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    await expect(comment).toHaveCount(1);
    const commentBox = await comment.boundingBox();
    await page.mouse.click(commentBox.x + commentBox.width / 2, commentBox.y + commentBox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-mark-delete')).toHaveCount(1);
    await page.getByTestId('ann-mark-delete').click();
    await expect(comment).toHaveCount(0);
  });

  test('marks and comments show on the inline chart on the detail page', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-arrow-green-up').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.getByTestId('ann-tool-line').click();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
    await page.getByTestId('ann-comment-text').fill('held the level');
    await expect(page.locator('[data-testid="ann-mark"]')).toHaveCount(3);
    // Close the lightbox (Escape: blur, deselect, close).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chart-lightbox')).toHaveCount(0);
    // The same marks are visible on the inline chart, in the right places.
    const inline = page.getByTestId('inline-ann-overlay');
    await expect(inline).toBeVisible();
    await expect(page.locator('[data-testid="inline-ann-mark"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="inline-ann-mark"][data-ann-type="comment"]')).toHaveText('held the level');
    const chart = await page.getByTestId('chart-image-container').boundingBox();
    const arrowBox = await page.locator('[data-testid="inline-ann-mark"][data-ann-type="arrow-green-up"]').boundingBox();
    expect((arrowBox.x + arrowBox.width / 2 - chart.x) / chart.width).toBeCloseTo(0.3, 1);
    expect((arrowBox.y - chart.y) / chart.height).toBeCloseTo(0.4, 1);
    const lineBox = await page.locator('[data-testid="inline-ann-mark"][data-ann-type="line"]').boundingBox();
    expect((lineBox.y + lineBox.height / 2 - chart.y) / chart.height).toBeCloseTo(0.6, 1);
  });

  test('pencil draws a freehand stroke with click-drag and stays armed until tapped again', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const strokes = page.locator('[data-testid="ann-mark"][data-ann-type="pencil"]');
    await expect(strokes).toHaveCount(0);

    await page.getByTestId('ann-tool-pencil').click();
    await expect(page.getByTestId('ann-tool-pencil')).toHaveAttribute('aria-pressed', 'true');
    await drawPencilStroke(page, overlay, 30, 40, 50, 60);
    await expect(strokes).toHaveCount(1);
    // The stroke is a black bold line: black core, several points.
    const core = strokes.first().locator('polyline').nth(1);
    await expect(core).toHaveAttribute('stroke', '#000000');
    const pts = await strokes.first().locator('polyline').last().getAttribute('points');
    expect(pts.trim().split(/\s+/).length).toBeGreaterThan(2);
    // Latched, not one-shot: still armed, and a second stroke draws one more.
    await expect(page.getByTestId('ann-tool-pencil')).toHaveAttribute('aria-pressed', 'true');
    await drawPencilStroke(page, overlay, 60, 30, 75, 45);
    await expect(strokes).toHaveCount(2);
    // Tap the pencil again to put it away; dragging now draws nothing.
    await page.getByTestId('ann-tool-pencil').click();
    await expect(page.getByTestId('ann-tool-pencil')).toHaveAttribute('aria-pressed', 'false');
    await drawPencilStroke(page, overlay, 20, 70, 35, 80);
    await expect(strokes).toHaveCount(2);
  });

  test('right-click a pencil stroke shows a delete button at its top end', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-pencil').click();
    await drawPencilStroke(page, overlay, 30, 40, 50, 60);
    const stroke = page.locator('[data-testid="ann-mark"][data-ann-type="pencil"]');
    await expect(stroke).toHaveCount(1);
    // Right-click on the stroke itself (its midpoint) — not empty chart.
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5, { button: 'right' });
    const del = page.getByTestId('ann-mark-delete');
    await expect(del).toHaveCount(1);
    // The × sits at the stroke's top end — the drag started at (30%, 40%).
    const delBox = await del.boundingBox();
    expect((delBox.x + delBox.width / 2 - box.x) / box.width).toBeCloseTo(0.3, 1);
    expect((delBox.y + delBox.height / 2 - box.y) / box.height).toBeCloseTo(0.4, 1);
    await del.click();
    await expect(stroke).toHaveCount(0);
  });

  test('dragging a pencil stroke moves it', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-pencil').click();
    await drawPencilStroke(page, overlay, 30, 40, 40, 50);
    const stroke = page.locator('[data-testid="ann-mark"][data-ann-type="pencil"]');
    await expect(stroke).toHaveCount(1);
    const hitLine = stroke.locator('polyline').last();
    const firstPoint = async () => {
      const pts = await hitLine.getAttribute('points');
      const [x, y] = pts.trim().split(/\s+/)[0].split(',').map(Number);
      return { x, y };
    };
    const before = await firstPoint();
    expect(before.x).toBeCloseTo(30, 0);
    // One Escape disarms the pencil, then drag the stroke from its midpoint.
    await page.keyboard.press('Escape');
    const box = await overlay.boundingBox();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35 + 120, box.y + box.height * 0.45, { steps: 10 });
    await page.mouse.up();
    const after = await firstPoint();
    expect(after.x).toBeGreaterThan(before.x + 5);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  test('pencil strokes show on the inline chart on the detail page', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    await page.getByTestId('ann-tool-pencil').click();
    await drawPencilStroke(page, overlay, 30, 40, 50, 60);
    await expect(page.locator('[data-testid="ann-mark"][data-ann-type="pencil"]')).toHaveCount(1);
    // Close the lightbox (Escape: disarm the pencil, then close).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chart-lightbox')).toHaveCount(0);
    const inline = page.locator('[data-testid="inline-ann-mark"][data-ann-type="pencil"]');
    await expect(inline).toHaveCount(1);
    // The stroke keeps its % coords on the inline chart.
    const pts = await inline.locator('polyline').first().getAttribute('points');
    const [x, y] = pts.trim().split(/\s+/)[0].split(',').map(Number);
    expect(x).toBeCloseTo(30, 0);
    expect(y).toBeCloseTo(40, 0);
  });

  test('single click on a comment box puts the cursor inside it', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('breakout above 25,100');
    // Click empty chart to blur, then a single click on the box.
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await expect(textarea).not.toBeFocused();
    const tbox = await textarea.boundingBox();
    await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
    await expect(textarea).toBeFocused();
  });

  test('double-click a comment box places the cursor in its text', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('breakout above 25,100');
    // Click empty chart first so the box is not focused, then double-click
    // on the text: the caret lands inside and a word is selected.
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await expect(textarea).not.toBeFocused();
    const tbox = await textarea.boundingBox();
    await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, { clickCount: 2 });
    await expect(textarea).toBeFocused();
    const sel = await textarea.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd }));
    expect(sel.end).toBeGreaterThan(sel.start);
    // The box did not move.
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    const left = await comment.evaluate((el) => parseFloat(el.style.left));
    expect(left).toBeCloseTo(30, 0);
  });

  test('double-click and drag moves a comment box', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('held the level');
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    const before = await comment.evaluate((el) => parseFloat(el.style.left));
    expect(before).toBeCloseTo(30, 0);
    // Double-click on the text and drag on the second press: the whole
    // box follows the mouse.
    const tbox = await textarea.boundingBox();
    const cx = tbox.x + tbox.width / 2;
    const cy = tbox.y + tbox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    // The second press of a double-click (detail 2) held and dragged.
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(cx + 120, cy + 40, { steps: 10 });
    await page.mouse.up();
    const after = await comment.evaluate((el) => parseFloat(el.style.left));
    expect(after).toBeGreaterThan(before + 5);
    const topAfter = await comment.evaluate((el) => parseFloat(el.style.top));
    expect(topAfter).toBeGreaterThan(30);
  });

  test('right-click a comment box turns its own border dotted; dragging a handle resizes it', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('held the level');
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    // Right-click the box: the delete button and the resize handles
    // appear, and the box's own border turns dotted amber — there is no
    // second box around it.
    const cbox = await comment.boundingBox();
    await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-mark-delete')).toHaveCount(1);
    const resize = page.getByTestId('ann-comment-resize');
    await expect(resize).toBeVisible();
    await expect(page.locator('[data-testid^="ann-resize-"]')).toHaveCount(8);
    const border = await textarea.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.borderTopStyle, color: cs.borderTopColor };
    });
    expect(border.style).toBe('dotted');
    expect(border.color).toBe('rgb(251, 191, 36)');
    const beforeW = await comment.evaluate((el) => parseFloat(el.style.width));
    expect(beforeW).toBeCloseTo(180, 0);
    // Drag the east handle 60px wider.
    const east = await page.getByTestId('ann-resize-e').boundingBox();
    await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2);
    await page.mouse.down();
    await page.mouse.move(east.x + east.width / 2 + 60, east.y + east.height / 2, { steps: 10 });
    await page.mouse.up();
    const afterW = await comment.evaluate((el) => parseFloat(el.style.width));
    expect(afterW).toBeGreaterThan(beforeW + 50);
    // Drag the south handle 40px taller — the text box itself must grow
    // with the dotted border, not stay behind at its old height.
    const beforeH = await comment.evaluate((el) => el.offsetHeight);
    const beforeTaH = await textarea.evaluate((el) => el.offsetHeight);
    const south = await page.getByTestId('ann-resize-s').boundingBox();
    await page.mouse.move(south.x + south.width / 2, south.y + south.height / 2);
    await page.mouse.down();
    await page.mouse.move(south.x + south.width / 2, south.y + south.height / 2 + 40, { steps: 10 });
    await page.mouse.up();
    const afterH = await comment.evaluate((el) => parseFloat(el.style.height));
    expect(afterH).toBeGreaterThan(beforeH + 30);
    const afterTaH = await textarea.evaluate((el) => el.offsetHeight);
    expect(afterTaH).toBeGreaterThan(beforeTaH + 30);
    expect(Math.abs(afterTaH - (await comment.evaluate((el) => el.offsetHeight)))).toBeLessThanOrEqual(2);
    // The size survives leaving and coming back.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chart-lightbox')).toHaveCount(0);
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/\/(\?|$)/);
    await page.locator('[data-testid^="day-cell-"]').first().dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('chart-image-container').dblclick();
    await expect(page.getByTestId('ann-overlay')).toBeVisible({ timeout: 15000 });
    const reopened = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    await expect(reopened).toHaveCount(1);
    const keptW = await reopened.evaluate((el) => parseFloat(el.style.width));
    expect(keptW).toBeCloseTo(afterW, 0);
    const keptH = await reopened.evaluate((el) => parseFloat(el.style.height));
    expect(keptH).toBeCloseTo(afterH, 0);
  });

  test('a sideways resize does not freeze the height — typing still grows the box', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('held the level');
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    const cbox = await comment.boundingBox();
    await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-comment-resize')).toBeVisible();
    // Widen only: a horizontal drag must not store a height.
    const east = await page.getByTestId('ann-resize-e').boundingBox();
    await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2);
    await page.mouse.down();
    await page.mouse.move(east.x + east.width / 2 + 60, east.y + east.height / 2, { steps: 10 });
    await page.mouse.up();
    const widenedW = await comment.evaluate((el) => parseFloat(el.style.width));
    expect(widenedW).toBeGreaterThan(230);
    expect(await comment.evaluate((el) => el.style.height)).toBe('');
    // Typing more lines still grows the box downward to fit the text.
    await textarea.click();
    const startH = await textarea.evaluate((el) => el.offsetHeight);
    const longText = ['first line', 'second line', 'third line', 'fourth line', 'fifth line', 'sixth line'].join('\n');
    await textarea.fill(longText);
    const grown = await textarea.evaluate((el) => ({ h: el.offsetHeight, scroll: el.scrollHeight }));
    expect(grown.h).toBeGreaterThan(startH + 40);
    expect(grown.scroll).toBeLessThanOrEqual(grown.h + 1);
  });

  test('typing grows a vertically resized box downward to fit the text', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('held the level');
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    const cbox = await comment.boundingBox();
    await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-comment-resize')).toBeVisible();
    // Fix the height with a south drag, then type past what it holds.
    const south = await page.getByTestId('ann-resize-s').boundingBox();
    await page.mouse.move(south.x + south.width / 2, south.y + south.height / 2);
    await page.mouse.down();
    await page.mouse.move(south.x + south.width / 2, south.y + south.height / 2 + 40, { steps: 10 });
    await page.mouse.up();
    const resizedH = await comment.evaluate((el) => el.offsetHeight);
    await textarea.click();
    const longText = ['first line', 'second line', 'third line', 'fourth line', 'fifth line', 'sixth line'].join('\n');
    await textarea.fill(longText);
    const grown = await comment.evaluate((el) => {
      const ta = el.querySelector('textarea');
      return { boxH: el.offsetHeight, taH: ta.offsetHeight, scroll: ta.scrollHeight };
    });
    expect(grown.boxH).toBeGreaterThan(resizedH + 30);
    expect(Math.abs(grown.taH - grown.boxH)).toBeLessThanOrEqual(2);
    expect(grown.scroll).toBeLessThanOrEqual(grown.taH + 1);
  });

  test('Escape closes the comment resize handles', async ({ page }, testInfo) => {
    await openLightboxWithChart(page, testInfo);
    const overlay = page.getByTestId('ann-overlay');
    const box = await overlay.boundingBox();
    await page.getByTestId('ann-tool-comment').click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const textarea = page.getByTestId('ann-comment-text');
    await expect(textarea).toBeVisible();
    await textarea.fill('held the level');
    const comment = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    const cbox = await comment.boundingBox();
    await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, { button: 'right' });
    await expect(page.getByTestId('ann-comment-resize')).toBeVisible();
    // First Escape blurs the comment's text area; the second clears the
    // selection and the handles.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ann-comment-resize')).toHaveCount(0);
    // The lightbox itself is still open.
    await expect(page.getByTestId('chart-lightbox')).toBeVisible();
  });
});
