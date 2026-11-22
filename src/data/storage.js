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

/* ─── Lazy thumbnail object URLs (perf step 7) ───
 * memCache holds thumbnail BLOBS; object URLs are created lazily by
 * getStoredThumb (one per visible row) and kept in thumbUrlCache.
 * When a row scrolls out of view Virtuoso unmounts it and the DayCell
 * cleanup revokes that row's URL (revokeThumbUrl) — off-screen thumbs
 * stop occupying blob-URL slots. The blob stays cached, so the URL is
 * re-created cheaply on the next mount. Dataset switches and week
 * deletes revoke every cached URL (revokeAllThumbUrls / deleteWeekData).
 * The URL cache is separate from memCache on purpose: memCache is the
 * canonical data (blobs), thumbUrlCache is purely a view-layer cache. */
const thumbUrlCache = new Map();
/** Revoke the cached object URL for one cell's thumbnail, if any. */
export const revokeThumbUrl = (weekId, dayName) => {
  revokeThumbUrlByKey(thumbKey(weekId, dayName));
};
const revokeThumbUrlByKey = (key) => {
  const url = thumbUrlCache.get(key);
  if (url) {
    revokeBlobUrl(url);
    thumbUrlCache.delete(key);
  }
};
/** Revoke every cached thumbnail URL (dataset switch / cache clear). */
const revokeAllThumbUrls = () => {
  for (const url of thumbUrlCache.values()) revokeBlobUrl(url);
  thumbUrlCache.clear();
};

/* ─── Thumbnail streaming (perf step 6) ───
 * initStorage resolves after the metadata phase; thumbnails load
 * afterwards in the background and subscribers are notified per batch
 * so the grid can paint them in as they arrive. `thumbGeneration` is
 * bumped on every initStorage — a thumbnail load (or backfill) from an
 * older generation aborts without writing, so a dataset switch can
 * never resurrect the previous dataset's thumbnails in the cache. */
const thumbListeners = new Set();
export const subscribeThumbs = (cb) => {
  thumbListeners.add(cb);
  return () => { thumbListeners.delete(cb); };
};
const notifyThumbs = (weekIds) => {
  for (const cb of thumbListeners) {
    try { cb(weekIds); } catch { /* a listener must never break the load */ }
  }
};

// Inverse of imgKey/thumbKey/medKey: the day name (Monday..Friday) is
// the last `_`-segment of the key, and week ids never contain `_`.
const weekIdFromImageKey = (key, tier) => {
  const rest = key.slice(`${dsPrefix()}${tier}_`.length);
  return rest.slice(0, rest.lastIndexOf('_'));
};
let thumbGeneration = 0;

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
  // Flush pending week-document saves BEFORE switching: they read the
  // current dataset's memCache, and after the switch that cache holds
  // the new dataset — an unflushed save would write an empty document
  // over the old dataset's data (or delete its document outright).
  await flushAllWeekDocs();
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

/* ─── Per-week metadata documents (perf step 4) ───
 * Startup used to read every small metadata entry one by one (a
 * separate IndexedDB request for each week label, each week's remarks,
 * each day's notes, tags, image meta and trade date — hundreds of
 * requests, batched 8 at a time). Now one dataset-week's small metadata
 * lives in ONE document under a single key:
 *   sb_ds_<id>__wk_<weekId> = { v: 1, label?, remarks?,
 *     days: { Monday: { notes?, tags?, meta?, date? }, … } }
 * Images (img_/thumb_/med_) stay per-key Blobs, annotations (ann_) stay
 * per-key arrays, and extra_weeks stays its own key — this only covers
 * the small text metadata that used to be hundreds of keys.
 *
 * The UI never sees the documents: on load each document is fanned out
 * into the SAME memCache entries the old keys used (wlbl_/rem_/notes_/
 * tags_/meta_/date_), so every getter below is unchanged and no screen
 * changes. Writers update memCache synchronously (as before) and enqueue
 * a document save; the save re-reads memCache when it runs, so a later
 * edit can never be lost behind an earlier queued write.
 */
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const wkKey = (weekId) => `${dsPrefix()}wk_${weekId}`;

