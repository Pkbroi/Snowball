import { get, set, del, entries, clear } from 'idb-keyval';

/**
 * Snowball persistence helpers using idb-keyval (IndexedDB)
 * with an in-memory cache for synchronous, zero-latency retrieval.
 */

const memCache = new Map();

export const initStorage = async () => {
  const allEntries = await entries();
  memCache.clear();
  for (const [key, value] of allEntries) {
    memCache.set(key, value);
  }
};

/* ─── Cell chart images (Synchronous + In-Memory Cached) ─── */
const imgKey = (weekId, dayName) => `sb_img_${weekId}_${dayName}`;

export const getStoredImg = (weekId, dayName) => memCache.get(imgKey(weekId, dayName));

export const getStoredImgAsync = async (weekId, dayName) => {
  return memCache.get(imgKey(weekId, dayName)) ?? await get(imgKey(weekId, dayName));
};

export const setStoredImg = (weekId, dayName, val) => {
  if (val != null) {
    memCache.set(imgKey(weekId, dayName), val);
    set(imgKey(weekId, dayName), val);
  } else {
    memCache.delete(imgKey(weekId, dayName));
    del(imgKey(weekId, dayName));
  }
};

export const clearStoredImg = (weekId, dayName) => {
  memCache.delete(imgKey(weekId, dayName));
  del(imgKey(weekId, dayName));
};

export const resolveImg = (weekId, dayName, staticImg) => {
  const stored = memCache.get(imgKey(weekId, dayName));
  if (stored === 'DELETED') return null;
  return stored ?? staticImg ?? null;
};

export const resolveImgAsync = async (weekId, dayName, staticImg) => {
  return resolveImg(weekId, dayName, staticImg);
};

export const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

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
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.innerText;
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
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.innerText;
};

/* ─── Export & Import Database ─── */
export const exportDatabase = async () => {
  const allEntries = await entries();
  return JSON.stringify(allEntries);
};

export const importDatabase = async (jsonString) => {
  const data = JSON.parse(jsonString);
  if (!Array.isArray(data)) throw new Error('Invalid backup format');
  await clear();
  for (const [k, v] of data) {
    await set(k, v);
  }
  await initStorage();
};

export const formatDatabase = async () => {
  await clear();
  memCache.clear();
  await initStorage();
};
