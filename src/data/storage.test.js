import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTags, setTags, initStorage, formatDatabase } from './storage';
import { clear } from 'idb-keyval';

describe('Storage utility (Tags)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  it('should return empty array for tags initially', () => {
    const tags = getTags('week-1', 'Monday');
    expect(tags).toEqual([]);
  });

  it('should store and retrieve tags correctly', () => {
    setTags('week-1', 'Monday', ['Loss', 'Revenge']);
    const tags = getTags('week-1', 'Monday');
    expect(tags).toEqual(['Loss', 'Revenge']);
  });

  it('should delete tags if empty array is provided', () => {
    setTags('week-1', 'Monday', ['Loss']);
    setTags('week-1', 'Monday', []);
    const tags = getTags('week-1', 'Monday');
    expect(tags).toEqual([]);
  });

  it('should store and synchronously retrieve image thumbnails', async () => {
    const { getStoredThumb, setStoredImg } = await import('./storage');
    await setStoredImg('week-test', 'Tuesday', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    const thumb = getStoredThumb('week-test', 'Tuesday');
    expect(thumb).toBeTruthy();
  });
});

describe('Storage utility (Image quality — regression tests)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  // 1x1 red PNG, used as a stand-in for an uploaded chart.
  const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('fileToDataUrl must be lossless: same bytes back, no resize/re-encode', async () => {
    const { fileToDataUrl } = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'chart.png', { type: 'image/png' });
    await expect(fileToDataUrl(file)).resolves.toBe(redPng);
  });

  it('setStoredImg must keep the full image retrievable (not just its thumbnail)', async () => {
    const { setStoredImg, getStoredImgAsync, getStoredThumb, getStoredImg } = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    const original = new File([bytes], 'chart.png', { type: 'image/png' });

    // NOTE: fake-indexeddb in jsdom structured-clones Blobs to plain
    // objects, so byte-level IndexedDB assertions can't run here — the
    // lossless path (File -> Blob stored as-is, no re-encode) is covered
    // by fileToDataUrl above + the Playwright upload test in
    // tests/image-quality-zoom.spec.js, which runs in a real browser.
    const url = await setStoredImg('week-q', 'Monday', original);
    expect(url).toBeTruthy();
    expect(url.startsWith('blob:')).toBe(true);

    // The full image must still be retrievable even once a thumbnail
    // exists — previously initStorage only cached thumbs, so the detail
    // page could only ever show the 480px thumbnail.
    await expect(getStoredImgAsync('week-q', 'Monday')).resolves.toBe(url);
    expect(getStoredImg('week-q', 'Monday')).toBe(url);
    expect(getStoredThumb('week-q', 'Monday')).toBeTruthy();
  });

  it('getStoredImgAsync must load the full image after a fresh initStorage (thumb-only cache)', async () => {
    const storage = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    await storage.setStoredImg('week-q', 'Tuesday', new File([bytes], 'chart.png', { type: 'image/png' }));

    // Simulate a reload: initStorage loads metadata only; thumbnails
    // stream in afterwards (perf step 6), so wait for them explicitly.
    await storage.initStorage();
    expect(storage.getStoredImg('week-q', 'Tuesday')).toBeNull();
    await storage.loadThumbnails();

    // …but the full image must still be loadable on demand for detail/lightbox.
    const full = await storage.getStoredImgAsync('week-q', 'Tuesday');
    expect(full).toBeTruthy();
    expect(full).not.toBe(storage.getStoredThumb('week-q', 'Tuesday'));
  });
});

