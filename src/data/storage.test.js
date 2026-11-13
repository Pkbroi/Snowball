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
