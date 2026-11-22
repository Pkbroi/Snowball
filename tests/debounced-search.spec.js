import { test, expect } from '@playwright/test';

// Debounced search (perf step 11): the input updates instantly, but the
// URL query — which drives the search index + row filtering — commits
// ~100ms after the user stops typing. Results are identical, just later.
test.describe('Debounced search (perf step 11)', () => {
  test('input updates instantly, URL commits after a pause, results identical', async ({ page }) => {
    await page.goto('/');
    for (let i = 0; i < 3; i++) await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(500);
    const ids = await page.locator('[data-testid^="week-row-"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-testid').replace('week-row-', '')));
    const [A, B, C] = ids;
    await page.evaluate(async ([a, b, c]) => {
      const s = await import('/src/data/storage.js');
      s.setNotes(a, 'Monday', '<p>GapUp</p>');
      s.setNotes(a, 'Tuesday', '<p>gapdown</p>');
      s.setNotes(b, 'Monday', '<p>GAPDOWN</p>');
      s.setNotes(c, 'Monday', '<p>gapup</p>');
    }, [A, B, C]);

    const input = page.getByTestId('search-input');
    await input.click();
    // Mid-typing the commit must not have happened yet: each keystroke
    // restarts the 100ms timer, so the URL still has no query.
    await page.keyboard.type('ga', { delay: 10 });
    await expect(input).toHaveValue('ga');
    expect(page.url()).not.toContain('q=');
    await page.keyboard.type('pup', { delay: 10 });
    await expect(input).toHaveValue('gapup');

    // After the pause the query lands in the URL and the same results
    // appear as an undebounced search would give.
    await expect.poll(() => page.url(), { timeout: 5000 }).toContain('q=gapup');
    const outlined = await page.evaluate(() => [...document.querySelectorAll(
      '[data-testid^="day-cell-"], [data-testid^="remarks-cell-"], [data-testid^="week-label-"]',
    )].filter((el) => el.className.includes('ring-amber-400'))
      .map((el) => el.getAttribute('data-testid')));
    expect(outlined).toEqual(expect.arrayContaining([
      `day-cell-${A}-Monday`, `day-cell-${C}-Monday`,
    ]));
    const rows = await page.locator('[data-testid^="week-row-"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-testid').replace('week-row-', '')));
    expect(rows).toEqual(expect.arrayContaining([A, C]));
    expect(rows).not.toContain(B);
  });

  test('the × button clears immediately, with no debounce delay', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(500);
    const input = page.getByTestId('search-input');
    await input.fill('zzz-no-match');
    await expect.poll(() => page.url(), { timeout: 5000 }).toContain('q=zzz-no-match');
    await expect(page.locator('[data-testid^="week-row-"]')).toHaveCount(0);

    // Clear: the input and the URL must empty right away, and the row
    // must come back without waiting out a debounce window.
    await page.locator('.material-symbols-outlined', { hasText: 'close' }).first().click();
    await expect(input).toHaveValue('');
    expect(page.url()).not.toContain('q=');
    await expect(page.locator('[data-testid^="week-row-"]')).toHaveCount(1);
  });
});