describe('Storage utility (Three-tier images + metadata)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('formatBytes formats sizes for the Original badge', async () => {
    const { formatBytes } = await import('./storage');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
  });

  it('createDerivative falls back to the source when no worker/canvas is available (jsdom)', async () => {
    const { createDerivative, createMedium } = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    await expect(createDerivative(blob, { maxDim: 480, quality: 0.8 })).resolves.toBe(blob);
    await expect(createMedium(blob)).resolves.toBe(blob);
  });

  it('createAllDerivatives returns null without a worker (jsdom) — the upload falls back to the old path', async () => {
    const storage = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    await expect(storage.createAllDerivatives(new Blob([bytes], { type: 'image/png' }))).resolves.toBeNull();
    // Fallback path (getImageDimensions + createThumbnail + createMedium)
    // still records metadata and a thumbnail in jsdom.
    await storage.setStoredImg('week-f', 'Monday', new File([bytes], 'chart.png', { type: 'image/png' }));
    const meta = storage.getImageMeta('week-f', 'Monday');
    expect(meta).toBeTruthy();
    expect(meta.size).toBe(bytes.length);
    expect(meta.type).toBe('image/png');
    expect(storage.getStoredThumb('week-f', 'Monday')).toBeTruthy();
  });

  it('setStoredImg records original metadata (size/type/name) and clears it on delete', async () => {
    const storage = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    await storage.setStoredImg('week-m', 'Monday', new File([bytes], 'chart.png', { type: 'image/png' }));
    const meta = storage.getImageMeta('week-m', 'Monday');
    expect(meta).toBeTruthy();
    expect(meta.size).toBe(bytes.length);
    expect(meta.type).toBe('image/png');
    expect(meta.name).toBe('chart.png');
    // Medium tier: in jsdom the derivative is the source Blob itself, so
    // nothing is stored — the UI falls back to the full image there. In a
    // real browser a 1600px medium is generated by the worker.
    await expect(storage.getStoredMediumAsync('week-m', 'Monday')).resolves.toBeNull();
    await storage.setStoredImg('week-m', 'Monday', 'DELETED');
    expect(storage.getImageMeta('week-m', 'Monday')).toBeNull();
    expect(storage.getStoredMedium('week-m', 'Monday')).toBeNull();
  });
});

