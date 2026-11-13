import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Tests for the v2 smooth-experience work:
//  - three-tier images: inline detail shows the 1600px medium, the
//    lightbox shows the untouched 2560px original, and the Original
//    badge proves the stored file was not downscaled
//  - lightbox pan/zoom: zoom buttons, 1:1 pixels, wheel zoom
//  - search highlight comes from the once-built search index
async function uploadChart(page, testInfo) {
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
  return firstDayCell;
}

test.describe('Smooth experience (v2)', () => {
  test('inline shows the 1600px medium, badge shows the original, lightbox keeps 2560px', async ({ page }, testInfo) => {
    await uploadChart(page, testInfo);
    const inlineImg = page.getByTestId('chart-image-container').locator('img');
    // Medium tier: 2560 wide -> capped at 1600, not the full original
    // (decoding 2560px just to display it ~900px wide was inline jank).
    await expect
      .poll(async () => inlineImg.evaluate((img) => img.naturalWidth), { timeout: 15000 })
      .toBe(1600);
    const badge = page.getByTestId('original-badge');
    await expect(badge).toBeVisible({ timeout: 15000 });
    await expect(badge).toContainText('Original · 2560 × 1440');
    await expect(badge).toContainText('PNG');

    await page.getByTestId('chart-image-container').dblclick();
    const lightboxImg = page.getByTestId('chart-lightbox-image');
    await expect
      .poll(async () => lightboxImg.evaluate((img) => img.naturalWidth), { timeout: 15000 })
      .toBe(2560);
  });

  test('lightbox zoom: buttons, 1:1, and wheel zoom', async ({ page }, testInfo) => {
    await uploadChart(page, testInfo);
    await page.getByTestId('chart-image-container').dblclick();
    const lightbox = page.getByTestId('chart-lightbox');
    await expect(lightbox).toBeVisible();
    const label = page.getByTestId('lightbox-zoom-label');
    await expect(label).toHaveText('100%');

    await page.getByTestId('lightbox-zoom-in').click();
    await expect(label).toHaveText('125%');
    await page.getByTestId('lightbox-zoom-in').click();
    await expect(label).toHaveText('156%');

    // 1:1 pixels: 2560px image in a 1280px-wide viewport -> 200%
    await page.getByTestId('lightbox-zoom-1-1').click();
    await expect(label).toHaveText('200%');

    // Fit resets to 100%
    await page.getByTestId('lightbox-zoom-fit').click();
    await expect(label).toHaveText('100%');

    // Wheel up zooms in (non-passive wheel handler on the lightbox)
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => label.textContent(), { timeout: 5000 }).toMatch(/1[12]\d%/);

    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
  });

  test('search highlight still works from the once-built index', async ({ page }, testInfo) => {
    await uploadChart(page, testInfo);
    // Write a unique word into the notes, then go back to the journal.
    const editor = page.getByTestId('notes-editor');
    await editor.click();
    await page.keyboard.type('ZEBRA42 breakout');
    await page.waitForTimeout(800);
    await page.getByTestId('back-button').click();
    await expect(page).toHaveURL(/.*\/$/);

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('ZEBRA42');
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toHaveClass(/bg-white\/10/);
    await searchInput.fill('NonExistentQuery1234');
    await expect(page.locator('[data-testid^="day-cell-"]')).toHaveCount(0);
    await expect(page.getByText('No rows matched')).toBeVisible();
  });
});