/** Fan a loaded week document out into the per-key memCache entries. */
const fanOutWeekDoc = (weekId, doc) => {
  if (!doc || typeof doc !== 'object') return;
  if (doc.label != null) memCache.set(wlblKey(weekId), doc.label);
  if (doc.remarks != null) memCache.set(remKey(weekId), doc.remarks);
  const days = doc.days && typeof doc.days === 'object' ? doc.days : {};
  for (const [day, d] of Object.entries(days)) {
    if (!d || typeof d !== 'object') continue;
    if (d.notes != null) memCache.set(notesKey(weekId, day), d.notes);
    if (d.tags != null) memCache.set(tagsKey(weekId, day), d.tags);
    if (d.meta != null) memCache.set(metaKey(weekId, day), d.meta);
    if (d.date != null) memCache.set(dateKey(weekId, day), d.date);
  }
};

/** Build a week's document from the current memCache entries.
 *  Returns null when the week holds no metadata (no document stored). */
const buildWeekDoc = (weekId) => {
  const doc = { v: 1 };
  const label = memCache.get(wlblKey(weekId));
  if (label != null) doc.label = label;
  const remarks = memCache.get(remKey(weekId));
  if (remarks != null) doc.remarks = remarks;
  const days = {};
  for (const day of DAYS) {
    const d = {};
    const notes = memCache.get(notesKey(weekId, day));
    if (notes != null) d.notes = notes;
    const tags = memCache.get(tagsKey(weekId, day));
    if (tags != null) d.tags = tags;
    const meta = memCache.get(metaKey(weekId, day));
    if (meta != null) d.meta = meta;
    const date = memCache.get(dateKey(weekId, day));
    if (date != null) d.date = date;
    if (Object.keys(d).length > 0) days[day] = d;
  }
  if (Object.keys(days).length > 0) doc.days = days;
  if (doc.label == null && doc.remarks == null && !doc.days) return null;
  return doc;
};

// Per-week save chains: at most one queued write per week, each write
// re-reading memCache when it runs, so overlapping edits can never
// overwrite each other (the classic read-modify-write lost update).
// A failed write must not break the chain for later saves.
const weekSaveState = new Map(); // weekId -> { queued, chain }
const weekSaveDead = new Set(); // weekIds deleted while a save was queued
const writeWeekDoc = async (weekId) => {
  if (weekSaveDead.has(weekId)) return;
  const doc = buildWeekDoc(weekId);
  if (weekSaveDead.has(weekId)) return;
  if (doc) await set(wkKey(weekId), doc);
  else await del(wkKey(weekId));
};
const scheduleWeekSave = (weekId) => {
  if (weekSaveDead.has(weekId)) return;
  bumpSearchDataVersion(); // searchable text may have changed (round-2 improvement 2)
  let st = weekSaveState.get(weekId);
  if (!st) {
    st = { queued: false, chain: Promise.resolve() };
    weekSaveState.set(weekId, st);
  }
  if (st.queued) return; // one already queued — it reads the latest state
  st.queued = true;
  st.chain = st.chain.then(async () => {
    st.queued = false;
    await writeWeekDoc(weekId);
  }).catch((e) => console.warn('week-doc save failed:', e));
};
/** Await any pending document save for one week. */
export const flushWeekDoc = async (weekId) => {
  const st = weekSaveState.get(weekId);
  if (st) await st.chain;
};
/** Await every pending document save (export, wipe, switch, import). */
export const flushAllWeekDocs = async () => {
  await Promise.all([...weekSaveState.values()].map((st) => st.chain));
};

/** Parse an old-format per-key metadata key into { weekId, field, day }. */
const parseOldMetaKey = (key) => {
  const p = dsPrefix();
  if (!key.startsWith(p)) return null;
  const rest = key.slice(p.length);
  let m = rest.match(/^(rem|wlbl)_(.+)$/);
  if (m) return { weekId: m[2], field: m[1], day: null };
  m = rest.match(/^(notes|tags|meta|date)_(.+)_(Monday|Tuesday|Wednesday|Thursday|Friday)$/);
  if (m) return { weekId: m[2], field: m[1], day: m[3] };
  return null;
};

/**
 * Migrate the current dataset's old per-key metadata into per-week
 * documents. Write-then-verify-then-delete, per week, so an interrupted
 * run (crash, closed tab) is safe to re-run: a week whose document did
 * not verify keeps its old keys, and the load phase fans those out
 * directly; a week with both a document and old keys merges with the
 * document winning. Runs lazily, for the current dataset only — other
 * datasets migrate when they are opened, and old-format backups migrate
 * on import (importDatabase re-runs initStorage).
 */