describe('Datasets (index × year)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  it('defaults to Nifty 50 / 2026 on a fresh install', async () => {
    const { getDatasets, getCurrentDataset } = await import('./storage');
    expect(getDatasets()).toEqual([{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]);
    expect(getCurrentDataset()).toEqual({ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 });
  });

  it('migrates legacy flat keys to Nifty 50 / 2026 on first run', async () => {
    const storage = await import('./storage');
    const { keys, set } = await import('idb-keyval');
    // Simulate the pre-datasets database: wipe the registry, seed flat keys.
    await clear();
    await set('sb_extra_weeks', [{ id: 'week-1', days: [] }]);
    await set('sb_notes_week-1_Monday', '<p>legacy note</p>');
    await set('sb_rem_week-1', '<p>legacy remark</p>');
    await storage.initStorage();

    expect(storage.getExtraWeeks()).toEqual([{ id: 'week-1', days: [] }]);
    expect(storage.getNotes('week-1', 'Monday')).toBe('<p>legacy note</p>');
    expect(storage.getRemarks('week-1')).toBe('<p>legacy remark</p>');
    const allKeys = await keys();
    expect(allKeys).not.toContain('sb_extra_weeks');
    expect(allKeys).toContain('sb_ds_nifty-50_2026__extra_weeks');
    // Legacy flat keys first move under the dataset prefix, then the
    // week-doc migration folds them into one document per week — the
    // old per-key names must be gone.
    expect(allKeys).toContain('sb_ds_nifty-50_2026__wk_week-1');
    expect(allKeys).not.toContain('sb_ds_nifty-50_2026__notes_week-1_Monday');
    expect(allKeys).not.toContain('sb_ds_nifty-50_2026__rem_week-1');
    expect(storage.getCurrentDataset().id).toBe('nifty-50_2026');
  });

  it('keeps data separate per dataset', async () => {
    const storage = await import('./storage');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual([]);
    storage.setTags('week-1', 'Monday', ['BankWin']);
    await storage.switchDataset('nifty-50_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['NiftyWin']);
    await storage.switchDataset('bank-nifty_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['BankWin']);
  });

  it('createDataset returns the existing dataset instead of duplicating', async () => {
    const storage = await import('./storage');
    const a = await storage.createDataset('Bank Nifty', 2026);
    const b = await storage.createDataset('Bank Nifty', 2026);
    expect(a).toEqual(b);
    expect(storage.getDatasets().filter((d) => d.id === 'bank-nifty_2026')).toHaveLength(1);
  });

  it('createDataset rejects bad input', async () => {
    const storage = await import('./storage');
    await expect(storage.createDataset('', 2026)).rejects.toThrow('Index name is required');
    await expect(storage.createDataset('Nifty', 1999)).rejects.toThrow('Year must be between 2000 and 2100');
  });

  it('exports the whole database as one clean, key-sorted file', async () => {
    const storage = await import('./storage');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    storage.setTags('week-1', 'Monday', ['BankWin']);
    // setTags writes the week document async — flush it before exporting.
    await storage.flushAllWeekDocs();
    const json = await storage.exportDatabase();
    const data = JSON.parse(json);
    // Both datasets in one file, registry included, no per-dataset marker.
    expect(json).toContain('NiftyWin');
    expect(json).toContain('BankWin');
    expect(data).toContainEqual(['sb_datasets', [
      { id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 },
      { id: 'bank-nifty_2026', index: 'Bank Nifty', year: 2026 },
    ]]);
    expect(data).toContainEqual(['sb_current_dataset', 'bank-nifty_2026']);
    expect(data.find(([k]) => k === 'sb_dataset')).toBeUndefined();
    // Keys sorted: the file is deterministic and grouped by dataset.
    const keys = data.map(([k]) => k);
    expect(keys).toEqual([...keys].sort());
  });

  it('import restores the whole database, including the selected dataset', async () => {
    const storage = await import('./storage');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    storage.setTags('week-1', 'Monday', ['BankWin']);
    await storage.flushAllWeekDocs();
    const backup = await storage.exportDatabase();

    // Wipe everything, then restore from the single backup file.
    await clear();
    await storage.initStorage();
    expect(storage.getTags('week-1', 'Monday')).toEqual([]);
    await storage.importDatabase(backup);
    expect(storage.getCurrentDataset().id).toBe('bank-nifty_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['BankWin']);
    await storage.switchDataset('nifty-50_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['NiftyWin']);
  });

  it('import stores a data-URL image entry from a backup', async () => {
    // NOTE: fake-indexeddb in jsdom structured-clones Blobs to plain
    // objects, so byte-level export assertions cannot run here (see the
    // image-quality describe above). The true byte-identical round trip
    // is covered in tests/backup-roundtrip.spec.js in real Chromium.
    // Here: a backup carrying an image data-URL imports and the entry
    // is retrievable afterwards.
    const storage = await import('./storage');
    const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const backup = JSON.stringify([
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
      ['sb_ds_nifty-50_2026__img_week-1_Monday', redPng],
      ['sb_ds_nifty-50_2026__meta_week-1_Monday', { width: 1, height: 1, size: 70, type: 'image/png', name: 'chart.png' }],
    ]);
    await storage.importDatabase(backup);
    const img = await storage.getStoredImgAsync('week-1', 'Monday');
    expect(img).toBeTruthy();
    expect(storage.getImageMeta('week-1', 'Monday')).toEqual(
      { width: 1, height: 1, size: 70, type: 'image/png', name: 'chart.png' });
  });

  it('legacy flat backup imports into Nifty 50 / 2026', async () => {
    const storage = await import('./storage');
    const legacy = JSON.stringify([
      ['sb_tags_week-1_Monday', ['LegacyWin']],
      ['sb_extra_weeks', [{ id: 'week-1', days: [] }]],
    ]);
    await storage.importDatabase(legacy);
    expect(storage.getCurrentDataset().id).toBe('nifty-50_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['LegacyWin']);
    expect(storage.getExtraWeeks()).toEqual([{ id: 'week-1', days: [] }]);
  });

  it('format wipes only the current dataset', async () => {
    const storage = await import('./storage');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    storage.setTags('week-1', 'Monday', ['BankWin']);
    await storage.formatDatabase();
    expect(storage.getTags('week-1', 'Monday')).toEqual([]);
    await storage.switchDataset('nifty-50_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['NiftyWin']);
  });

  it('deleteIndex removes every year of that index and keeps the others', async () => {
    const storage = await import('./storage');
    const { keys } = await import('idb-keyval');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Nifty 50', 2025);
    await storage.switchDataset('nifty-50_2025');
    storage.setTags('week-1', 'Monday', ['Nifty25Win']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    storage.setTags('week-1', 'Monday', ['BankWin']);

    const landed = await storage.deleteIndex('Nifty 50');
    // Only Bank Nifty survives, and the journal lands on it.
    expect(storage.getDatasets()).toEqual([{ id: 'bank-nifty_2026', index: 'Bank Nifty', year: 2026 }]);
    expect(storage.getCurrentDataset().id).toBe('bank-nifty_2026');
    expect(landed.id).toBe('bank-nifty_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['BankWin']);
    // No Nifty 50 key survives, either year.
    const allKeys = await keys();
    expect(allKeys.filter((k) => typeof k === 'string' && k.includes('nifty-50'))).toEqual([]);
  });

  it('deleteIndex recreates a fresh empty default when it was the only index', async () => {
    const storage = await import('./storage');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    const landed = await storage.deleteIndex('Nifty 50');
    expect(storage.getDatasets()).toEqual([{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]);
    expect(storage.getCurrentDataset().id).toBe('nifty-50_2026');
    expect(landed.id).toBe('nifty-50_2026');
    expect(storage.getTags('week-1', 'Monday')).toEqual([]);
  });

  it('deleteIndex rejects an unknown index', async () => {
    const storage = await import('./storage');
    await expect(storage.deleteIndex('No Such Index')).rejects.toThrow('Unknown index');
  });
});

describe('Week documents — per-week metadata (perf step 4)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  it('writers persist into one document per week, readable after a fresh load', async () => {
    const storage = await import('./storage');
    const { get, keys } = await import('idb-keyval');
    storage.setWeekLabel('week-1', { month: 'Nov', dates: '10–14' });
    storage.setRemarks('week-1', '<p>good week</p>');
    storage.setNotes('week-1', 'Monday', '<p>gap up</p>');
    storage.setTags('week-1', 'Monday', ['GapUp']);
    storage.setTradeDate('week-1', 'Monday', '2026-11-10');
    storage.setNotes('week-1', 'Tuesday', '<p>flat</p>');
    await storage.flushAllWeekDocs();

    const doc = await get('sb_ds_nifty-50_2026__wk_week-1');
    expect(doc).toEqual({
      v: 1,
      label: { month: 'Nov', dates: '10–14' },
      remarks: '<p>good week</p>',
      days: {
        Monday: { notes: '<p>gap up</p>', tags: ['GapUp'], date: '2026-11-10' },
        Tuesday: { notes: '<p>flat</p>' },
      },
    });
    // No per-key metadata keys survive for this week.
    const allKeys = await keys();
    expect(allKeys.filter((k) => typeof k === 'string' && k.includes('week-1') && !k.includes('__wk_'))).toEqual([]);

    // Simulate a reload: a fresh initStorage fans the document back out.
    await storage.initStorage();
    expect(storage.getWeekLabel('week-1')).toEqual({ month: 'Nov', dates: '10–14' });
    expect(storage.getRemarks('week-1')).toBe('<p>good week</p>');
    expect(storage.getNotes('week-1', 'Monday')).toBe('<p>gap up</p>');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['GapUp']);
    expect(storage.getTradeDate('week-1', 'Monday')).toBe('2026-11-10');
    expect(storage.getNotes('week-1', 'Tuesday')).toBe('<p>flat</p>');
  });

  it('rapid writes coalesce: only the last value lands in the document', async () => {
    const storage = await import('./storage');
    const { get } = await import('idb-keyval');
    storage.setNotes('week-1', 'Monday', '<p>one</p>');
    storage.setNotes('week-1', 'Monday', '<p>two</p>');
    storage.setNotes('week-1', 'Monday', '<p>three</p>');
    storage.setTags('week-1', 'Monday', ['A']);
    storage.setTags('week-1', 'Monday', ['B']);
    await storage.flushAllWeekDocs();
    const doc = await get('sb_ds_nifty-50_2026__wk_week-1');
    expect(doc.days.Monday.notes).toBe('<p>three</p>');
    expect(doc.days.Monday.tags).toEqual(['B']);
  });

  it('an empty week stores no document', async () => {
    const storage = await import('./storage');
    const { get } = await import('idb-keyval');
    storage.setNotes('week-1', 'Monday', '<p>temp</p>');
    storage.setNotes('week-1', 'Monday', '');
    await storage.flushAllWeekDocs();
    expect(await get('sb_ds_nifty-50_2026__wk_week-1')).toBeUndefined();
    expect(storage.getNotes('week-1', 'Monday')).toBeUndefined();
  });

  it('migration converts old per-key metadata and deletes the old keys', async () => {
    const storage = await import('./storage');
    const { get, set, keys } = await import('idb-keyval');
    const p = 'sb_ds_nifty-50_2026__';
    await set(`${p}wlbl_week-9`, { month: 'Oct', dates: '27–31' });
    await set(`${p}rem_week-9`, '<p>old remarks</p>');
    await set(`${p}notes_week-9_Monday`, '<p>old note</p>');
    await set(`${p}tags_week-9_Monday`, ['OldTag']);
    await set(`${p}meta_week-9_Monday`, { width: 100, height: 50, size: 10, type: 'image/png', name: null });
    await set(`${p}date_week-9_Monday`, '2026-10-27');
    await set(`${p}notes_week-9_Friday`, '<p>friday note</p>');
    await storage.initStorage();

    expect(storage.getWeekLabel('week-9')).toEqual({ month: 'Oct', dates: '27–31' });
    expect(storage.getRemarks('week-9')).toBe('<p>old remarks</p>');
    expect(storage.getNotes('week-9', 'Monday')).toBe('<p>old note</p>');
    expect(storage.getTags('week-9', 'Monday')).toEqual(['OldTag']);
    expect(storage.getImageMeta('week-9', 'Monday')).toEqual(
      { width: 100, height: 50, size: 10, type: 'image/png', name: null });
    expect(storage.getTradeDate('week-9', 'Monday')).toBe('2026-10-27');
    expect(storage.getNotes('week-9', 'Friday')).toBe('<p>friday note</p>');
    const doc = await get(`${p}wk_week-9`);
    expect(doc.v).toBe(1);
    expect(doc.days.Monday.meta).toEqual({ width: 100, height: 50, size: 10, type: 'image/png', name: null });
    const allKeys = await keys();
    expect(allKeys.filter((k) => typeof k === 'string' && k.startsWith(p) && !k.startsWith(`${p}wk_`) && !k.startsWith(`${p}extra_`) && k !== 'sb_datasets' && k !== 'sb_current_dataset')).toEqual([]);
  });

  it('migration is idempotent: a second load changes nothing', async () => {
    const storage = await import('./storage');
    const { get, set } = await import('idb-keyval');
    const p = 'sb_ds_nifty-50_2026__';
    await set(`${p}notes_week-9_Monday`, '<p>old note</p>');
    await storage.initStorage();
    const first = await get(`${p}wk_week-9`);
    await storage.initStorage();
    const second = await get(`${p}wk_week-9`);
    expect(second).toEqual(first);
    expect(storage.getNotes('week-9', 'Monday')).toBe('<p>old note</p>');
  });

  it('interrupted migration merges with the document winning', async () => {
    const storage = await import('./storage');
    const { set } = await import('idb-keyval');
    const p = 'sb_ds_nifty-50_2026__';
    // A document already exists (newer notes) but the old keys were never
    // deleted, and the old keys hold a field the document lacks (tags).
    await set(`${p}wk_week-9`, {
      v: 1,
      days: { Monday: { notes: '<p>new note</p>' } },
    });
    await set(`${p}notes_week-9_Monday`, '<p>stale note</p>');
    await set(`${p}tags_week-9_Monday`, ['KeptTag']);
    await storage.initStorage();
    expect(storage.getNotes('week-9', 'Monday')).toBe('<p>new note</p>');
    expect(storage.getTags('week-9', 'Monday')).toEqual(['KeptTag']);
    const doc = await (await import('idb-keyval')).get(`${p}wk_week-9`);
    expect(doc.days.Monday).toEqual({ notes: '<p>new note</p>', tags: ['KeptTag'] });
    const allKeys = await (await import('idb-keyval')).keys();
    expect(allKeys).not.toContain(`${p}notes_week-9_Monday`);
    expect(allKeys).not.toContain(`${p}tags_week-9_Monday`);
  });

  it('deleteWeekData removes the document and it stays gone', async () => {
    const storage = await import('./storage');
    const { get } = await import('idb-keyval');
    // A distinct week id: a deleted week's id is never reused in the app
    // (custom ids carry a timestamp + random suffix), and the delete
    // marks the id dead so a queued save cannot resurrect it.
    storage.setNotes('week-del', 'Monday', '<p>to delete</p>');
    storage.setTags('week-del', 'Monday', ['Gone']);
    storage.deleteWeekData('week-del');
    // A save queued by the edits above must not resurrect the document.
    await storage.flushAllWeekDocs();
    expect(await get('sb_ds_nifty-50_2026__wk_week-del')).toBeUndefined();
    expect(storage.getNotes('week-del', 'Monday')).toBeUndefined();
    expect(storage.getTags('week-del', 'Monday')).toEqual([]);
  });

  it('export includes the latest edit without waiting', async () => {
    const storage = await import('./storage');
    storage.setTags('week-1', 'Monday', ['JustTyped']);
    const json = await storage.exportDatabase();
    expect(json).toContain('JustTyped');
    expect(json).toContain('sb_ds_nifty-50_2026__wk_week-1');
    expect(json).not.toContain('sb_ds_nifty-50_2026__tags_week-1_Monday');
  });

  it('an old-format backup imports and migrates on load', async () => {
    const storage = await import('./storage');
    const legacy = JSON.stringify([
      ['sb_datasets', [{ id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 }]],
      ['sb_current_dataset', 'nifty-50_2026'],
      ['sb_ds_nifty-50_2026__notes_week-1_Monday', '<p>backed up note</p>'],
      ['sb_ds_nifty-50_2026__tags_week-1_Monday', ['BackupTag']],
      ['sb_ds_nifty-50_2026__rem_week-1', '<p>backed up remarks</p>'],
    ]);
    await storage.importDatabase(legacy);
    expect(storage.getNotes('week-1', 'Monday')).toBe('<p>backed up note</p>');
    expect(storage.getTags('week-1', 'Monday')).toEqual(['BackupTag']);
    expect(storage.getRemarks('week-1')).toBe('<p>backed up remarks</p>');
    const { get, keys } = await import('idb-keyval');
    expect(await get('sb_ds_nifty-50_2026__wk_week-1')).toBeTruthy();
    const allKeys = await keys();
    expect(allKeys).not.toContain('sb_ds_nifty-50_2026__notes_week-1_Monday');
  });
});

describe('Thumbnail streaming — paint before thumbnails (perf step 6)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  it('loadThumbnails caches thumbs and notifies subscribers per batch', async () => {
    const storage = await import('./storage');
    const { set } = await import('idb-keyval');
    const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    // Seed thumbnail blobs directly, as if a previous session saved them.
    await set('sb_ds_nifty-50_2026__thumb_week-1_Monday', blob);
    await set('sb_ds_nifty-50_2026__thumb_week-1_Tuesday', blob);

    let notifications = 0;
    const unsubscribe = storage.subscribeThumbs(() => { notifications++; });
    await storage.loadThumbnails();
    unsubscribe();

    // NOTE: fake-indexeddb structured-clones Blobs to plain objects in
    // jsdom, so the cached value here is a truthy object, not a blob:
    // URL — the blob: URL form is asserted in the Playwright spec,
    // which runs in a real browser.
    expect(storage.getStoredThumb('week-1', 'Monday')).toBeTruthy();
    expect(storage.getStoredThumb('week-1', 'Tuesday')).toBeTruthy();
    expect(notifications).toBeGreaterThanOrEqual(1);
  });

  it('loadThumbnails notifies per week (round-2 improvement 1)', async () => {
    const storage = await import('./storage');
    const { set } = await import('idb-keyval');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await set('sb_ds_nifty-50_2026__thumb_week-1_Monday', blob);
    await set('sb_ds_nifty-50_2026__thumb_week-2_Monday', blob);

    const notified = [];
    const unsubscribe = storage.subscribeThumbs((weekIds) => { notified.push([...(weekIds ?? [])]); });
    await storage.loadThumbnails();
    unsubscribe();

    // One batch (2 keys), one notification naming exactly the weeks in it.
    expect(notified).toHaveLength(1);
    expect(notified[0].sort()).toEqual(['week-1', 'week-2']);
  });

  it('unsubscribe stops notifications', async () => {
    const storage = await import('./storage');
    const { set } = await import('idb-keyval');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await set('sb_ds_nifty-50_2026__thumb_week-1_Monday', blob);
    let notifications = 0;
    const unsubscribe = storage.subscribeThumbs(() => { notifications++; });
    unsubscribe();
    await storage.loadThumbnails();
    expect(notifications).toBe(0);
  });
});

