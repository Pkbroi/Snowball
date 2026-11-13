import { get, set, del, keys, entries, clear } from 'idb-keyval';

/**
 * Snowball persistence helpers using idb-keyval (IndexedDB)
 * with an in-memory cache for synchronous, zero-latency retrieval.
 *
 * IMAGE QUALITY RULE (regression fix, see BUG-REPORT.md):
 * Full-resolution chart images are stored LOSSLESSLY, exactly as uploaded.
 * No resize, no re-encode, no `browser-image-compression` on the upload path.
 * The old code did `FileReader.readAsDataURL(file)` with no compression;
 * the 8794d9b change added `maxSizeMB: 1, maxWidthOrHeight: 1920`, which
 * downscaled wide trading screenshots and re-encoded them lossily — and
 * because the compressed data-URL was what got stored, the original was
 * lost permanently. Only derived copies below are ever compressed, and
 * only for display at their own size:
 *   thumb  — 480px, grid only
 *   medium — 1600px, detail page inline only
 *   full   — the original Blob, lightbox / zoom only, never re-encoded.
 * Derivatives are generated in a Web Worker (src/workers/imageWorker.js)
 * so encoding never blocks scrolling; the main thread is the fallback.
 */

const memCache = new Map();

const revokeBlobUrl = (url) => {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  }
};

/**
 * Convert a data-URL string directly to a Blob using atob + Uint8Array.
 * Function declaration so it is hoisted for use by getStoredImgAsync below.
 * (Previously defined only near the export helpers, below its first use.)
 */
function dataURLtoBlob(dataURL) {
  const comma = dataURL.indexOf(',');
  const mime = dataURL.slice(5, dataURL.indexOf(';'));
  const b64 = dataURL.slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Run async tasks with limited concurrency to avoid overwhelming the IndexedDB
 * queue on startup, which keeps the main thread responsive and load times short.
 * @param {any[]} items - items to process
 * @param {(item: any) => Promise<void>} task - async task for each item
 * @param {number} batchSize - max concurrent operations
 */
const runBatched = async (items, task, batchSize = 8) => {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(task));
  }
};

/* ─── Cell chart images (Two-Tier Engine: Full-Res + Ultra-Fast Thumbnail) ─── */
const imgKey = (weekId, dayName) => `sb_img_${weekId}_${dayName}`;
const thumbKey = (weekId, dayName) => `sb_thumb_${weekId}_${dayName}`;
const medKey = (weekId, dayName) => `sb_med_${weekId}_${dayName}`;
const metaKey = (weekId, dayName) => `sb_meta_${weekId}_${dayName}`;
export const MEDIUM_MAX_DIM = 1600;
export const THUMB_MAX_DIM = 480;

/**
 * Fast native thumbnail generator using 2D Canvas.
 * Resizes images to max 480px width/height and compresses to WebP/JPEG ~25KB.
 * GRID ONLY. Never feed its output to the detail page or the lightbox —
 * that is exactly how the zoom regression happened (480px thumb shown
 * full-screen). The full-res image is always kept separately under sb_img_*.
 */

/* ─── Derivative generation in a Web Worker (with main-thread fallback) ─── */
let imageWorker = null;
let workerSeq = 0;
const workerPending = new Map();

const getImageWorker = () => {
  if (imageWorker) return imageWorker;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  try {
    imageWorker = new Worker(new URL('../workers/imageWorker.js', import.meta.url), { type: 'module' });
    imageWorker.onmessage = (e) => {
      const { id, blob, error } = e.data || {};
      const entry = workerPending.get(id);
      if (!entry) return;
      workerPending.delete(id);
      clearTimeout(entry.timer);
      if (error || !blob) entry.reject(new Error(error || 'worker failed'));
      else entry.resolve(blob);
    };
    imageWorker.onerror = () => {
      // Fail every pending call so callers fall back to the main thread.
      for (const [, entry] of workerPending) { clearTimeout(entry.timer); entry.reject(new Error('worker error')); }
      workerPending.clear();
      imageWorker = null;
    };
    return imageWorker;
  } catch {
    return null;
  }
};