/**
 * Migrate old per-key metadata into per-week documents. Takes the key
 * list initStorage already fetched and returns the ADJUSTED list — old
 * keys that were successfully migrated (written + verified + deleted)
 * removed, the week documents written for them added — so initStorage's
 * metadata phase reads exactly the post-migration state without a
 * second full key scan (round-2 improvement 3: the migration used to
 * run its own `keys()` scan on every startup, even though migration
 * finished long ago and there is usually nothing to migrate). A week
 * whose verify fails keeps its old keys, and they stay in the returned
 * list, so the plain-keys pass still loads them.
 */
const migrateWeekDocs = async (allKeys) => {
  const p = dsPrefix();
  const oldKeys = allKeys.filter((k) => {
    if (typeof k !== 'string' || !k.startsWith(p)) return false;
    if (k.startsWith(`${p}wk_`)) return false;
    return parseOldMetaKey(k) !== null;
  });
  if (oldKeys.length === 0) return allKeys;
  const deleted = new Set();
  const added = new Set();
  const byWeek = new Map();
  for (const k of oldKeys) {
    const parsed = parseOldMetaKey(k);
    if (!parsed) continue;
    const list = byWeek.get(parsed.weekId) ?? [];
    list.push([k, parsed]);
    byWeek.set(parsed.weekId, list);
  }
  for (const [weekId, fields] of byWeek) {
    try {
      const existing = await get(wkKey(weekId));
      const doc = existing && typeof existing === 'object' ? { ...existing } : { v: 1 };
      if (doc.days == null) doc.days = {};
      for (const [k, parsed] of fields) {
        const val = await get(k);
        if (val == null) continue;
        if (parsed.field === 'rem') { if (doc.remarks == null) doc.remarks = val; }
        else if (parsed.field === 'wlbl') { if (doc.label == null) doc.label = val; }
        else {
          const d = doc.days[parsed.day] ?? {};
          if (d[parsed.field] == null) d[parsed.field] = val;
          doc.days[parsed.day] = d;
        }
      }
      if (Object.keys(doc.days).length === 0) delete doc.days;
      if (doc.label == null && doc.remarks == null && !doc.days) continue;
      await set(wkKey(weekId), doc);
      const back = await get(wkKey(weekId));
      if (!back || JSON.stringify(back) !== JSON.stringify(doc)) {
        console.warn(`week-doc migration: verify failed for ${weekId}, keeping old keys`);
        continue;
      }
      await runBatched(fields.map(([k]) => k), (k) => del(k), 16);
      for (const [k] of fields) deleted.add(k);
      added.add(wkKey(weekId));
    } catch (e) {
      console.warn(`week-doc migration: ${weekId} failed, keeping old keys:`, e);
    }
  }
  return [...new Set([...allKeys.filter((k) => !deleted.has(k)), ...added])];
};

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
      const data = e.data || {};
      const entry = workerPending.get(data.id);
      if (!entry) return;
      workerPending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data);
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

/** One worker round trip, returning the worker's raw reply object.
 *  Shared by the single-derivative and derive-all calls below. */
const callWorker = (payload) => new Promise((resolve, reject) => {
  const worker = getImageWorker();
  if (!worker) { reject(new Error('no worker')); return; }
  const id = ++workerSeq;
  const timer = setTimeout(() => {
    workerPending.delete(id);
    reject(new Error('worker timeout'));
  }, 10000);
  workerPending.set(id, { resolve, reject, timer });
  try {
    worker.postMessage({ id, ...payload });
  } catch (err) {
    workerPending.delete(id);
    clearTimeout(timer);
    reject(err);
  }
});

const generateDerivativeInWorker = async (blob, maxDim, quality) => {
  const data = await callWorker({ blob, maxDim, quality });
  if (!data.blob) throw new Error('worker failed');
  return data.blob;
};

/** One worker pass, one decode: thumbnail + medium + dimensions.
 *  Returns null when the worker is unavailable or fails — the caller
 *  falls back to the old three-decode path. `blob` must be a Blob. */
const generateAllInWorker = async (blob) => {
  const data = await callWorker({ blob, deriveAll: true });
  if (!data.thumb || !data.medium) throw new Error('worker failed');
  return { thumb: data.thumb, medium: data.medium, width: data.width, height: data.height };
};

