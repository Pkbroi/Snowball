import { test, expect } from '@playwright/test';
import { makeChartPng } from './helpers/chart-png.js';

// Per-week metadata documents (perf step 4): small metadata used to be
// one IndexedDB key per week label / remarks / day notes / tags / image
// meta / trade date; now one document per week. The UI must not notice
// — these specs prove an old-format backup migrates on import and that
// notes typed in the UI survive a full page reload.
test.describe('Week documents (perf step 4)', () => {
  test('old-format backup migrates to week documents on import + reload', async ({ page }) => {
    const pngBytes = makeChartPng(256, 144);
    const dataUrl = 'data:image/png;base64,' + pngBytes.toString('base64');
    const p = 'sb_ds_nifty-50_2026__';
    const backup = JSON.stringify([
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
      [`${p}extra_weeks`, [{
        id: 'week-9', weekStart: 'Oct 27', weekEnd: 'Oct 31', remarks: '', isCustom: true,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => ({
          day: d, img: null, outcome: null, notes: '', instrument: null, timeframe: null, session: null, rr: null,
        })),
      }]],
      [`${p}wlbl_week-9`, { weekStart: 'Oct 27', weekEnd: 'Oct 31' }],
      [`${p}rem_week-9`, '<p>migrated remarks</p>'],
      [`${p}notes_week-9_Monday`, '<p>migrated note</p>'],
      [`${p}tags_week-9_Monday`, ['MigratedTag']],
      [`${p}meta_week-9_Monday`, { width: 256, height: 144, size: pngBytes.length, type: 'image/png', name: 'chart.png' }],
      [`${p}date_week-9_Monday`, '2026-10-27'],
      [`${p}img_week-9_Monday`, dataUrl],
    ]);

    await page.goto('/');
    await page.evaluate(async (json) => {
      const s = await import('/src/data/storage.js');
      await s.importDatabase(json);
    }, backup);

    // The week renders after import, with its label and remarks. (The
    // dates are input values, not text — read them, don't match text.)
    const row = page.locator('[data-testid="week-row-week-9"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('migrated remarks');
    await expect(row.locator('input').first()).toHaveValue('Oct 27');
    await expect(row.locator('input').nth(1)).toHaveValue('Oct 31');

    // Full reload: the migrated data must still be there.
    await page.reload();
    await expect(page.locator('[data-testid="week-row-week-9"]')).toBeVisible();
    const mondayCell = page.locator('[data-testid="day-cell-week-9-Monday"]');
    await expect(mondayCell).toBeVisible();
    await mondayCell.dblclick();
    await expect(page).toHaveURL(/\/trade\/week-9/);
    await expect(page.getByTestId('notes-editor')).toContainText('migrated note');
    await expect(page.locator('text=MigratedTag').first()).toBeVisible();
    await expect(page.getByTestId('original-badge')).toBeVisible();

    // And the database now holds a week document, not the old keys.
    const exported = await page.evaluate(async () => {
      const s = await import('/src/data/storage.js');
      return s.exportDatabase();
    });
    const data = JSON.parse(exported);
    const keys = data.map(([k]) => k);
    expect(keys).toContain(`${p}wk_week-9`);
    for (const old of ['notes', 'tags', 'meta', 'date', 'rem', 'wlbl']) {
      expect(keys.filter((k) => k.startsWith(`${p}${old}_week-9`))).toEqual([]);
    }
  });

  test('notes and tags typed in the UI survive a full page reload', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
    await expect(firstDayCell).toBeVisible();
    await firstDayCell.dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
    const weekId = page.url().split('/trade/')[1];

    const editor = page.getByTestId('notes-editor');
    await editor.fill('Week-doc persistence check');
    await expect(page.locator('text="Saved ✓"').first()).toBeVisible();
    await page.getByPlaceholder('Add tag...').fill('PersistTag');
    await page.getByPlaceholder('Add tag...').press('Enter');
    await expect(page.locator('text=PersistTag').first()).toBeVisible();

    // Back to the journal first: a hard reload of /trade/:id shows
    // "Trade not found" (the detail page depends on router state).
    await page.goBack();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await page.locator(`[data-testid="day-cell-${weekId}-Monday"]`).dblclick();
    await expect(page).toHaveURL(/\/trade\/.*/);
    await expect(page.getByTestId('notes-editor')).toContainText('Week-doc persistence check');
    await expect(page.locator('text=PersistTag').first()).toBeVisible();
  });
});
