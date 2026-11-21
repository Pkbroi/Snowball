import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    // Simulate a reload: initStorage pre-caches thumbs only.
    await storage.initStorage();
    expect(storage.getStoredImg('week-q', 'Tuesday')).toBeNull();

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
    expect(allKeys).toContain('sb_ds_nifty-50_2026__notes_week-1_Monday');
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
    const { get } = await import('idb-keyval');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    storage.setTags('week-1', 'Monday', ['BankWin']);
    // setTags writes to IndexedDB async — wait for it to land before exporting.
    await vi.waitFor(async () => {
      expect(await get('sb_ds_bank-nifty_2026__tags_week-1_Monday')).toEqual(['BankWin']);
    });
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
    const { get } = await import('idb-keyval');
    storage.setTags('week-1', 'Monday', ['NiftyWin']);
    await storage.createDataset('Bank Nifty', 2026);
    await storage.switchDataset('bank-nifty_2026');
    storage.setTags('week-1', 'Monday', ['BankWin']);
    await vi.waitFor(async () => {
      expect(await get('sb_ds_bank-nifty_2026__tags_week-1_Monday')).toEqual(['BankWin']);
    });
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