describe('Lazy thumbnail object URLs (perf step 7)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('getStoredThumb creates the URL lazily; revokeThumbUrl drops it and the next read re-creates it', async () => {
    const storage = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    await storage.setStoredImg('week-l', 'Monday', new File([bytes], 'chart.png', { type: 'image/png' }));

    const first = storage.getStoredThumb('week-l', 'Monday');
    expect(first).toBeTruthy();
    expect(first.startsWith('blob:')).toBe(true);
    // Second read reuses the same URL — one URL per visible row.
    expect(storage.getStoredThumb('week-l', 'Monday')).toBe(first);

    storage.revokeThumbUrl('week-l', 'Monday');
    const second = storage.getStoredThumb('week-l', 'Monday');
    expect(second).toBeTruthy();
    expect(second.startsWith('blob:')).toBe(true);
    // A fresh URL after the revoke: the blob survived, the URL did not.
    expect(second).not.toBe(first);
  });

  it('switching datasets revokes the previous dataset\'s thumbnail URLs', async () => {
    const storage = await import('./storage');
    const bytes = Uint8Array.from(atob(redPng.split(',')[1]), (c) => c.charCodeAt(0));
    await storage.setStoredImg('week-l', 'Monday', new File([bytes], 'chart.png', { type: 'image/png' }));
    const url = storage.getStoredThumb('week-l', 'Monday');
    expect(url.startsWith('blob:')).toBe(true);

    const revoked = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { revoked.push(u); });
    try {
      const bank = await storage.createDataset('Bank Nifty', 2026);
      await storage.switchDataset(bank.id);
    } finally {
      spy.mockRestore();
    }
    expect(revoked).toContain(url);
  });
});

