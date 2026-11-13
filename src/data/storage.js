import { get, set, del, keys, entries, clear } from 'idb-keyval';
import imageCompression from 'browser-image-compression';

/**
 * Snowball persistence helpers using idb-keyval (IndexedDB)
 * with an in-memory cache for synchronous, zero-latency retrieval.
 */

const memCache = new Map();

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

/**
 * Fast native thumbnail generator using 2D Canvas.
 * Resizes images to max 480px width/height and compresses to WebP/JPEG ~25KB.
 */
export const createThumbnail = async (source) => {
  if (!source || typeof document === 'undefined') return source;
  if (typeof window !== 'undefined' && window.navigator?.userAgent?.includes('jsdom')) {
    return source;
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
    const timer = setTimeout(() => finish(source), 400);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maxDim = 480;
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
          // Prefer OffscreenCanvas — avoids synchronous main-thread layout during drawing
          if (typeof OffscreenCanvas !== 'undefined') {
            try {
              const offscreen = new OffscreenCanvas(width, height);
              const ctx = offscreen.getContext('2d');
              if (!ctx) { finish(source); return; }
              ctx.drawImage(img, 0, 0, width, height);
              offscreen.convertToBlob({ type: 'image/webp', quality: 0.8 })
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
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob((blob) => {
              if (blob) finish(blob);
              else finish(source);
            }, 'image/webp', 0.8);
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

export const initStorage = async (onProgress) => {
  const allKeys = await keys();
  memCache.clear();

  // 1. Load metadata, notes, tags, remarks, and extra weeks
  const metaKeys = allKeys.filter(k => typeof k === 'string' && !k.startsWith('sb_img_') && !k.startsWith('sb_thumb_'));
  // Batched reads: prevent IDB queue saturation with unlimited Promise.all
  await runBatched(metaKeys, async (key) => {
    const val = await get(key);
    memCache.set(key, val);
  });

  // 2. Pre-cache all thumbnails into memory (thumbnails are tiny)
  const thumbKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('sb_thumb_'));
  await runBatched(thumbKeys, async (key) => {
    const val = await get(key);
    if (val) {
      const url = val instanceof Blob ? URL.createObjectURL(val) : val;
      memCache.set(key, url);
    }
  });

  // 3. For any image without a thumbnail, fully await loading + thumbnail generation
  //    so all images are ready before the UI renders (no lazy/scroll-triggered loading)
  const imgKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('sb_img_'));
  const imgKeysWithoutThumb = imgKeys.filter(key => !memCache.has(key.replace('sb_img_', 'sb_thumb_')));

  let loaded = 0;
  const total = thumbKeys.length + imgKeysWithoutThumb.length;

  // Report initial progress
  if (onProgress && total > 0) onProgress(0, total);

  // Thumbnails counted as already loaded
  loaded = thumbKeys.length;
  if (onProgress && total > 0) onProgress(loaded, total);

  await runBatched(imgKeysWithoutThumb, async (key) => {
    const tKey = key.replace('sb_img_', 'sb_thumb_');
    const val = await get(key);
    if (val) {
      const url = val instanceof Blob ? URL.createObjectURL(val) : val;
      memCache.set(key, url);
      memCache.set(tKey, url); // use full image as thumb initially

      // Generate and persist proper thumbnail (awaited so it's ready before render)
      try {
        const tBlob = await createThumbnail(val);
        if (tBlob && tBlob instanceof Blob) {
          const thumbUrl = URL.createObjectURL(tBlob);
          memCache.set(tKey, thumbUrl);
          set(tKey, tBlob).catch(() => {}); // persist in background
        }
      } catch {
        // thumbnail generation failed, full image is already cached as fallback
      }
    }
    loaded++;
    if (onProgress && total > 0) onProgress(loaded, total);
  });
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

  let val = await get(imgKey(weekId, dayName));
  if (!val) return null;

  const url = val instanceof Blob ? URL.createObjectURL(val) : val;
  memCache.set(imgKey(weekId, dayName), url);
  return url;
};

export const setStoredImg = async (weekId, dayName, val) => {
  const kImg = imgKey(weekId, dayName);
  const kThumb = thumbKey(weekId, dayName);

  if (val != null) {
    const displayUrl = val instanceof Blob ? URL.createObjectURL(val) : val;
    memCache.set(kImg, displayUrl);
    memCache.set(kThumb, displayUrl);
    
    // Save original image
    set(kImg, val);

    // Create and save optimized thumbnail for the grid
    try {
      const thumb = await createThumbnail(val);
      if (thumb && thumb instanceof Blob) {
        const thumbUrl = URL.createObjectURL(thumb);
        memCache.set(kThumb, thumbUrl);
        set(kThumb, thumb);
      }
    } catch (e) {
      console.warn('Could not generate thumbnail:', e);
    }

    return displayUrl;
  } else {
    memCache.set(kImg, 'DELETED');
    memCache.set(kThumb, 'DELETED');
    del(kImg);
    del(kThumb);
    return null;
  }
};

export const clearStoredImg = (weekId, dayName) => {
  memCache.delete(imgKey(weekId, dayName));
  memCache.delete(thumbKey(weekId, dayName));
  del(imgKey(weekId, dayName));
  del(thumbKey(weekId, dayName));
};

export const resolveImg = (weekId, dayName, staticImg) => {
  const stored = memCache.get(imgKey(weekId, dayName));
  if (stored === 'DELETED') return null;
  return stored ?? staticImg ?? null;
};

export const resolveImgAsync = async (weekId, dayName, staticImg) => {
  return resolveImg(weekId, dayName, staticImg);
};

export const fileToDataUrl = async (file) => {
  try {
    const options = {
      maxSizeMB: 1,
      maxWidthOrHeight: 1920,
      useWebWorker: true,
    };
    const compressedFile = await imageCompression(file, options);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(compressedFile);
    });
  } catch (error) {
    console.error('Image compression failed:', error);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
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

/**
 * Convert a data-URL string directly to a Blob using atob + Uint8Array.
 * Replaces the previous fetch(dataURL) anti-pattern, which routed every
 * image through the full browser network stack (slow, failure-prone, and
 * unable to handle large payloads without freezing).
 */
const dataURLtoBlob = (dataURL) => {
  const comma = dataURL.indexOf(',');
  const mime = dataURL.slice(5, dataURL.indexOf(';'));
  const b64 = dataURL.slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

export const exportDatabase = async (onProgress) => {
  const allEntries = await entries();

  // Exclude thumbnails — they are derived from full images and will be
  // regenerated automatically by initStorage after import.
  const exportable = allEntries.filter(([k]) => !String(k).startsWith('sb_thumb_'));

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
