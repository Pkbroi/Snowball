import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// One perimeter on the comment box, never two overlapping ones:
// blue while typing or selected, white when unselected. The wrapper
// used to carry a second, white ring-2 that hung 6px below the box
// (the textarea sits on the text baseline, so the wrapper is taller),
// reading as a shadow box behind the blue one; and the forms plugin's
// blue focus ring added a third outline while typing.

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

async function placeComment(page) {
  const overlay = page.getByTestId('ann-overlay');
  await page.getByTestId('ann-tool-comment').click();
  const box = await overlay.boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.35);
  const textarea = page.getByTestId('ann-comment-text');
  await expect(textarea).toBeVisible();
  await textarea.fill('held the level');
  return textarea;
}

async function perimeterOf(locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: `${s.borderWidth} ${s.borderStyle} ${s.borderColor}`, shadow: s.boxShadow };
  });
}

test.describe('Comment box single perimeter', () => {
  test('blue while typing or selected, white when unselected, never two', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await openLightboxWithChart(page, testInfo);
    const textarea = await placeComment(page);
    const wrapper = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');

    // Typing: focused + selected — one blue border, no focus ring, no wrapper ring.
    expect(await perimeterOf(textarea)).toEqual({
      border: '1px solid rgb(37, 99, 235)',
      shadow: 'none',
    });
    expect((await perimeterOf(wrapper)).shadow).toBe('none');

    // Escape once: blurred, still selected — stays blue, still one outline.
    await page.keyboard.press('Escape');
    await expect(textarea).not.toBeFocused();
    expect(await perimeterOf(textarea)).toEqual({
      border: '1px solid rgb(37, 99, 235)',
      shadow: 'none',
    });
    expect((await perimeterOf(wrapper)).shadow).toBe('none');

    // Escape again: deselected, lightbox still open — one white border.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chart-lightbox')).toBeVisible();
    expect(await perimeterOf(textarea)).toEqual({
      border: '1px solid rgba(255, 255, 255, 0.4)',
      shadow: 'none',
    });
    expect((await perimeterOf(wrapper)).shadow).toBe('none');
  });

  test('right-click resize keeps the amber dotted border, no second outline', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await openLightboxWithChart(page, testInfo);
    const textarea = await placeComment(page);
    await textarea.click({ button: 'right' });
    await expect(page.getByTestId('ann-comment-resize')).toBeVisible();
    expect(await perimeterOf(textarea)).toEqual({
      border: '2px dotted rgb(251, 191, 36)',
      shadow: 'none',
    });
    const wrapper = page.locator('[data-testid="ann-mark"][data-ann-type="comment"]');
    expect((await perimeterOf(wrapper)).shadow).toBe('none');
  });
});