const generateDerivativeInWorker = (blob, maxDim, quality) => new Promise((resolve, reject) => {
  const worker = getImageWorker();
  if (!worker) { reject(new Error('no worker')); return; }
  const id = ++workerSeq;
  const timer = setTimeout(() => {
    workerPending.delete(id);
    reject(new Error('worker timeout'));
  }, 10000);
  workerPending.set(id, { resolve, reject, timer });
  try {
    worker.postMessage({ id, blob, maxDim, quality });
  } catch (err) {
    workerPending.delete(id);
    clearTimeout(timer);
    reject(err);
  }
});

/** Dimensions of a Blob without decoding the whole image into the DOM. */
export const getImageDimensions = async (blob) => {
  if (!blob) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const dims = { width: bitmap.width, height: bitmap.height };
      if (typeof bitmap.close === 'function') bitmap.close();
      return dims;
    } catch { /* fall through to <img> */ }
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1000);
    const img = new Image();
    img.onload = () => { clearTimeout(timer); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = URL.createObjectURL(blob);
  });
};

/** Stored metadata for an uploaded chart: original dims / size / type. */
export const getImageMeta = (weekId, dayName) => memCache.get(metaKey(weekId, dayName)) ?? null;

export const formatBytes = (bytes) => {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Derivative generator (thumbnail / medium). Tries the Web Worker first so
 * decoding + downscaling never blocks the main thread / scrolling; falls
 * back to the main-thread canvas path when Workers are unavailable or fail.
 * `source` may be a Blob or a data-URL string. Returns a Blob, or `source`
 * unchanged when generation is impossible (jsdom tests, tiny images).
 */
export const createDerivative = async (source, { maxDim = THUMB_MAX_DIM, quality = 0.8 } = {}) => {
  if (!source || typeof document === 'undefined') return source;
  if (typeof window !== 'undefined' && window.navigator?.userAgent?.includes('jsdom')) {
    return source;
  }
  // Worker path (Blobs only) — decoding + canvas happen off-thread.
  if (source instanceof Blob) {
    try {
      const out = await generateDerivativeInWorker(source, maxDim, quality);
      if (out && out instanceof Blob) return out;
    } catch {
      // fall through to the main-thread path below
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(res);
      }
    };
    const timer = setTimeout(() => finish(source), 10000);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          if (typeof OffscreenCanvas !== 'undefined') {
            try {
              const offscreen = new OffscreenCanvas(width, height);
              const ctx = offscreen.getContext('2d');
              if (!ctx) { finish(source); return; }
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(img, 0, 0, width, height);
              offscreen.convertToBlob({ type: 'image/webp', quality })
                .then(blob => { if (blob) finish(blob); else finish(source); })
                .catch(() => finish(source));
            } catch {
              finish(source);
            }
          } else {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) { finish(source); return; }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob((blob) => {
              if (blob) finish(blob);
              else finish(source);
            }, 'image/webp', quality);
          }
        } catch {
          finish(source);
        }
      };
      img.onerror = () => finish(source);
      if (source instanceof Blob) {
        img.src = URL.createObjectURL(source);
      } else if (typeof source === 'string') {
        img.src = source;
      } else {
        finish(source);
      }
    } catch {
      finish(source);
    }
  });
};

/** 480px grid thumbnail — GRID ONLY, never detail / lightbox. */
export const createThumbnail = (source) => createDerivative(source, { maxDim: THUMB_MAX_DIM, quality: 0.8 });

/** 1600px detail-page image — inline detail only, never the lightbox. */
export const createMedium = (source) => createDerivative(source, { maxDim: MEDIUM_MAX_DIM, quality: 0.85 });

