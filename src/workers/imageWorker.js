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
 *
 * A third message, off the same worker so no second worker is spawned:
 *   { id, parseBackup: true, buffer, currentDataset, datasets,
 *     defaultDatasetId } → { id, otherEntries, imageBlobs,
 *     importTargetId, wipeAll, wipePrefix }
 *     parse + validate + normalise + base64-decode a whole backup
 *     (see src/data/backupParse.js) — the import path, so a large
 *     backup's JSON.parse and image decode never block the main thread.
 *     `buffer` is the backup's bytes TRANSFERRED here (zero-copy), so
 *     the main thread never clones the huge string — sending a string
 *     would cost ~300 ms of main-thread structured-clone for 160 MB.
 *     The worker decodes the text itself (TextDecoder, off-thread).
 *     A backup that fails validation answers { id, parseError } (not
 *     `error`): the caller must surface that message, NOT fall back to
 *     the main thread and re-parse — the backup is invalid either way.
 *     A real worker failure still answers { id, error } and the caller
 *     falls back to the main-thread parse.
 */
import { parseBackup } from '../data/backupParse.js';

self.onmessage = async (e) => {
  const { id, blob, maxDim, quality, deriveAll, parseBackup: doParse, buffer, currentDataset, datasets, defaultDatasetId } = e.data || {};
  if (doParse) {
    try {
      // The backup arrives as transferred bytes; decode the text here,
      // off the main thread, then run the shared parser.
      const jsonString = new TextDecoder().decode(buffer);
      const parsed = await parseBackup(jsonString, { currentDataset, datasets, defaultDatasetId });
      self.postMessage({ id, ...parsed });
    } catch (err) {
      self.postMessage({ id, parseError: String(err && err.message ? err.message : err) });
    }
    return;
  }
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