describe('Precomputed search index (round-2 improvement 2)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  const trades = [
    { id: 'week-1', weekStart: '05 Jan', weekEnd: '09 Jan', remarks: '', days: [{ day: 'Monday', notes: '' }, { day: 'Tuesday', notes: '' }] },
    { id: 'week-2', weekStart: '12 Jan', weekEnd: '16 Jan', remarks: '', days: [{ day: 'Monday', notes: '' }] },
  ];

  it('lowercases once, keeps fields separate, and caches by data version', async () => {
    const storage = await import('./storage');
    storage.setNotes('week-1', 'Monday', '<p>GapUp</p>');
    storage.setTags('week-1', 'Monday', ['Breakout']);
    storage.setRemarks('week-1', '<p>Big <b>gapup</b> day</p>');

    const first = storage.getSearchIndex(trades);
    expect(first[0].days.Monday.notes).toBe('gapup');
    expect(first[0].days.Monday.tags).toEqual(['breakout']);
    expect(first[0].remarks).toBe('big gapup day');
    expect(first[0].labelStart).toBe('05 jan');
    expect(first[1].days.Monday.notes).toBe('');

    // Same data + same trades reference: the exact same cached array.
    expect(storage.getSearchIndex(trades)).toBe(first);

    // An edit invalidates the cache: the next build picks up the new text.
    storage.setNotes('week-1', 'Monday', '<p>gapdown</p>');
    const second = storage.getSearchIndex(trades);
    expect(second).not.toBe(first);
    expect(second[0].days.Monday.notes).toBe('gapdown');
  });

  it('a query matches exactly what the unindexed search matched', async () => {
    const storage = await import('./storage');
    storage.setNotes('week-1', 'Monday', '<p>GapUp</p>');
    storage.setNotes('week-1', 'Tuesday', '<p>gapdown</p>');
    storage.setNotes('week-2', 'Monday', '<p>GAPDOWN</p>');

    const index = storage.getSearchIndex(trades);
    const matches = (q) => {
      const query = q.toLowerCase();
      const hits = [];
      for (const e of index) {
        for (const [dayName, de] of Object.entries(e.days)) {
          if (de.notes.includes(query) || de.tags.some((t) => t.includes(query))) hits.push(`${e.id}|${dayName}`);
        }
      }
      return hits;
    };
    for (const q of ['gapup', 'GAPUP', 'GapUp']) {
      expect(matches(q)).toEqual(['week-1|Monday']);
    }
    expect(matches('gapdown')).toEqual(['week-1|Tuesday', 'week-2|Monday']);
  });
});