export const initStorage = async (onProgress) => {
  const allKeys = await keys();
  memCache.clear();

  // 1. Load metadata, notes, tags, remarks, and extra weeks
  const metaKeys = allKeys.filter(k => typeof k === 'string' && !k.startsWith('sb_img_') && !k.startsWith('sb_thumb_') && !k.startsWith('sb_med_'));
  // Batched reads: prevent IDB queue saturation with unlimited Promise.all
  await runBatched(metaKeys, async (key) => {
    const val = await get(key);
    memCache.set(key, val);
  });

  // 2. Pre-cache all thumbnails into memory (thumbnails are tiny).
  //    Full-res images are deliberately NOT loaded here: loading/decoding
  //    every chart up front is what blocked first paint and made scrolling
  //    janky. They are loaded lazily, on demand, by getStoredImgAsync()
  //    (only when a detail page / lightbox actually needs one).
  const thumbKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('sb_thumb_'));
  await runBatched(thumbKeys, async (key) => {
    const val = await get(key);
    if (val) {
      const url = val instanceof Blob ? URL.createObjectURL(val) : val;
      memCache.set(key, url);
    }
  });

  const total = thumbKeys.length;
  if (onProgress && total > 0) onProgress(total, total);

  // 3. Backfill missing thumbnails IN THE BACKGROUND, after first paint.
  //    Previously this was fully awaited (canvas-decode of every full-res
  //    image, batched, before the UI rendered) — the main cause of the
  //    slow "Preparing images..." startup. Until a thumb exists the grid
  //    falls back to the cached full image (getStoredThumb does that), so
  //    nothing is visually missing; the thumb just swaps in when ready.
  //    requestIdleCallback keeps this off the critical path; setTimeout is
  //    the fallback (Electron / older Chromium).
  const imgKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('sb_img_'));
  const imgKeysWithoutThumb = imgKeys.filter(key => !memCache.has(key.replace('sb_img_', 'sb_thumb_')));
  if (imgKeysWithoutThumb.length > 0) {
    const backfill = () => {
      runBatched(imgKeysWithoutThumb, async (key) => {
        const tKey = key.replace('sb_img_', 'sb_thumb_');
        const val = await get(key);
        if (!val) return;
        const url = val instanceof Blob ? URL.createObjectURL(val) : val;
        // Only use the full image as a thumb if no thumb arrived meanwhile.
        if (!memCache.has(tKey)) memCache.set(key, url);
        if (!memCache.has(tKey)) memCache.set(tKey, url);
        try {
          const tBlob = await createThumbnail(val);
          if (tBlob && tBlob instanceof Blob) {
            const thumbUrl = URL.createObjectURL(tBlob);
            const prevThumb = memCache.get(tKey);
            memCache.set(tKey, thumbUrl);
            if (prevThumb && prevThumb !== url) revokeBlobUrl(prevThumb);
            set(tKey, tBlob).catch(() => {});
          }
        } catch {
          // thumbnail generation failed, full image stays as fallback
        }
        // Medium tier (1600px, detail page) for legacy images that lack one.
        try {
          const mKey = key.replace('sb_img_', 'sb_med_');
          if (!memCache.has(mKey)) {
            const existingMed = await get(mKey);
            if (!existingMed) {
              const mBlob = await createMedium(val);
              if (mBlob && mBlob instanceof Blob && mBlob !== val) {
                memCache.set(mKey, URL.createObjectURL(mBlob));
                set(mKey, mBlob).catch(() => {});
              }
            }
          }
        } catch {
          // medium is optional; detail falls back to the full image
        }
      }, 4).catch(() => {});
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(backfill, { timeout: 2000 });
    } else {
      setTimeout(backfill, 0);
    }
  }
};

/** Synchronous, instantaneous thumbnail retrieval for the journal grid */
export const getStoredThumb = (weekId, dayName) => {
  const t = memCache.get(thumbKey(weekId, dayName));
  if (t === 'DELETED') return null;
  if (t) return t;
  const img = memCache.get(imgKey(weekId, dayName));
  if (img === 'DELETED') return null;
  return img ?? null;
};

export const getStoredImg = (weekId, dayName) => {
  const img = memCache.get(imgKey(weekId, dayName));
  if (img === 'DELETED') return null;
  return img ?? null;
};

export const getStoredImgAsync = async (weekId, dayName) => {
  const cached = memCache.get(imgKey(weekId, dayName));
  if (cached) return cached === 'DELETED' ? null : cached;

  const val = await get(imgKey(weekId, dayName));
  if (!val) return null;

  // Stored value may be a Blob (new, lossless) or a data-URL string
  // (legacy uploads, stored before the Blob migration). Convert the
  // string losslessly to a Blob — do NOT re-compress it.
  const blob = typeof val === 'string' && val.startsWith('data:image')
    ? dataURLtoBlob(val)
    : val;
  const url = blob instanceof Blob ? URL.createObjectURL(blob) : blob;
  memCache.set(imgKey(weekId, dayName), url);
  return url;
};

/** Synchronous medium retrieval (detail page inline image) */
export const getStoredMedium = (weekId, dayName) => {
  const m = memCache.get(medKey(weekId, dayName));
  if (m === 'DELETED') return null;
  return m ?? null;
};

