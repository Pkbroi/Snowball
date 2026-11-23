import { describe, it, expect } from 'vitest';
import { parseBackup } from './backupParse.js';

// parseBackup is the shared backup parser used by importDatabase on both
// paths (image worker, and the main-thread fallback when there is no
// worker). These tests pin the bug-1 validation contract: a corrupt
// backup throws BEFORE anything is wiped, with the same errors the old
// inline importDatabase threw, and each of the three backup shapes
// normalises to the right wipe target and entries.

const CURRENT = { id: 'nifty-50_2026', index: 'Nifty 50', year: 2026 };
const OPTS = { currentDataset: CURRENT, datasets: [CURRENT], defaultDatasetId: CURRENT.id };
// A 1x1 transparent PNG (70 bytes) — a real decodable image for the tests.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = `data:image/png;base64,${TINY_PNG_B64}`;
const P = 'sb_ds_nifty-50_2026__';

describe('parseBackup', () => {
  it('parses a whole-database backup: images become Blobs, metadata stays, wipeAll', async () => {
    const json = JSON.stringify([
      ['sb_datasets', [CURRENT]],
      ['sb_current_dataset', CURRENT.id],
      [`${P}img_w1_Monday`, IMG],
      [`${P}wk_w1`, { v: 1, label: 'Week 1', days: {} }],
      [`${P}extra_weeks`, [{ id: 'w1' }]],
    ]);
    const out = await parseBackup(json, OPTS);
    expect(out.wipeAll).toBe(true);
    expect(out.wipePrefix).toBeNull();
    expect(out.importTargetId).toBeNull();
    expect(out.imageBlobs).toBeInstanceOf(Map);
    expect(out.imageBlobs.size).toBe(1);
    const blob = out.imageBlobs.get(`${P}img_w1_Monday`);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(70);
    expect(blob.type).toBe('image/png');
    expect(out.otherEntries.map(([k]) => k)).toEqual(
      expect.arrayContaining(['sb_datasets', 'sb_current_dataset', `${P}wk_w1`, `${P}extra_weeks`]),
    );
    // Image entries are not in otherEntries.
    expect(out.otherEntries.some(([k]) => k === `${P}img_w1_Monday`)).toBe(false);
  });

  it('parses a single-dataset backup: wipePrefix + importTargetId, other datasets untouched', async () => {
    const json = JSON.stringify([
      ['sb_dataset', { id: 'bank-nifty_2026', index: 'Bank Nifty', year: 2026 }],
      ['sb_ds_bank-nifty_2026__img_w1_Monday', IMG],
      ['sb_ds_bank-nifty_2026__wk_w1', { v: 1, days: {} }],
    ]);
    const out = await parseBackup(json, OPTS);
    expect(out.wipeAll).toBe(false);
    expect(out.wipePrefix).toBe('sb_ds_bank-nifty_2026__');
    expect(out.importTargetId).toBe('bank-nifty_2026');
    expect(out.imageBlobs.size).toBe(1);
    // The new dataset is registered and selected.
    expect(out.otherEntries).toContainEqual([
      'sb_datasets',
      [CURRENT, { id: 'bank-nifty_2026', index: 'Bank Nifty', year: 2026 }],
    ]);
    expect(out.otherEntries).toContainEqual(['sb_current_dataset', 'bank-nifty_2026']);
  });

  it('migrates legacy flat keys under the current dataset prefix', async () => {
    const json = JSON.stringify([
      ['sb_img_w1_Monday', IMG],
      ['sb_extra_weeks', [{ id: 'w1' }]],
    ]);
    const out = await parseBackup(json, OPTS);
    expect(out.wipeAll).toBe(false);
    expect(out.wipePrefix).toBe(P);
    expect(out.importTargetId).toBe(CURRENT.id);
    expect(out.imageBlobs.has(`${P}img_w1_Monday`)).toBe(true);
    expect(out.otherEntries).toContainEqual([`${P}extra_weeks`, [{ id: 'w1' }]]);
  });

  it('rejects corrupt JSON', async () => {
    await expect(parseBackup('{not json', OPTS)).rejects.toThrow('could not parse JSON');
  });

  it('rejects a non-array backup', async () => {
    await expect(parseBackup('{"a":1}', OPTS)).rejects.toThrow('expected a JSON array');
  });

  it('rejects a non-pair entry', async () => {
    await expect(parseBackup(JSON.stringify([42]), OPTS)).rejects.toThrow(
      'expected a JSON array of [key, value] pairs',
    );
    await expect(parseBackup(JSON.stringify([['sb_x']]), OPTS)).rejects.toThrow(
      'expected a JSON array of [key, value] pairs',
    );
  });

  it('rejects a backup with no Snowball keys', async () => {
    await expect(parseBackup(JSON.stringify([['other_key', 1]]), OPTS)).rejects.toThrow(
      'contains no Snowball data',
    );
  });

  it('rejects a backup that mixes datasets', async () => {
    const json = JSON.stringify([
      ['sb_dataset', { id: 'bank-nifty_2026', index: 'Bank Nifty', year: 2026 }],
      ['sb_ds_bank-nifty_2026__wk_w1', { v: 1, days: {} }],
      ['sb_ds_nifty-50_2026__wk_w1', { v: 1, days: {} }],
    ]);
    await expect(parseBackup(json, OPTS)).rejects.toThrow('mixes data from multiple');
  });

  it('rejects a corrupt image (bad base64) and an empty image', async () => {
    const bad = JSON.stringify([['sb_datasets', [CURRENT]], [`${P}img_w1_Monday`, 'data:image/png;base64,!!!not-base64!!!']]);
    await expect(parseBackup(bad, OPTS)).rejects.toThrow('is corrupted (bad base64 data)');
    const empty = JSON.stringify([['sb_datasets', [CURRENT]], [`${P}img_w1_Monday`, 'data:image/png;base64,']]);
    await expect(parseBackup(empty, OPTS)).rejects.toThrow('is empty');
  });

  it('skips thumbnails (they are regenerated after import)', async () => {
    const json = JSON.stringify([
      ['sb_datasets', [CURRENT]],
      [`${P}img_w1_Monday`, IMG],
      [`${P}thumb_w1_Monday`, IMG],
    ]);
    const out = await parseBackup(json, OPTS);
    expect(out.imageBlobs.size).toBe(1);
    expect(out.imageBlobs.has(`${P}img_w1_Monday`)).toBe(true);
    // The thumb entry is dropped entirely (not an image, not metadata).
    expect(out.otherEntries.some(([k]) => k.includes('thumb_'))).toBe(false);
  });
});
