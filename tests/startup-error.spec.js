import { test, expect } from '@playwright/test';

// Bug 4: an IndexedDB failure at startup used to hang the app on
// "Loading journal…" forever (initStorage had no .catch). It now shows
// an error screen with a Retry button. The failure is simulated by
// breaking IDBFactory.open while a flag is set — the flag stays set
// through the StrictMode double effect, and the test clears it before
// clicking Retry, so the retry genuinely re-opens storage.
async function breakStorage(page) {
  await page.addInitScript(() => {
    window.__failIdb = true;
    const origOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      if (window.__failIdb) {
        throw new Error('Simulated storage failure');
      }
      return origOpen.apply(this, args);
    };
  });
}

test.describe('Startup storage failure (bug 4)', () => {
  test('IDB failure shows an error screen, Retry loads the journal', async ({ page }) => {
    await breakStorage(page);
    await page.goto('/');
    const error = page.getByTestId('startup-error');
    await expect(error).toBeVisible({ timeout: 10000 });
    await expect(error).toContainText("Couldn't open the journal");
    await expect(error).toContainText('Simulated storage failure');
    await expect(page.getByText('Loading journal…')).toHaveCount(0);

    // Allow storage again, then retry: the journal must load.
    await page.evaluate(() => { window.__failIdb = false; });
    await page.getByTestId('startup-retry-btn').click();
    await expect(page.getByTestId('add-week-btn')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('startup-error')).toHaveCount(0);
  });
});