export const getStoredMediumAsync = async (weekId, dayName) => {
  const cached = memCache.get(medKey(weekId, dayName));
  if (cached) return cached === 'DELETED' ? null : cached;
  const val = await get(medKey(weekId, dayName));
  if (!val) return null;
  const blob = typeof val === 'string' && val.startsWith('data:image') ? dataURLtoBlob(val) : val;
  const url = blob instanceof Blob ? URL.createObjectURL(blob) : blob;
  memCache.set(medKey(weekId, dayName), url);
  return url;
};

/** Generate + persist the medium tier from the full image, on demand. */
export const ensureMedium = async (weekId, dayName) => {
  const existing = await getStoredMediumAsync(weekId, dayName);
  if (existing) return existing;
  const fullUrl = await getStoredImgAsync(weekId, dayName);
  if (!fullUrl) return null;
  const fullVal = await get(imgKey(weekId, dayName));
  if (!fullVal) return null;
  const blob = typeof fullVal === 'string' && fullVal.startsWith('data:image') ? dataURLtoBlob(fullVal) : fullVal;
  try {
    const mBlob = await createMedium(blob);
    if (mBlob && mBlob instanceof Blob && mBlob !== blob) {
      const url = URL.createObjectURL(mBlob);
      memCache.set(medKey(weekId, dayName), url);
      set(medKey(weekId, dayName), mBlob).catch(() => {});
      return url;
    }
  } catch { /* fall back to full */ }
  return null;
};

export const resolveMediumAsync = async (weekId, dayName) => {
  const med = await getStoredMediumAsync(weekId, dayName);
  if (med) return med;
  return ensureMedium(weekId, dayName);
};

/** Idle-preload the neighbouring days' medium images so opening the next
 *  trade is instant. Full-res originals are NOT preloaded — the detail
 *  page loads those on demand, and decoding two full charts in the
 *  background would jank the scroll this is meant to protect. */
export const preloadNeighbourImages = (weekId, dayName) => {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const idx = days.indexOf(dayName);
  if (idx < 0) return;
  const neighbours = [days[idx - 1], days[idx + 1]].filter(Boolean);
  const run = () => {
    for (const d of neighbours) {
      resolveMediumAsync(weekId, d).catch(() => {});
    }
  };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 500);
  }
};

export const setStoredImg = async (weekId, dayName, val) => {
  const kImg = imgKey(weekId, dayName);
  const kThumb = thumbKey(weekId, dayName);
  const kMed = medKey(weekId, dayName);
  const kMeta = metaKey(weekId, dayName);

  // Delete path: null, undefined, or the 'DELETED' sentinel used by callers.
  if (val == null || val === 'DELETED') {
    revokeBlobUrl(memCache.get(kImg));
    revokeBlobUrl(memCache.get(kThumb));
    revokeBlobUrl(memCache.get(kMed));
    memCache.set(kImg, 'DELETED');
    memCache.set(kThumb, 'DELETED');
    memCache.set(kMed, 'DELETED');
    memCache.delete(kMeta);
    del(kImg);
    del(kThumb);
    del(kMed);
    del(kMeta);
    return null;
  }

  // Normalise to a Blob WITHOUT touching the pixels: a File/Blob is stored
  // as-is; a data-URL string (lossless FileReader output, or a legacy
  // stored value) is converted byte-for-byte to a Blob. No resize, no
  // re-encode — the IndexedDB value is the original file.
  const blob = val instanceof Blob
    ? val
    : (typeof val === 'string' && val.startsWith('data:image') ? dataURLtoBlob(val) : null);
  if (!blob) return null;

  revokeBlobUrl(memCache.get(kImg));
  revokeBlobUrl(memCache.get(kThumb));
  revokeBlobUrl(memCache.get(kMed));
  memCache.delete(kMed);
  const displayUrl = URL.createObjectURL(blob);
  memCache.set(kImg, displayUrl);
  memCache.set(kThumb, displayUrl); // grid placeholder until the real thumb lands

  // Save original image (Blob, lossless). Awaited — the old fire-and-forget
  // write could still be in flight when the user navigated away / reloaded,
  // silently losing the upload.
  await set(kImg, blob);

  // Record original metadata (dimensions / size / type) at upload time so
  // the UI can reserve layout and show "Original · 2560×1440 · 4.2 MB"
  // without decoding the image first. This is metadata about the original
  // only — it never changes the pixels.
  try {
    const dims = await getImageDimensions(blob);
    const meta = {
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      size: blob.size,
      type: blob.type,
      name: val instanceof File ? val.name : null,
    };
    memCache.set(kMeta, meta);
    set(kMeta, meta).catch(() => {});
  } catch {
    // metadata is best-effort; the image itself is already saved
  }

  // Create and save optimised thumbnail for the grid ONLY.
  try {
    const thumb = await createThumbnail(blob);
    if (thumb && thumb instanceof Blob) {
      const thumbUrl = URL.createObjectURL(thumb);
      memCache.set(kThumb, thumbUrl);
      await set(kThumb, thumb);
    }
  } catch (e) {
    console.warn('Could not generate thumbnail:', e);
  }

  // Medium tier (1600px, detail page) — generated in the background via
  // the worker so the upload itself returns immediately. The detail page
  // falls back to the full image until it lands, and generates it on
  // demand if it is still missing.
  createMedium(blob).then((mBlob) => {
    if (mBlob && mBlob instanceof Blob && mBlob !== blob) {
      const url = URL.createObjectURL(mBlob);
      memCache.set(kMed, url);
      set(kMed, mBlob).catch(() => {});
    }
  }).catch(() => {});

  return displayUrl;
};

