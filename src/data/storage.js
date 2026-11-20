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

/* ─── Datasets: one journal per (index, year) ───
 * Every journal entry (images, notes, remarks, extra weeks, …) lives
 * under a per-dataset prefix, so Nifty 50 / 2026 and Bank Nifty / 2026
 * never see each other's data and can be backed up separately.
 *   sb_ds_<dataset-id>__img_<weekId>_<day>   (dataset data)
 *   sb_datasets                               (registry, global)
 *   sb_current_dataset                        (selected id, global)
 * The current database is indexed to Nifty 50 / 2026: on first run
 * with datasets, any legacy flat keys (sb_img_*, sb_extra_weeks, …)
 * are moved under that dataset (see initStorage migration below).
 */
export const DEFAULT_DATASET = { id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 };
const slugifyIndex = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'index';
export const datasetIdFor = (index, year) => `${slugifyIndex(index)}_${year}`;
export const datasetLabel = (ds) => `${ds.index} · ${ds.year}`;

let currentDatasetId = DEFAULT_DATASET.id;
export const getCurrentDatasetId = () => currentDatasetId;
export const getDatasets = () => memCache.get('sb_datasets') ?? [];
export const getCurrentDataset = () =>
  getDatasets().find((d) => d.id === currentDatasetId) ?? DEFAULT_DATASET;
/** Prefix every per-dataset key with the selected dataset. */
const dsPrefix = (id = currentDatasetId) => `sb_ds_${id}__`;

/**
 * Create a dataset for an (index, year) combination. Returns the existing
 * one when that combination already exists — a dataset is never duplicated.
 * The new dataset starts empty; weeks are added with the + button as usual.
 */
export const createDataset = async (index, year) => {
  const cleanIndex = String(index).trim();
  const cleanYear = Number(year);
  if (!cleanIndex) throw new Error('Index name is required.');
  if (!Number.isInteger(cleanYear) || cleanYear < 2000 || cleanYear > 2100) {
    throw new Error('Year must be between 2000 and 2100.');
  }
  const id = datasetIdFor(cleanIndex, cleanYear);
  const datasets = getDatasets();
  const existing = datasets.find((d) => d.id === id);
  if (existing) return existing;
  const ds = { id, index: cleanIndex, year: cleanYear };
  const next = [...datasets, ds];
  memCache.set('sb_datasets', next);
  await set('sb_datasets', next);
  return ds;
};

/**
 * Switch the journal to another dataset: persists the choice, then reloads
 * the memory cache from IndexedDB for that dataset only. The caller must
 * re-read getExtraWeeks() / getDatasets() afterwards (React state).
 */
export const switchDataset = async (id) => {
  if (!getDatasets().some((d) => d.id === id)) {
    throw new Error(`Unknown dataset: ${id}`);
  }
  currentDatasetId = id;
  await set('sb_current_dataset', id);
  await initStorage();
  return getCurrentDataset();
};

