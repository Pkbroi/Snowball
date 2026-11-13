import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging regression test for the v2 black-screen bug: the v2 exe
// shipped with NO dist/ inside it (the build output had been deleted
// before electron-builder ran, and electron-builder does not run the
// Vite build), so main.cjs's loadFile(dist/index.html) silently failed
// and the app opened to a blank black window.
//
// This test loads dist/index.html exactly the way Electron does —
// file://, no dev server — and asserts the journal actually renders.
// Run `npm run build` first; the test skips itself if dist is absent
// (a missing dist is a packaging failure, caught by scripts/verify-dist).
const distIndex = path.join(process.cwd(), 'dist', 'index.html');

test.describe('Electron packaging (file:// load)', () => {
  test('dist/index.html renders the journal over file://', async ({ page }) => {
    test.skip(!fs.existsSync(distIndex), 'dist/index.html not built — run npm run build first');
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(fileURLToPath(`file://${distIndex}`));
    // The app's loading screen, then the journal header
    await expect(page.getByTestId('add-week-btn')).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  });
});