/**
 * One decode, three outputs: 480px thumbnail, 1600px medium, and the
 * original dimensions, all from a single worker pass. Returns null when
 * the worker is unavailable or fails (jsdom tests, worker error) — the
 * caller falls back to the old path (getImageDimensions + createThumbnail
 * + createMedium, three separate decodes). Same outputs as the old path:
 * 480px WebP q0.8 thumb, 1600px WebP q0.85 medium, original dims.
 */
export const createAllDerivatives = async (blob) => {
  if (!(blob instanceof Blob)) return null;
  try {
    const { thumb, medium, width, height } = await generateAllInWorker(blob);
    if (!(thumb instanceof Blob) || !(medium instanceof Blob)) return null;
    return { thumb, medium, width, height };
  } catch {
    return null;
  }
};

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

  // 0b. Migrate this dataset's old per-key metadata into per-week
  //     documents (write-then-verify-then-delete, re-runnable). Takes
  //     the key list fetched below and returns it adjusted for the
  //     migration, so the metadata phase reads the post-migration state
  //     without a second full key scan (round-2 improvement 3).
  //     Other datasets migrate lazily when they are opened.
  let allKeys = await keys();
  allKeys = await migrateWeekDocs(allKeys);

  // Revoke the previous dataset's blob URLs before dropping the cache,
  // otherwise every index/year switch leaks thumbnail URLs.
  for (const url of memCache.values()) revokeBlobUrl(url);
  revokeAllThumbUrls();
  memCache.clear();
  memCache.set('sb_datasets', datasets);

  // 1. Load metadata, notes, tags, remarks, and extra weeks — current
  //    dataset only. Other datasets' keys stay in IndexedDB untouched.
  //    Two passes: plain per-key entries first (annotations, extra
  //    weeks, and any old-format keys a failed migration left behind),
  //    then week documents fanned out — so a document always wins over
  //    stale old keys for the same week, regardless of key order.
  const p = dsPrefix();
  const metaKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(p) && !k.startsWith(`${p}img_`) && !k.startsWith(`${p}thumb_`) && !k.startsWith(`${p}med_`));
  const docKeys = metaKeys.filter((k) => k.startsWith(`${p}wk_`));
  const plainKeys = metaKeys.filter((k) => !k.startsWith(`${p}wk_`));
  // Batched reads: prevent IDB queue saturation with unlimited Promise.all
  await runBatched(plainKeys, async (key) => {
    const val = await get(key);
    memCache.set(key, val);
  });
  await runBatched(docKeys, async (key) => {
    const doc = await get(key);
    fanOutWeekDoc(key.slice(`${p}wk_`.length), doc);
  });

  // 2. Thumbnails stream in AFTER first paint (perf step 6): this
  //    function resolves now, with the metadata in place, and the
  //    thumbnail load runs in the background — the journal renders
  //    immediately and cells fill in as their thumbnails arrive
  //    (subscribers are notified per batch). Full-res images are
  //    deliberately NOT loaded here: loading/decoding every chart up
  //    front is what blocked first paint and made scrolling janky. They
  //    are loaded lazily, on demand, by getStoredImgAsync() (only when
  //    a detail page / lightbox actually needs one).
  const generation = ++thumbGeneration;
  bumpSearchDataVersion(); // metadata reloaded: import / switch / format
  loadThumbnails(onProgress, generation).catch(() => {});
};

/**
 * Load every thumbnail for the current dataset into memCache, batched,
 * notifying subscribers after each batch so the grid paints them as
 * they arrive; then backfill missing thumbs/mediums as before. Aborts
 * without writing if another initStorage superseded this load (a newer
 * generation), so a dataset switch can never resurrect the previous
 * dataset's thumbnails. `generation` is captured by initStorage; direct
 * callers (tests) omit it and use the current generation.
 */
