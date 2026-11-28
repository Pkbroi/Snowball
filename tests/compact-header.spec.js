import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { makeChartPng } from './helpers/chart-png.js';
import { ensureNotesEditor } from './helpers/notes-editor.js';

// The detail-page header (date pill, day name) is compact —
// tight rows, slim top padding, the chart pulled up under the divider
// — and the date pill, day name and tag chips are matte black with
// thick white text, the same theme as the header buttons. The tags
// row no longer lives in the header: it sits under the chart, on top
// of the notes section.

async function openWednesday(page) {
  await page.goto('/');
  await page.getByTestId('add-week-btn').click();
  const wedCell = page.locator('[data-testid$="-Wednesday"]').first();
  await expect(wedCell).toBeVisible();
  await wedCell.dblclick();
  await expect(page).toHaveURL(/\/trade\/.*/);
  await expect(page.getByTestId('detail-header')).toBeVisible();
}

async function styleOf(locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, weight: cs.fontWeight };
  });
}

test.describe('Compact detail-page header', () => {
  test('date pill, day name and tag chips are matte black with thick white text', async ({ page }) => {
    test.setTimeout(120000);
    await openWednesday(page);
    const tagInput = page.getByPlaceholder('Add tag...');
    await tagInput.fill('gapup');
    await tagInput.press('Enter');
    const chip = page.locator('div:has(> input[placeholder="Add tag..."]) > span', { hasText: 'gapup' });
    await expect(chip).toBeVisible();

    // Date pill: pure black, white, bold.
    const pill = page.getByText('Select date');
    expect(await styleOf(pill)).toEqual({ bg: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)', weight: '700' });
    // Day name: white, bold.
    const day = page.getByText('Wednesday', { exact: true }).first();
    const dayStyle = await styleOf(day);
    expect(dayStyle.color).toBe('rgb(255, 255, 255)');
    expect(dayStyle.weight).toBe('700');
    // Tag chip: pure black, white, bold.
    expect(await styleOf(chip)).toEqual({ bg: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)', weight: '700' });
  });

  test('the header block is compact', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await openWednesday(page);
    // Seed a chart so the header-to-chart distance is measurable in
    // the real layout (the chart section follows the header).
    const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(fixture, makeChartPng(2560, 1440));
    await page.locator('input[type="file"]').first().setInputFiles(fixture);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    const header = await page.getByTestId('detail-header').boundingBox();
    // Date row (~28px) + 6px + divider (1px) — the tags row used to
    // live here too; it now sits under the chart, so the header
    // measures ~43px instead of ~65px.
    expect(header.height).toBeLessThan(55);
    // And the chart sits close under the header: top padding 16px +
    // header ~43px + 8px effective gap, versus ~96px before the move.
    const chart = await page.getByTestId('chart-image-container').boundingBox();
    const main = await page.locator('main').boundingBox();
    expect(chart.y - main.y).toBeLessThan(85);
  });

  test('the tags row sits under the chart, above the notes section', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await openWednesday(page);
    const fixture = path.join(testInfo.outputDir, 'chart-2560x1440.png');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(fixture, makeChartPng(2560, 1440));
    await page.locator('input[type="file"]').first().setInputFiles(fixture);
    await expect(page.getByTestId('chart-image-container')).toBeVisible({ timeout: 15000 });
    const tagInput = page.getByPlaceholder('Add tag...');
    await tagInput.fill('gapup');
    await tagInput.press('Enter');
    await expect(page.locator('div:has(> input[placeholder="Add tag..."]) > span', { hasText: 'gapup' })).toBeVisible();

    const editor = await ensureNotesEditor(page);
    const chart = await page.getByTestId('chart-image-container').boundingBox();
    const tags = await page.getByTestId('tags-row').boundingBox();
    const editorBox = await editor.boundingBox();
    expect(tags.y).toBeGreaterThan(chart.y + chart.height);
    expect(tags.y).toBeLessThan(editorBox.y);
  });
});
