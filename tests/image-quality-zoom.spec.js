import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

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

    // Inline shows the 1600px medium tier (fast to decode at display
    // size), not the full original and not the 480px thumbnail. The
    // full 2560px original is reserved for the lightbox below.
    const inlineImg = container.locator('img');
    await expect
      .poll(async () => inlineImg.evaluate((img) => img.naturalWidth), { timeout: 15000 })
      .toBe(1600);

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