export const loadThumbnails = async (onProgress, generation = thumbGeneration) => {
  const p = dsPrefix();
  const allKeys = await keys();
  const thumbKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(`${p}thumb_`));
  // Batched reads, notifying after EACH batch so the grid paints the
  // thumbnails that have arrived instead of waiting for all of them.
  // (runBatched has no per-batch hook, so the loop is written out.)
  for (let i = 0; i < thumbKeys.length; i += 8) {
    if (generation !== thumbGeneration) return;
    await Promise.all(thumbKeys.slice(i, i + 8).map(async (key) => {
      const val = await get(key);
      // Cache the BLOB, not an object URL (perf step 7): the URL is
      // created lazily by getStoredThumb for visible rows only.
      if (val) memCache.set(key, val);
    }));
    if (generation !== thumbGeneration) return;
    if (onProgress) onProgress(Math.min(i + 8, thumbKeys.length), thumbKeys.length);
    // Notify per week, not globally (round-2 improvement 1): only the
    // rows whose thumbs just arrived re-render.
    notifyThumbs([...new Set(thumbKeys.slice(i, i + 8).map((k) => weekIdFromImageKey(k, 'thumb')))]);
  }

  // Backfill missing thumbnails IN THE BACKGROUND, after first paint.
  // Until a thumb exists the grid falls back to the cached full image
  // (getStoredThumb does that), so nothing is visually missing; the
  // thumb just swaps in when ready. requestIdleCallback keeps this off
  // the critical path; setTimeout is the fallback (Electron / older
  // Chromium).
  const imgKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(`${p}img_`));
  const imgKeysWithoutThumb = imgKeys.filter(key => !memCache.has(key.replace(`${p}img_`, `${p}thumb_`)));
  if (imgKeysWithoutThumb.length > 0) {
    const backfill = () => {
      if (generation !== thumbGeneration) return;
      runBatched(imgKeysWithoutThumb, async (key) => {
        if (generation !== thumbGeneration) return;
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
            // Cache the blob (perf step 7); the old URL for this cell, if
            // any, is revoked so it doesn't linger after replacement.
            revokeThumbUrlByKey(tKey);
            memCache.set(tKey, tBlob);
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
        // This image's thumbnail (or its full-image fallback) is now in
        // the cache — tell the grid so the cell paints it. Without this
        // the backfilled thumbs would sit in memCache unseen until some
        // unrelated re-render. Notified per week (round-2 improvement 1).
        notifyThumbs([weekIdFromImageKey(key, 'img')]);
      }, 4).catch(() => {});
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(backfill, { timeout: 2000 });
    } else {
      setTimeout(backfill, 0);
    }
  }
};

/** Synchronous, instantaneous thumbnail retrieval for the journal grid.
 *  The thumbnail blob is cached; its object URL is created lazily on
 *  first read (perf step 7) and revoked when the row unmounts, so only
 *  visible rows hold blob URLs. Legacy string values (data URLs) are
 *  returned as-is. */
