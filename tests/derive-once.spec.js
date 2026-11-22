import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Decode once, derive twice (perf step 5): uploading a chart must
// produce the same three tiers as before — 480px thumb, 1600px medium,
// untouched original — plus the original dimensions in the metadata,
// but from a single worker decode. The tiers are asserted by reading
// them back through the storage module in the real browser.
test.describe('Decode once, derive twice (perf step 5)', () => {
  test('upload produces the same three tiers + metadata as the old path', async ({ page }, testInfo) => {
    const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(fixture, makeChartPng(2560, 1440));

    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toBeVisible();
    await firstDayCell.dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
    const weekId = page.url().split('/trade/')[1];

    await page.locator('input[type="file"]').first().setInputFiles(fixture);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('original-badge')).toBeVisible({ timeout: 15000 });

    const tiers = await page.evaluate(async (id) => {
      const s = await import('/src/data/storage.js');
      const readDims = async (url) => {
        if (!url) return null;
        const blob = await (await fetch(url)).blob();
        const bmp = await createImageBitmap(blob);
        const d = { width: bmp.width, height: bmp.height, type: blob.type };
        bmp.close();
        return d;
      };
      // resolveMediumAsync generates the medium on demand if the
      // background store from the upload has not landed yet.
      return {
        meta: s.getImageMeta(id, 'Monday'),
        thumb: await readDims(s.getStoredThumb(id, 'Monday')),
        medium: await readDims(await s.resolveMediumAsync(id, 'Monday')),
        full: await readDims(await s.getStoredImgAsync(id, 'Monday')),
      };
    }, weekId);

    // Metadata: the original dimensions, never the derived ones.
    expect(tiers.meta).toMatchObject({ width: 2560, height: 1440, type: 'image/png' });
    // Thumb tier: 480px wide WebP, grid only.
    expect(tiers.thumb).toEqual({ width: 480, height: 270, type: 'image/webp' });
    // Medium tier: 1600px wide WebP, detail page only.
    expect(tiers.medium).toEqual({ width: 1600, height: 900, type: 'image/webp' });
    // Full tier: the original, untouched.
    expect(tiers.full).toEqual({ width: 2560, height: 1440, type: 'image/png' });
  });
});
