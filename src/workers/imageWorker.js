/**
 * imageWorker — derivative image generation, off the main thread.
 *
 * Two messages, both answered off-thread with createImageBitmap +
 * OffscreenCanvas, so decoding / downscaling a 2560px chart never
 * blocks scrolling or typing:
 *   { id, blob, maxDim, quality } → { id, blob }
 *     one derivative (thumbnail or medium) — used by the legacy-image
 *     backfill, which derives one tier at a time.
 *   { id, blob, deriveAll: true } → { id, deriveAll: true, thumb,
 *     medium, width, height }
 *     one decode producing BOTH tiers plus the original dimensions —
 *     the upload path, so a chart is decoded once instead of three
 *     times (dimensions + thumb + medium used to be three decodes).
 * The worker NEVER touches the original — it only ever receives a Blob
 * and returns smaller derived Blobs (thumbnail / medium).
 */
self.onmessage = async (e) => {
  const { id, blob, maxDim, quality, deriveAll } = e.data || {};
  try {
    if (!blob || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('worker image APIs unavailable');
    }
    const bitmap = await createImageBitmap(blob);
    try {
      const derive = async (maxDimForTier, qualityForTier) => {
        const scale = Math.min(1, maxDimForTier / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
        return canvas.convertToBlob({ type: 'image/webp', quality: qualityForTier });
      };
      if (deriveAll) {
        // One decode, both tiers, from the same bitmap.
        const [thumb, medium] = await Promise.all([
          derive(480, 0.8),
          derive(1600, 0.85),
        ]);
        self.postMessage({ id, deriveAll: true, thumb, medium, width: bitmap.width, height: bitmap.height });
      } else {
        const out = await derive(maxDim, quality);
        self.postMessage({ id, blob: out });
      }
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