export const getStoredThumb = (weekId, dayName) => {
  const t = memCache.get(thumbKey(weekId, dayName));
  if (t === 'DELETED') return null;
  if (t instanceof Blob) {
    const k = thumbKey(weekId, dayName);
    let url = thumbUrlCache.get(k);
    if (!url) {
      url = URL.createObjectURL(t);
      thumbUrlCache.set(k, url);
    }
    return url;
  }
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
    scheduleWeekSave(weekId); // image meta lives in the week document now
    del(kImg);
    del(kThumb);
    del(kMed);
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
  // The old thumbnail URL for this cell, if one was created for a
  // visible row, is revoked here — a fresh URL is made lazily from the
  // new blob on the next getStoredThumb (perf step 7).
  revokeThumbUrl(weekId, dayName);
  revokeBlobUrl(memCache.get(kMed));
  memCache.delete(kMed);
  const displayUrl = URL.createObjectURL(blob);
  memCache.set(kImg, displayUrl);
  memCache.set(kThumb, displayUrl); // grid placeholder until the real thumb lands

  // Save original image (Blob, lossless). Awaited — the old fire-and-forget
  // write could still be in flight when the user navigated away / reloaded,
  // silently losing the upload.
  await set(kImg, blob);

  // One decode, three outputs: thumbnail + medium + dimensions from a
  // single worker pass (perf step 5). Previously this was three separate
  // decodes — getImageDimensions, then createThumbnail, then createMedium.
  // If the worker is unavailable or fails, fall back to that old path.
  let all = null;
  try {
    all = await createAllDerivatives(blob);
  } catch {
    all = null;
  }
  if (all) {
    // Original metadata (dimensions / size / type) so the UI can reserve
    // layout and show "Original · 2560×1440 · 4.2 MB" without decoding
    // the image first. Metadata about the original only — it never
    // changes the pixels.
    const meta = {
      width: all.width ?? null,
      height: all.height ?? null,
      size: blob.size,
      type: blob.type,
      name: val instanceof File ? val.name : null,
    };
    memCache.set(kMeta, meta);
    scheduleWeekSave(weekId); // image meta lives in the week document now

    // Thumbnail for the grid ONLY (awaited, as before). The blob is
    // cached; its object URL is created lazily by getStoredThumb for
    // visible rows (perf step 7).
    try {
      memCache.set(kThumb, all.thumb);
      await set(kThumb, all.thumb);
    } catch (e) {
      console.warn('Could not generate thumbnail:', e);
    }

    // Medium tier (1600px, detail page) — stored in the background, as
    // before; the detail page falls back to the full image until it
    // lands, and generates it on demand if it is still missing.
    if (all.medium !== blob) {
      const url = URL.createObjectURL(all.medium);
      memCache.set(kMed, url);
      set(kMed, all.medium).catch(() => {});
    }
  } else {
    // Fallback path — the old three-decode sequence, unchanged.
    // Record original metadata (dimensions / size / type) at upload time
    // so the UI can reserve layout and show "Original · 2560×1440 ·
    // 4.2 MB" without decoding the image first. This is metadata about
    // the original only — it never changes the pixels.
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
      scheduleWeekSave(weekId); // image meta lives in the week document now
    } catch {
      // metadata is best-effort; the image itself is already saved
    }

    // Create and save optimised thumbnail for the grid ONLY. The blob
    // is cached; its object URL is created lazily by getStoredThumb for
    // visible rows (perf step 7).
    try {
      const thumb = await createThumbnail(blob);
      if (thumb && thumb instanceof Blob) {
        memCache.set(kThumb, thumb);
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
  }

  return displayUrl;
};

export const clearStoredImg = (weekId, dayName) => {
  revokeBlobUrl(memCache.get(imgKey(weekId, dayName)));
  revokeThumbUrl(weekId, dayName);
  revokeBlobUrl(memCache.get(medKey(weekId, dayName)));
  memCache.delete(imgKey(weekId, dayName));
  memCache.delete(thumbKey(weekId, dayName));
  memCache.delete(medKey(weekId, dayName));
  memCache.delete(metaKey(weekId, dayName));
  scheduleWeekSave(weekId); // image meta lives in the week document now
  del(imgKey(weekId, dayName));
  del(thumbKey(weekId, dayName));
  del(medKey(weekId, dayName));
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
  } else {
    memCache.delete(remKey(weekId));
  }
  scheduleWeekSave(weekId); // remarks live in the week document now
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
  scheduleWeekSave(weekId); // the label lives in the week document now
};

/* ─── User-added extra weeks ─── */
export const getExtraWeeks = () => memCache.get(extraWeeksKey()) ?? [];
export const setExtraWeeks = (weeks) => {
  memCache.set(extraWeeksKey(), weeks);
  set(extraWeeksKey(), weeks);
};

export const deleteWeekData = (weekId) => {
  // Mark the week dead FIRST: a save queued by an earlier edit must not
  // resurrect the document after this delete (and any in-flight write
  // loses to this del by IndexedDB transaction order).
  weekSaveDead.add(weekId);
  bumpSearchDataVersion(); // the week's searchable text is gone (round-2 improvement 2)
  del(wkKey(weekId));
  // Clear week label and remarks (the per-key dels also cover a week
  // whose migration failed and still has old-format keys).
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
    revokeThumbUrl(weekId, dayName);
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
  } else {
    memCache.delete(notesKey(weekId, dayName));
  }
  scheduleWeekSave(weekId); // notes live in the week document now
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
  } else {
    memCache.delete(tagsKey(weekId, dayName));
  }
  scheduleWeekSave(weekId); // tags live in the week document now
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
  } else {
    memCache.delete(dateKey(weekId, dayName));
  }
  scheduleWeekSave(weekId); // the date lives in the week document now
};

/* ─── Search index (round-2 improvement 2) ─── */

// Bumped by every writer that can change searchable text, so the cached
// index below is rebuilt at most once per data change instead of once
// per search. All week-doc writers funnel through scheduleWeekSave;
// initStorage covers import / dataset switch / format, and
// deleteWeekData covers week removal.
let searchDataVersion = 0;
const bumpSearchDataVersion = () => { searchDataVersion++; };