describe('Off-screen thumbnail eviction (round-2 improvement 4)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  const redPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('evicts the thumb Blob after the delay and revokes its URL, keeping the known flag', async () => {
    const storage = await import('./storage');
    await storage.setStoredImg('week-1', 'Monday', redPng);
    expect(storage.hasStoredThumb('week-1', 'Monday')).toBe(true);
    expect(storage.hasThumbBlob('week-1', 'Monday')).toBe(true);

    const url = storage.getStoredThumb('week-1', 'Monday');
    expect(url.startsWith('blob:')).toBe(true);
    const revoked = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { revoked.push(u); });
    try {
      storage.scheduleThumbEviction('week-1', 'Monday', 10);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      spy.mockRestore();
    }
    // Blob gone from memCache, URL revoked — but the thumb is still
    // known to exist in IndexedDB, so a remount reloads it.
    expect(storage.hasThumbBlob('week-1', 'Monday')).toBe(false);
    expect(storage.hasStoredThumb('week-1', 'Monday')).toBe(true);
    expect(revoked).toContain(url);
  });

  it('a remount cancels the pending eviction', async () => {
    const storage = await import('./storage');
    await storage.setStoredImg('week-1', 'Monday', redPng);
    storage.scheduleThumbEviction('week-1', 'Monday', 10);
    storage.cancelThumbEviction('week-1', 'Monday');
    await new Promise((r) => setTimeout(r, 50));
    expect(storage.hasThumbBlob('week-1', 'Monday')).toBe(true);
  });
});
