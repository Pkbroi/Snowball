import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';

// Whole-database backup must be lossless in a real browser:
// upload a 2560x1440 chart, export, import the same file, export again —
// the image data URL must be byte-identical across the whole cycle.
test.describe('Backup round-trip (lossless)', () => {
  test('export → import → export keeps the chart byte-identical', async ({ page }, testInfo) => {
    const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    const pngBytes = makeChartPng(2560, 1440);
    fs.writeFileSync(fixture, pngBytes);
    const expectedDataUrl = 'data:image/png;base64,' + pngBytes.toString('base64');

    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toBeVisible();
    await firstDayCell.dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);

    await page.locator('input[type="file"]').first().setInputFiles(fixture);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('original-badge')).toBeVisible({ timeout: 15000 });

    await page.goBack();
    await expect(page.getByTestId('search-input')).toBeVisible();

    const exportOnce = async (name) => {
      await page.getByTestId('settings-btn').click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByText('Export as JSON').click();
      const download = await downloadPromise;
      const filePath = path.join(testInfo.outputDir, name);
      await download.saveAs(filePath);
      // Modal stays open after export; close it.
      await page.keyboard.press('Escape');
      return filePath;
    };

    const backup1Path = await exportOnce('backup1.json');
    const backup1 = JSON.parse(fs.readFileSync(backup1Path, 'utf8'));
    const imgEntry1 = backup1.find(([k]) => k.includes('__img_'));
    expect(imgEntry1).toBeTruthy();
    expect(imgEntry1[1]).toBe(expectedDataUrl);

    // Import the same file back (whole-database restore, then the app reloads).
    await page.getByTestId('settings-btn').click();
    await Promise.all([
      page.waitForLoadState('load'),
      page.locator('input[accept=".json"]').setInputFiles(backup1Path),
    ]);
    await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 15000 });
    // The week and its chart survived the restore.
    await expect(page.locator('div[data-testid^="week-row-week-custom-"]')).toHaveCount(1);

    const backup2Path = await exportOnce('backup2.json');
    const backup2 = JSON.parse(fs.readFileSync(backup2Path, 'utf8'));
    const imgEntry2 = backup2.find(([k]) => k.includes('__img_'));
    expect(imgEntry2).toBeTruthy();
    expect(imgEntry2[1]).toBe(expectedDataUrl);
    expect(JSON.stringify(backup2)).toBe(JSON.stringify(backup1));
  });
});
