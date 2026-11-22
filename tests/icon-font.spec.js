import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChartPng } from './helpers/chart-png.js';

// Tests for the subset Material Symbols font (perf step 3): the app
// ships a 5.8KB subset with only the icons it uses, instead of the full
// 1.1MB font. If the subset lost a ligature, the raw word (e.g.
// "settings") renders instead of the glyph — several em wide, not ~1em —
// so this spec asserts every rendered icon is a known name AND renders
// as a single glyph (width ≈ its font size) on the journal, the detail
// page and the lightbox toolbar.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS = new Set(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'material-symbols-icons.txt'), 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean),
);

async function assertIconsRender(page) {
  // One atomic snapshot: the detail page re-renders while Quill and the
  // image load, so counting icons and then reading them one by one can
  // catch elements that unmounted in between.
  await expect(page.locator('.material-symbols-outlined').first()).toBeVisible();
  const icons = await page.evaluate(() =>
    [...document.querySelectorAll('.material-symbols-outlined')].map((n) => {
      const r = n.getBoundingClientRect();
      return {
        text: n.textContent?.trim(),
        width: r.width,
        fontSize: parseFloat(getComputedStyle(n).fontSize),
      };
    }),
  );
  expect(icons.length).toBeGreaterThan(0);
  for (const { text, width, fontSize } of icons) {
    if (width === 0) continue; // hidden icon (e.g. inside a closed panel)
    expect(ICONS.has(text), `unknown icon text: ${text}`).toBe(true);
    expect(
      width,
      `icon "${text}" is ${width}px wide at ${fontSize}px font — its ligature did not apply`,
    ).toBeLessThanOrEqual(fontSize * 1.3);
  }
}

test.describe('Subset icon font (perf step 3)', () => {
  test('journal header icons render as single glyphs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('settings-btn')).toBeVisible();
    await assertIconsRender(page);
  });

  test('detail page and lightbox toolbar icons render as single glyphs', async ({ page }, testInfo) => {
    const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(fixture, makeChartPng(2560, 1440));
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toBeVisible();
    await firstDayCell.dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
    // Detail page without a chart yet: back arrow, calendar, dropzone icon.
    await assertIconsRender(page);
    await page.locator('input[type="file"]').first().setInputFiles(fixture);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('chart-image-container').dblclick();
    await expect(page.getByTestId('ann-toolbar')).toBeVisible();
    // Lightbox toolbar: select, line, pencil is SVG, comment, delete, clear.
    await assertIconsRender(page);
  });
});
