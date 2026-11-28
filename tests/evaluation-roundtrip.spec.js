import { test, expect } from '@playwright/test';

// The front page stays in Evaluation mode across the detail-page round
// trip, and coming back lands on the cell that was entered — in both
// return paths (the in-app BACK button and the browser back button).
// The mode used to reset to Charts on every remount (plain useState
// default); it is now persisted in sessionStorage (sb_view_mode), the
// same pattern as sb_zoom. The scroll/cell restore already existed
// (sb_scroll_top/left + returnWeekId/returnDay) and is pinned here.

async function addWeeks(page, n) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  for (let i = 0; i < n; i++) {
    await page.getByTestId('add-week-btn').click();
    await page.waitForTimeout(300);
  }
  const weekIds = await page.locator('[data-testid^="week-row-"]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-testid').replace('week-row-', '')),
  );
  expect(weekIds.length).toBe(n);
  return weekIds;
}

// "In view" with a 2px tolerance: the day cells are aspect-ratio sized,
// so a cell can sit a sub-pixel past the container edge (measured
// 0.375px) while being visibly in place — that is not a missed landing.
async function cellInView(page, weekId, day) {
  return page.evaluate(({ weekId, day }) => {
    const container = document.querySelector('[data-testid="main-scroll-container"]');
    const cell = document.querySelector(`[data-testid="day-cell-${weekId}-${day}"]`);
    if (!container || !cell) return { found: false, inView: false };
    const c = container.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    const tol = 2;
    return {
      found: true,
      inView: r.top >= c.top - tol && r.bottom <= c.bottom + tol && r.left >= c.left - tol && r.right <= c.right + tol,
      ring: cell.className.includes('ring-primary'),
    };
  }, { weekId, day });
}

async function assertReturnedToCell(page, weekId, day) {
  await expect(page.locator('[data-testid^="week-row-"]').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1000);
  // Still in Evaluation mode.
  await expect(page.getByTestId('view-evaluation-btn')).toHaveClass(/bg-white/);
  // On the entered cell, with the return-trip highlight ring.
  const landed = await cellInView(page, weekId, day);
  expect(landed.found).toBe(true);
  expect(landed.inView).toBe(true);
  expect(landed.ring).toBe(true);
}

test('evaluation mode and the entered cell survive the round trip', async ({ page }) => {
  test.setTimeout(180000);
  const weekIds = await addWeeks(page, 8);
  const targetWeek = weekIds[7];

  await page.getByTestId('view-evaluation-btn').click();
  await page.waitForTimeout(800);

  const cell = page.getByTestId(`day-cell-${targetWeek}-Monday`);
  await cell.scrollIntoViewIfNeeded();
  await cell.dblclick();
  await expect(page.getByTestId('notes-view-toggle')).toBeVisible({ timeout: 30000 });

  // In-app BACK button path.
  await page.getByRole('button', { name: 'BACK' }).click();
  await assertReturnedToCell(page, targetWeek, 'Monday');

  // Browser-back path.
  await cell.dblclick();
  await expect(page.getByTestId('notes-view-toggle')).toBeVisible({ timeout: 30000 });
  await page.goBack();
  await assertReturnedToCell(page, targetWeek, 'Monday');
});
