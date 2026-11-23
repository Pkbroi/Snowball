import { test, expect } from '@playwright/test';

// Bug 11: addTag took any tag, so "gapup" and "GapUp" both landed as
// separate chips (and removeTag then removed all matches at once).
// A tag that already exists — case-insensitively — must be ignored.
async function openFirstDay(page) {
  await page.goto('/');
  await page.getByTestId('add-week-btn').click();
  const firstDayCell = page.locator('[data-testid^="day-cell-"]').first();
  await expect(firstDayCell).toBeVisible();
  await firstDayCell.dblclick();
  await expect(page).toHaveURL(/\/trade\/.*/);
}

test.describe('Duplicate tags (bug 11)', () => {
  test('adding the same tag twice, in different cases, keeps one chip', async ({ page }) => {
    await openFirstDay(page);
    const tagInput = page.getByPlaceholder('Add tag...');
    const chips = page.locator('div:has(> input[placeholder="Add tag..."]) > span');
    await tagInput.fill('gapup');
    await tagInput.press('Enter');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('gapup');
    await tagInput.fill('GapUp');
    await tagInput.press('Enter');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('gapup');
    await expect(tagInput).toHaveValue('');
  });

  test('removing a tag still removes it, and a different tag is kept', async ({ page }) => {
    await openFirstDay(page);
    const tagInput = page.getByPlaceholder('Add tag...');
    const chips = page.locator('div:has(> input[placeholder="Add tag..."]) > span');
    await tagInput.fill('gapup');
    await tagInput.press('Enter');
    await tagInput.fill('breakout');
    await tagInput.press('Enter');
    await expect(chips).toHaveCount(2);
    await chips.filter({ hasText: 'gapup' }).locator('button').click();
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('breakout');
  });
});