let searchIndexCache = null; // { version, trades, index }
/**
 * Lowercased search index over the given trades, cached by data version
 * + trades reference. The journal's row filter and highlight used to
 * re-run two regexes per note/remark (and re-lowercase every haystack)
 * on EVERY search commit — and twice per commit, once for the filter and
 * once for the highlights. Now the regexes + lowercasing run once per
 * data change; each search is just cheap `includes()` on the cached
 * strings. Fields are kept separate (label start/end, notes, tags) so a
 * query can never match across a join boundary the old code couldn't
 * match — results are identical to the unindexed search.
 */
export const getSearchIndex = (trades) => {
  if (searchIndexCache && searchIndexCache.version === searchDataVersion && searchIndexCache.trades === trades) {
    return searchIndexCache.index;
  }
  const index = trades.map((t) => {
    const lbl = getWeekLabel(t.id) ?? { weekStart: t.weekStart, weekEnd: t.weekEnd };
    const days = {};
    for (const d of t.days) {
      days[d.day] = {
        notes: getNotesText(t.id, d.day, d.notes ?? '').toLowerCase(),
        tags: getTags(t.id, d.day).map((tag) => tag.toLowerCase()),
      };
    }
    return {
      id: t.id,
      labelStart: lbl.weekStart.toLowerCase(),
      labelEnd: lbl.weekEnd.toLowerCase(),
      remarks: getRemarksText(t.id, t.remarks ?? '').toLowerCase(),
      days,
    };
  });
  searchIndexCache = { version: searchDataVersion, trades, index };
  return index;
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
  // Flush pending week-document saves first, so the backup includes the
  // latest edits (a note typed seconds ago is otherwise still only in
  // the memory cache).
  await flushAllWeekDocs();
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
  // Reads the memory cache, which holds the same per-key entries the old
  // raw-entries version read — week documents are fanned out into it on
  // load, so the CSV is unchanged (a raw dump would now see one wk_ key
  // per week instead of the notes/remarks rows).
  const p = dsPrefix();
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Type,Key,Value\n";

  for (const [key, value] of memCache) {
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

  // Flush pending week-document saves before wiping: a save queued by an
  // edit would otherwise run after the wipe and resurrect its document.
  await flushAllWeekDocs();

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
  // Flush first: a queued week-document save would otherwise run after
  // the wipe and resurrect its document.
  await flushAllWeekDocs();
  const p = dsPrefix();
  const allKeys = await keys();
  await runBatched(
    allKeys.filter(k => typeof k === 'string' && k.startsWith(p)),
    (k) => del(k), 16,
  );
  revokeAllThumbUrls();
  memCache.clear();
  await initStorage();
};

/**
 * Delete an entire index with all its data, every year.
 * Removes every dataset whose index matches (all years), deletes all
 * their namespaced keys, and drops them from the registry. If the
 * current dataset was among them, the journal lands on another
 * remaining dataset; if none remains, a fresh empty default dataset
 * (Nifty 50 / 2026) is created so the app always has a journal to open.
 * Returns the dataset the journal lands on.
 */
export const deleteIndex = async (index) => {
  const cleanIndex = String(index).trim();
  const datasets = getDatasets();
  const doomed = datasets.filter((d) => d.index === cleanIndex);
  if (doomed.length === 0) throw new Error(`Unknown index: ${cleanIndex}`);
  // Flush first: a queued week-document save would otherwise run after
  // the wipe and resurrect its document.
  await flushAllWeekDocs();
  const doomedIds = new Set(doomed.map((d) => d.id));
  const allKeys = await keys();
  const doomedKeys = allKeys.filter(
    (k) => typeof k === 'string' && [...doomedIds].some((id) => k.startsWith(`sb_ds_${id}__`)),
  );
  await runBatched(doomedKeys, (k) => del(k), 16);
  let remaining = datasets.filter((d) => !doomedIds.has(d.id));
  if (remaining.length === 0) remaining = [DEFAULT_DATASET];
  await set('sb_datasets', remaining);
  const nextCurrent = doomedIds.has(currentDatasetId) ? remaining[0].id : currentDatasetId;
  currentDatasetId = nextCurrent;
  await set('sb_current_dataset', nextCurrent);
  revokeAllThumbUrls();
  memCache.clear();
  await initStorage();
  return getCurrentDataset();
};