export const clearStoredImg = (weekId, dayName) => {
  revokeBlobUrl(memCache.get(imgKey(weekId, dayName)));
  revokeBlobUrl(memCache.get(thumbKey(weekId, dayName)));
  revokeBlobUrl(memCache.get(medKey(weekId, dayName)));
  memCache.delete(imgKey(weekId, dayName));
  memCache.delete(thumbKey(weekId, dayName));
  memCache.delete(medKey(weekId, dayName));
  memCache.delete(metaKey(weekId, dayName));
  del(imgKey(weekId, dayName));
  del(thumbKey(weekId, dayName));
  del(medKey(weekId, dayName));
  del(metaKey(weekId, dayName));
};

export const resolveImg = (weekId, dayName, staticImg) => {
  const stored = memCache.get(imgKey(weekId, dayName));
  if (stored === 'DELETED') return null;
  return stored ?? staticImg ?? null;
};

export const resolveImgAsync = async (weekId, dayName, staticImg) => {
  // Sync first (already-cached full image), then fall back to an async
  // IndexedDB load of the FULL image — never silently return the 480px
  // thumbnail as if it were the full image. Previously this just called
  // resolveImg(), so callers that used it still got the thumbnail.
  const sync = resolveImg(weekId, dayName, null);
  if (sync) return sync;
  const asyncImg = await getStoredImgAsync(weekId, dayName);
  return asyncImg ?? staticImg ?? null;
};

