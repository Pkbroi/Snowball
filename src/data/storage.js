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
    // Skip eager loading of images to save RAM
    if (!key.startsWith('sb_img_')) {
      memCache.set(key, value);
    }
  }
};

/* ─── Cell chart images (Synchronous + In-Memory Cached) ─── */
const imgKey = (weekId, dayName) => `sb_img_${weekId}_${dayName}`;

export const getStoredImg = (weekId, dayName) => memCache.get(imgKey(weekId, dayName));

export const getStoredImgAsync = async (weekId, dayName) => {
  const cached = memCache.get(imgKey(weekId, dayName));
  if (cached) return cached;

  let val = await get(imgKey(weekId, dayName));
  if (!val) return null;

  if (typeof val === 'string' && val.startsWith('data:image')) {
    const res = await fetch(val);
    val = await res.blob();
    await set(imgKey(weekId, dayName), val);
  }

  const url = URL.createObjectURL(val);
  memCache.set(imgKey(weekId, dayName), url);
  return url;
};

export const setStoredImg = (weekId, dayName, val) => {
  if (val != null) {
    const url = val instanceof Blob ? URL.createObjectURL(val) : val;
    const oldUrl = memCache.get(imgKey(weekId, dayName));
    if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
    
    memCache.set(imgKey(weekId, dayName), url);
    set(imgKey(weekId, dayName), val);
    return url;
  } else {
    const oldUrl = memCache.get(imgKey(weekId, dayName));
    if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
    
    memCache.set(imgKey(weekId, dayName), 'DELETED');
    del(imgKey(weekId, dayName));
    return null;
  }
};

export const clearStoredImg = (weekId, dayName) => {
  const oldUrl = memCache.get(imgKey(weekId, dayName));
  if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
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

export const fileToDataUrl = async (file) => {
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

export const exportDatabase = async () => {
  const allEntries = await entries();
  const processed = await Promise.all(allEntries.map(async ([k, v]) => {
    if (v instanceof Blob) {
      return [k, await fileToDataUrl(v)];
    }
    return [k, v];
  }));
  return JSON.stringify(processed);
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

export const importDatabase = async (jsonString) => {
  const data = JSON.parse(jsonString);
  if (!Array.isArray(data)) throw new Error('Invalid backup format');
  await clear();
  for (const [k, v] of data) {
    if (typeof v === 'string' && v.startsWith('data:image')) {
      const res = await fetch(v);
      const blob = await res.blob();
      await set(k, blob);
    } else {
      await set(k, v);
    }
  }
  await initStorage();
};

export const formatDatabase = async () => {
  await clear();
  memCache.clear();
  await initStorage();
};
