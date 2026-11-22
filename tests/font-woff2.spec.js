import { test, expect } from '@playwright/test';

// Drop .woff files (round-2 improvement 5): the bundle must ship only
// woff2 fonts — no .woff file is ever requested, and Inter still loads
// and renders (all four weights the app imports).
test('only woff2 fonts load; Inter renders in all weights', async ({ page }) => {
  const woffRequests = [];
  page.on('request', (req) => {
    if (/\.woff$/.test(new URL(req.url()).pathname)) woffRequests.push(req.url());
  });
  page.on('response', (res) => {
    if (res.status() >= 400) throw new Error(`failed request: ${res.status()} ${res.url()}`);
  });

  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();

  expect(woffRequests).toEqual([]);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    // A fresh journal renders no week rows, so the 600/700 faces may
    // never have been used yet — check() alone would report them as
    // not loaded. Load each face explicitly: if its woff2 were missing
    // or broken, load() would fail and check() would stay false.
    await Promise.all([
      document.fonts.load('400 16px Inter'),
      document.fonts.load('500 16px Inter'),
      document.fonts.load('600 16px Inter'),
      document.fonts.load('700 16px Inter'),
    ]);
    return {
      inter400: document.fonts.check('400 16px Inter'),
      inter500: document.fonts.check('500 16px Inter'),
      inter600: document.fonts.check('600 16px Inter'),
      inter700: document.fonts.check('700 16px Inter'),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(fonts.inter400).toBe(true);
  expect(fonts.inter500).toBe(true);
  expect(fonts.inter600).toBe(true);
  expect(fonts.inter700).toBe(true);
  expect(fonts.bodyFont).toContain('Inter');
});
