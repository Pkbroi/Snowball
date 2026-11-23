import { test, expect } from '@playwright/test';

// Bug 13: createDerivative and getImageDimensions created object URLs
// (URL.createObjectURL) for the source image and never revoked them —
// one leaked URL per upload (and per derivation on the fallback path).
// The URL must be revoked once the image is decoded (or has failed).
test.describe('Object URL leaks (bug 13)', () => {
  test('getImageDimensions and createDerivative revoke their object URLs', async ({ page }) => {
    await page.goto('/');
    const revoked = await page.evaluate(async () => {
      const revokedUrls = [];
      const origRevoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => { revokedUrls.push(url); return origRevoke(url); };
      const { getImageDimensions, createDerivative } = await import('/src/data/storage.js');
      const blob = await new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 450;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#224488';
        ctx.fillRect(0, 0, 800, 450);
        canvas.toBlob(resolve, 'image/png');
      });
      const dims = await getImageDimensions(blob);
      // The bitmap path above creates no URL; the <img> fallback does,
      // so exercise it by hiding createImageBitmap for one call.
      const origBitmap = window.createImageBitmap;
      window.createImageBitmap = undefined;
      const fallbackDims = await getImageDimensions(blob);
      window.createImageBitmap = origBitmap;
      // createDerivative takes the worker path when one exists, which
      // creates no URL at all — hide Worker so the main-thread path
      // runs and its object URL is exercised.
      const origWorker = window.Worker;
      window.Worker = undefined;
      const thumb = await createDerivative(blob, { maxDim: 480, quality: 0.8 });
      window.Worker = origWorker;
      return { dims, fallbackDims, thumbIsBlob: thumb instanceof Blob, revokedUrls };
    });
    expect(revoked.dims).toEqual({ width: 800, height: 450 });
    expect(revoked.fallbackDims).toEqual({ width: 800, height: 450 });
    expect(revoked.thumbIsBlob).toBe(true);
    // Both functions created a blob: URL for the source and revoked it:
    // one from getImageDimensions' <img> fallback, one from
    // createDerivative's main-thread path.
    const blobUrls = revoked.revokedUrls.filter((u) => u.startsWith('blob:'));
    expect(blobUrls.length).toBeGreaterThanOrEqual(2);
  });
});
