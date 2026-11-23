import { test, expect } from '@playwright/test';

// Bug 10: the GoTo modal's "Go to" button closed the modal even when
// the form was incomplete (no date, or only one end of a range) —
// silently applying nothing. The button must stay disabled until the
// form is complete.
async function openGoTo(page) {
  await page.goto('/');
  await page.locator('button[title="Go to date filter"]').click();
  await expect(page.getByRole('heading', { name: 'Go to' })).toBeVisible();
  return page.getByRole('button', { name: 'Go to', exact: true });
}

test.describe('GoTo modal (bug 10)', () => {
  test('the Date tab stays disabled until a date is picked', async ({ page }) => {
    const goTo = await openGoTo(page);
    await expect(goTo).toBeDisabled();
    await page.locator('input[type="date"]').first().fill('2026-01-05');
    await expect(goTo).toBeEnabled();
    await goTo.click();
    await expect(page.getByRole('heading', { name: 'Go to' })).toHaveCount(0);
    await expect(page.locator('button[title="Go to date filter"] span.bg-primary')).toHaveCount(1);
  });

  test('the Custom range tab stays disabled until both ends are picked', async ({ page }) => {
    const goTo = await openGoTo(page);
    await page.getByRole('button', { name: 'Custom range' }).click();
    const from = page.locator('input[type="date"]').nth(0);
    const to = page.locator('input[type="date"]').nth(1);
    await expect(goTo).toBeDisabled();
    await from.fill('2026-01-05');
    await expect(goTo).toBeDisabled();
    await to.fill('2026-01-09');
    await expect(goTo).toBeEnabled();
    await goTo.click();
    await expect(page.getByRole('heading', { name: 'Go to' })).toHaveCount(0);
    await expect(page.locator('button[title="Go to date filter"] span.bg-primary')).toHaveCount(1);
  });
});
