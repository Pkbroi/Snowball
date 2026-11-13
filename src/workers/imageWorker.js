/**
 * imageWorker — derivative image generation, off the main thread.
 *
 * Receives { id, blob, maxDim, quality } and posts back { id, blob }.
 * Runs entirely in the worker: createImageBitmap + OffscreenCanvas, so
 * decoding / downscaling a 2560px chart never blocks scrolling or typing.
 * The main thread falls back to its own canvas path when Workers are
 * unavailable (jsdom tests, very old browsers) or the worker errors.
 * The worker NEVER touches the original — it only ever receives a Blob
 * and returns a smaller derived Blob (thumbnail / medium).
 */
self.onmessage = async (e) => {
  const { id, blob, maxDim, quality } = e.data || {};
  try {
    if (!blob || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('worker image APIs unavailable');
    }
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      const out = await canvas.convertToBlob({ type: 'image/webp', quality });
      self.postMessage({ id, blob: out });
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