/* ─── Cell chart images (Two-Tier Engine: Full-Res + Ultra-Fast Thumbnail) ─── */
const imgKey = (weekId, dayName) => `${dsPrefix()}img_${weekId}_${dayName}`;
const thumbKey = (weekId, dayName) => `${dsPrefix()}thumb_${weekId}_${dayName}`;
const medKey = (weekId, dayName) => `${dsPrefix()}med_${weekId}_${dayName}`;
const metaKey = (weekId, dayName) => `${dsPrefix()}meta_${weekId}_${dayName}`;
const remKey = (weekId) => `${dsPrefix()}rem_${weekId}`;
const wlblKey = (weekId) => `${dsPrefix()}wlbl_${weekId}`;
const notesKey = (weekId, dayName) => `${dsPrefix()}notes_${weekId}_${dayName}`;
const tagsKey = (weekId, dayName) => `${dsPrefix()}tags_${weekId}_${dayName}`;
const dateKey = (weekId, dayName) => `${dsPrefix()}date_${weekId}_${dayName}`;
const extraWeeksKey = () => `${dsPrefix()}extra_weeks`;
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
  // 0. Dataset registry (global keys, never namespaced). First run with
  //    datasets: index the existing database to Nifty 50 / 2026 by moving
  //    every legacy flat key (sb_img_*, sb_extra_weeks, …) under that
  //    dataset's prefix. A fresh install just creates the default dataset.
  const savedDatasets = await get('sb_datasets');
  const savedCurrent = await get('sb_current_dataset');
  if (!savedDatasets) {
    const preKeys = await keys();
    const legacyKeys = preKeys.filter(k =>
      typeof k === 'string' && k.startsWith('sb_') && !k.startsWith('sb_ds_') &&
      k !== 'sb_datasets' && k !== 'sb_current_dataset');
    const datasets = [DEFAULT_DATASET];
    if (legacyKeys.length > 0) {
      const target = dsPrefix(DEFAULT_DATASET.id);
      for (const k of legacyKeys) {
        const v = await get(k);
        await set(`${target}${k.slice(3)}`, v);
        await del(k);
      }
    }
    await set('sb_datasets', datasets);
    await set('sb_current_dataset', DEFAULT_DATASET.id);
  }
  const datasets = (await get('sb_datasets')) ?? [DEFAULT_DATASET];
  currentDatasetId = savedCurrent && datasets.some(d => d.id === savedCurrent)
    ? savedCurrent
    : datasets[0].id;
  await set('sb_current_dataset', currentDatasetId);

  const allKeys = await keys();
  // Revoke the previous dataset's blob URLs before dropping the cache,
  // otherwise every index/year switch leaks thumbnail URLs.
  for (const url of memCache.values()) revokeBlobUrl(url);
  memCache.clear();
  memCache.set('sb_datasets', datasets);

  // 1. Load metadata, notes, tags, remarks, and extra weeks — current
  //    dataset only. Other datasets' keys stay in IndexedDB untouched.
  const p = dsPrefix();
  const metaKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(p) && !k.startsWith(`${p}img_`) && !k.startsWith(`${p}thumb_`) && !k.startsWith(`${p}med_`));
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
  const thumbKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(`${p}thumb_`));
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
  const imgKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(`${p}img_`));
  const imgKeysWithoutThumb = imgKeys.filter(key => !memCache.has(key.replace(`${p}img_`, `${p}thumb_`)));
  if (imgKeysWithoutThumb.length > 0) {
    const backfill = () => {
      runBatched(imgKeysWithoutThumb, async (key) => {
        const tKey = key.replace(`${p}img_`, `${p}thumb_`);
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
          const mKey = key.replace(`${p}img_`, `${p}med_`);
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
export const getRemarks = (weekId) => memCache.get(remKey(weekId));
export const setRemarks = (weekId, html) => {
  if (html != null) {
    memCache.set(remKey(weekId), html);
    set(remKey(weekId), html);
  } else {
    memCache.delete(remKey(weekId));
    del(remKey(weekId));
  }
};

/** Extract plain text from stored innerHTML (for search) */
export const getRemarksText = (weekId, fallback = '') => {
  const html = getRemarks(weekId) ?? fallback;
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

/** First N non-empty lines of the remarks, for the front-page cell.
    Quill stores one <p> per line, so block ends and <br> are the line
    breaks; the rest of the markup is stripped. Blank lines don't count. */
export const getRemarksPreview = (weekId, fallback = '', maxLines = 5) => {
  const html = getRemarks(weekId) ?? fallback;
  if (!html) return '';
  const lines = html
    .replace(/<(p|div|li|h[1-6]|blockquote)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return lines.join('\n');
};

/* ─── Week label overrides ─── */
export const getWeekLabel = (weekId) => {
  const obj = memCache.get(wlblKey(weekId));
  return obj ?? null;
};
export const setWeekLabel = (weekId, obj) => {
  memCache.set(wlblKey(weekId), obj);
  set(wlblKey(weekId), obj);
};

/* ─── User-added extra weeks ─── */
export const getExtraWeeks = () => memCache.get(extraWeeksKey()) ?? [];
export const setExtraWeeks = (weeks) => {
  memCache.set(extraWeeksKey(), weeks);
  set(extraWeeksKey(), weeks);
};

export const deleteWeekData = (weekId) => {
  // Clear week label and remarks
  memCache.delete(wlblKey(weekId));
  del(wlblKey(weekId));
  memCache.delete(remKey(weekId));
  del(remKey(weekId));

  // Clear day notes, images, and tags
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  days.forEach(dayName => {
    memCache.delete(notesKey(weekId, dayName));
    del(notesKey(weekId, dayName));
    memCache.delete(imgKey(weekId, dayName));
    del(imgKey(weekId, dayName));
    memCache.delete(thumbKey(weekId, dayName));
    del(thumbKey(weekId, dayName));
    memCache.delete(medKey(weekId, dayName));
    del(medKey(weekId, dayName));
    memCache.delete(metaKey(weekId, dayName));
    del(metaKey(weekId, dayName));
    memCache.delete(tagsKey(weekId, dayName));
    del(tagsKey(weekId, dayName));
    memCache.delete(annKey(weekId, dayName));
    del(annKey(weekId, dayName));
    memCache.delete(dateKey(weekId, dayName));
    del(dateKey(weekId, dayName));
  });
};

/* ─── Cell day notes (stored as HTML string) ─── */
export const getNotes = (weekId, dayName) => memCache.get(notesKey(weekId, dayName));
export const setNotes = (weekId, dayName, html) => {
  if (html) {
    memCache.set(notesKey(weekId, dayName), html);
    set(notesKey(weekId, dayName), html);
  } else {
    memCache.delete(notesKey(weekId, dayName));
    del(notesKey(weekId, dayName));
  }
};

/** Plain text extracted from stored notes HTML (for search). */
export const getNotesText = (weekId, dayName, fallback = '') => {
  const html = getNotes(weekId, dayName) ?? fallback;
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

/* ─── Trade Tags (Array of strings) ─── */
export const getTags = (weekId, dayName) => memCache.get(tagsKey(weekId, dayName)) ?? [];
export const setTags = (weekId, dayName, tags) => {
  if (tags && tags.length > 0) {
    memCache.set(tagsKey(weekId, dayName), tags);
    set(tagsKey(weekId, dayName), tags);
  } else {
    memCache.delete(tagsKey(weekId, dayName));
    del(tagsKey(weekId, dayName));
  }
};

/* ─── Chart Annotations (lightbox, per day) ───
   One JSON array per day: [{ id, type, x, y, text? }] with x/y in % of
   the displayed picture. Types: 'line' | 'arrow-green-up' |
   'arrow-green-down' | 'arrow-red-up' | 'arrow-red-down' |
   'arrow-yellow' | 'comment'. Stored like tags (memCache + IndexedDB),
   so backup/export picks the key up automatically (sb_ds_ prefix). */
const annKey = (weekId, dayName) => `${dsPrefix()}ann_${weekId}_${dayName}`;
export const getAnnotations = (weekId, dayName) => memCache.get(annKey(weekId, dayName)) ?? [];
export const setAnnotations = (weekId, dayName, anns) => {
  if (anns && anns.length > 0) {
    memCache.set(annKey(weekId, dayName), anns);
    set(annKey(weekId, dayName), anns);
  } else {
    memCache.delete(annKey(weekId, dayName));
    del(annKey(weekId, dayName));
  }
};

/* ─── Trade Dates (String: yyyy-mm-dd) ─── */
export const getTradeDate = (weekId, dayName) => memCache.get(dateKey(weekId, dayName)) ?? '';
export const setTradeDate = (weekId, dayName, dateStr) => {
  if (dateStr) {
    memCache.set(dateKey(weekId, dayName), dateStr);
    set(dateKey(weekId, dayName), dateStr);
  } else {
    memCache.delete(dateKey(weekId, dayName));
    del(dateKey(weekId, dayName));
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
  // ONE clean backup of the whole database: every dataset (all indexes and
  // years), plus the registry and the current selection, so a single file
  // restores everything. Entries are sorted by key, so the file is
  // deterministic and grouped by dataset.
  // Exclude thumbnails and mediums — they are derived from full images and
  // will be regenerated automatically by initStorage after import.
  const allEntries = await entries();
  const isDerived = (k) => k.includes('__thumb_') || k.includes('__med_');
  const exportable = allEntries
    .filter(([k]) =>
      typeof k === 'string' &&
      (k === 'sb_datasets' || k === 'sb_current_dataset' || k.startsWith('sb_ds_')) &&
      !isDerived(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const blobEntries = exportable.filter(([, v]) => v instanceof Blob);
  const total = blobEntries.length;
  let done = 0;
  if (onProgress && total > 0) onProgress(0, total);

  // Collect results (order preserved by index to avoid race-condition push issues)
  const result = new Array(exportable.length);
  const idxByKey = new Map(exportable.map(([k], i) => [k, i]));

  await runBatched(exportable, async ([k, v], _i) => {
    const idx = idxByKey.get(k);
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
  const p = dsPrefix();
  const allEntries = await entries();
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Type,Key,Value\n";

  for (const [key, value] of allEntries) {
    if (typeof key !== 'string' || !key.startsWith(p)) continue; // current dataset only
    if (key.startsWith(`${p}img_`)) continue; // Skip images for CSV
    const type = key.startsWith(`${p}notes_`) ? 'Note' :
                 key.startsWith(`${p}rem_`) ? 'Remark' :
                 key.startsWith(`${p}date_`) ? 'TradeDate' :
                 key === `${p}extra_weeks` ? 'ExtraWeeks' :
                 key.startsWith(`${p}wlbl_`) ? 'WeekLabel' : 'Other';
                 
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

  // Three backup shapes, all restored losslessly (images are stored as
  // data-URLs and converted back to Blobs byte-for-byte — never re-encoded):
  //  1. Whole-database backup (current format): carries sb_datasets +
  //     sb_current_dataset plus every dataset's keys. Restores everything.
  //  2. Single-dataset backup (v4 marker ['sb_dataset', {id,index,year}]):
  //     restores into that dataset only, other datasets are untouched.
  //  3. Legacy flat backup (pre-datasets): keys without a dataset prefix
  //     are migrated into Nifty 50 / 2026, replacing the whole database
  //     exactly as the old whole-database backups did.
  const marker = data.find(([k]) => k === 'sb_dataset');
  const hasRegistry = data.some(([k]) => k === 'sb_datasets');

  let normalised = [];
  let wipeAll = false;
  let wipePrefix = null;

  if (hasRegistry) {
    wipeAll = true;
    for (const [k, v] of data) {
      if (k === 'sb_dataset' || typeof k !== 'string' || !k.startsWith('sb_')) continue;
      if (k === 'sb_datasets' || k === 'sb_current_dataset' || k.startsWith('sb_ds_')) {
        normalised.push([k, v]);
      } else {
        normalised.push([`${dsPrefix(DEFAULT_DATASET.id)}${k.slice(3)}`, v]);
      }
    }
  } else {
    const target = marker?.[1]?.id
      ? { id: marker[1].id, index: marker[1].index, year: marker[1].year }
      : getCurrentDataset();
    const targetPrefix = dsPrefix(target.id);
    wipePrefix = targetPrefix;
    for (const [k, v] of data) {
      if (k === 'sb_dataset' || typeof k !== 'string' || !k.startsWith('sb_')) continue;
      if (k.startsWith('sb_ds_')) {
        const entryDs = k.slice(6).split('__')[0];
        if (entryDs !== target.id) {
          throw new Error('Invalid backup: it mixes data from multiple index/year datasets.');
        }
        normalised.push([k, v]);
      } else {
        normalised.push([`${targetPrefix}${k.slice(3)}`, v]); // legacy flat key
      }
    }
    // Register the target dataset if it is new, and select it — after import
    // the app reloads into the restored dataset.
    const datasets = getDatasets();
    if (!datasets.some((d) => d.id === target.id)) {
      normalised.push(['sb_datasets', [...datasets, target]]);
    }
    normalised.push(['sb_current_dataset', target.id]);
    currentDatasetId = target.id;
  }

  // Wipe what the backup replaces: everything for a whole-database backup,
  // only the target dataset for a single-dataset / legacy backup.
  if (wipeAll) {
    await clear();
  } else if (wipePrefix) {
    const existingKeys = await keys();
    await runBatched(
      existingKeys.filter(k => typeof k === 'string' && k.startsWith(wipePrefix)),
      (k) => del(k), 16,
    );
  }

  // Skip thumbnails from the backup — initStorage will regenerate them
  // from the full-resolution images after import.
  const imageEntries = normalised.filter(([k, v]) =>
    typeof v === 'string' && v.startsWith('data:image') && !String(k).includes('__thumb_')
  );
  const otherEntries = normalised.filter(([, v]) =>
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
  // Wipe ONLY the current (index, year) dataset — other datasets are kept.
  const p = dsPrefix();
  const allKeys = await keys();
  await runBatched(
    allKeys.filter(k => typeof k === 'string' && k.startsWith(p)),
    (k) => del(k), 16,
  );
  memCache.clear();
  await initStorage();
};