export const fileToDataUrl = async (file) => {
  // LOSSLESS by design. This used to be a plain FileReader pass-through
  // (initial commit + 753f9cc). 8794d9b routed it through
  // browser-image-compression { maxSizeMB: 1, maxWidthOrHeight: 1920 },
  // which downscaled any screenshot wider than 1920px and re-encoded it
  // lossily on EVERY upload — and the compressed result was then stored,
  // so the original quality was unrecoverable. Do not re-add compression
  // here: the grid thumbnail is generated separately by createThumbnail().
  // Kept async + data-URL shaped so Quill note embeds (which store HTML
  // strings) keep working; chart uploads should pass the File/Blob
  // directly to setStoredImg() instead, which stores the Blob as-is.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/* ─── Remarks (stored as HTML string) ─── */
export const getRemarks = (weekId) => memCache.get(`sb_rem_${weekId}`);
export const setRemarks = (weekId, html) => {
  if (html != null) {
    memCache.set(`sb_rem_${weekId}`, html);
    set(`sb_rem_${weekId}`, html);
  } else {
    memCache.delete(`sb_rem_${weekId}`);
    del(`sb_rem_${weekId}`);
  }
};

/** Extract plain text from stored innerHTML (for search) */
export const getRemarksText = (weekId, fallback = '') => {
  const html = getRemarks(weekId) ?? fallback;
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

/* ─── Week label overrides ─── */
export const getWeekLabel = (weekId) => {
  const obj = memCache.get(`sb_wlbl_${weekId}`);
  return obj ?? null;
};
export const setWeekLabel = (weekId, obj) => {
  memCache.set(`sb_wlbl_${weekId}`, obj);
  set(`sb_wlbl_${weekId}`, obj);
};

/* ─── User-added extra weeks ─── */
export const getExtraWeeks = () => memCache.get('sb_extra_weeks') ?? [];
export const setExtraWeeks = (weeks) => {
  memCache.set('sb_extra_weeks', weeks);
  set('sb_extra_weeks', weeks);
};

export const deleteWeekData = (weekId) => {
  // Clear week label and remarks
  memCache.delete(`sb_wlbl_${weekId}`);
  del(`sb_wlbl_${weekId}`);
  memCache.delete(`sb_rem_${weekId}`);
  del(`sb_rem_${weekId}`);

  // Clear day notes, images, and tags
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  days.forEach(dayName => {
    memCache.delete(`sb_notes_${weekId}_${dayName}`);
    del(`sb_notes_${weekId}_${dayName}`);
    memCache.delete(imgKey(weekId, dayName));
    del(imgKey(weekId, dayName));
    memCache.delete(thumbKey(weekId, dayName));
    del(thumbKey(weekId, dayName));
    memCache.delete(medKey(weekId, dayName));
    del(medKey(weekId, dayName));
    memCache.delete(metaKey(weekId, dayName));
    del(metaKey(weekId, dayName));
    memCache.delete(`sb_tags_${weekId}_${dayName}`);
    del(`sb_tags_${weekId}_${dayName}`);
    memCache.delete(`sb_date_${weekId}_${dayName}`);
    del(`sb_date_${weekId}_${dayName}`);
  });
};

/* ─── Cell day notes (stored as HTML string) ─── */
export const getNotes = (weekId, dayName) => memCache.get(`sb_notes_${weekId}_${dayName}`);
export const setNotes = (weekId, dayName, html) => {
  if (html) {
    memCache.set(`sb_notes_${weekId}_${dayName}`, html);
    set(`sb_notes_${weekId}_${dayName}`, html);
  } else {
    memCache.delete(`sb_notes_${weekId}_${dayName}`);
    del(`sb_notes_${weekId}_${dayName}`);
  }
};

/** Plain text extracted from stored notes HTML (for search). */
export const getNotesText = (weekId, dayName, fallback = '') => {
  const html = getNotes(weekId, dayName) ?? fallback;
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

/* ─── Trade Tags (Array of strings) ─── */
export const getTags = (weekId, dayName) => memCache.get(`sb_tags_${weekId}_${dayName}`) ?? [];
export const setTags = (weekId, dayName, tags) => {
  if (tags && tags.length > 0) {
    memCache.set(`sb_tags_${weekId}_${dayName}`, tags);
    set(`sb_tags_${weekId}_${dayName}`, tags);
  } else {
    memCache.delete(`sb_tags_${weekId}_${dayName}`);
    del(`sb_tags_${weekId}_${dayName}`);
  }
};

/* ─── Trade Dates (String: yyyy-mm-dd) ─── */
export const getTradeDate = (weekId, dayName) => memCache.get(`sb_date_${weekId}_${dayName}`) ?? '';
export const setTradeDate = (weekId, dayName, dateStr) => {
  if (dateStr) {
    memCache.set(`sb_date_${weekId}_${dayName}`, dateStr);
    set(`sb_date_${weekId}_${dayName}`, dateStr);
  } else {
    memCache.delete(`sb_date_${weekId}_${dayName}`);
    del(`sb_date_${weekId}_${dayName}`);
  }
};

/* ─── Export / Import helpers ─── */

/**
 * Read a Blob into a data-URL using FileReader.
 * LOSSLESS — does NOT re-compress. Replaces the old fileToDataUrl() call
 * in exports, which was running browser-image-compression on every image
 * and silently degrading quality with each export/import cycle.
 */
const blobToDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

// dataURLtoBlob() is defined (hoisted) near the top of this file so
// getStoredImgAsync / setStoredImg can use it. It replaces the previous
// fetch(dataURL) anti-pattern, which routed every image through the full
// browser network stack (slow, failure-prone, and unable to handle large
// payloads without freezing).

export const exportDatabase = async (onProgress) => {
  const allEntries = await entries();

  // Exclude thumbnails — they are derived from full images and will be
  // regenerated automatically by initStorage after import.
  const exportable = allEntries.filter(([k]) => !String(k).startsWith('sb_thumb_') && !String(k).startsWith('sb_med_'));

  const blobEntries = exportable.filter(([, v]) => v instanceof Blob);
  const total = blobEntries.length;
  let done = 0;
  if (onProgress && total > 0) onProgress(0, total);

  // Collect results (order preserved by index to avoid race-condition push issues)
  const result = new Array(exportable.length);

  await runBatched(exportable, async ([k, v], _i) => {
    const idx = exportable.indexOf(exportable.find(([ek]) => ek === k));
    if (v instanceof Blob) {
      // Lossless read — no re-compression whatsoever
      result[idx] = [k, await blobToDataURL(v)];
      done++;
      if (onProgress && total > 0) onProgress(done, total);
    } else {
      result[idx] = [k, v];
    }
  }, 4); // 4 concurrent FileReader ops keeps memory manageable

  // Serialize in yielding chunks so the main thread stays alive
  // (a single JSON.stringify on 100 MB of base64 can freeze for 3+ seconds)
  let json = '[';
  const finalResult = result.filter(Boolean); // remove any gaps
  for (let i = 0; i < finalResult.length; i++) {
    if (i > 0) json += ',';
    json += JSON.stringify(finalResult[i]);
    // Yield every 20 items so the browser can paint progress updates
    if ((i + 1) % 20 === 0) await new Promise(r => setTimeout(r, 0));
  }
  json += ']';
  return json;
};


export const exportCSVDatabase = async () => {
  const allEntries = await entries();
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Type,Key,Value\n";
  
  for (const [key, value] of allEntries) {
    if (key.startsWith('sb_img_')) continue; // Skip images for CSV
    const type = key.startsWith('sb_notes_') ? 'Note' : 
                 key.startsWith('sb_rem_') ? 'Remark' : 
                 key.startsWith('sb_date_') ? 'TradeDate' : 
                 key === 'sb_extra_weeks' ? 'ExtraWeeks' : 
                 key.startsWith('sb_wlbl_') ? 'WeekLabel' : 'Other';
                 
    let strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Escape quotes
    strValue = strValue.replace(/"/g, '""');
    csvContent += `"${type}","${key}","${strValue}"\n`;
  }
  
  return encodeURI(csvContent);
};

export const importDatabase = async (jsonString, onProgress) => {
  // JSON.parse is synchronous. The caller should show a loading message
  // before invoking this so the UI doesn't appear frozen.
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid backup: could not parse JSON. File may be corrupted.');
  }
  if (!Array.isArray(data)) throw new Error('Invalid backup: expected a JSON array');

  // Validate before clearing — protect against importing a wrong/empty file
  const sbKeys = data.filter(([k]) => typeof k === 'string' && String(k).startsWith('sb_'));
  if (sbKeys.length === 0 && data.length > 0) {
    throw new Error('Invalid backup: file contains no Snowball data (sb_ keys).');
  }

  await clear();

  // Skip thumbnails from the backup — initStorage will regenerate them
  // from the full-resolution images after import.
  const imageEntries = data.filter(([k, v]) =>
    typeof v === 'string' && v.startsWith('data:image') && !String(k).startsWith('sb_thumb_')
  );
  const otherEntries = data.filter(([, v]) =>
    !(typeof v === 'string' && v.startsWith('data:image'))
  );

  // Write metadata at high concurrency (strings/objects, very fast)
  await runBatched(otherEntries, ([k, v]) => set(k, v), 16);

  // Write images: dataURLtoBlob is instant (atob + TypedArray),
  // vastly faster than the previous fetch(dataURL) approach.
  const total = imageEntries.length;
  let done = 0;
  if (onProgress && total > 0) onProgress(0, total);

  await runBatched(imageEntries, async ([k, v]) => {
    const blob = dataURLtoBlob(v);
    await set(k, blob);
    done++;
    if (onProgress && total > 0) onProgress(done, total);
  }, 4); // 4 concurrent IDB writes for large blobs

  // Re-initialize: warms the memory cache and regenerates any missing thumbnails
  await initStorage(onProgress);
};

export const formatDatabase = async () => {
  await clear();
  memCache.clear();
  await initStorage();
};
