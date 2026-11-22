import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clear } from 'idb-keyval';

// Counting `keys()` calls needs a wrapper: vi.spyOn cannot touch an ESM
// module namespace ("not configurable"), so the whole idb-keyval module
// is mocked here with a pass-through that counts `keys()` invocations
// on a global. Every other export delegates to the real implementation,
// so storage behaviour is unchanged — only the count is observable.
// (This file is separate from storage.test.js so the mock touches
// nothing else.)
vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    keys: (...args) => {
      globalThis.__idbKeysCalls = (globalThis.__idbKeysCalls ?? 0) + 1;
      return actual.keys(...args);
    },
  };
});

import { initStorage } from './storage';

describe('Key scans on startup (round-2 improvement 3)', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
    globalThis.__idbKeysCalls = 0;
  });

  it('initStorage scans the keys twice in total, not three', async () => {
    await initStorage();
    // One scan is the main metadata load; the second is the background
    // thumbnail load, kicked off synchronously by initStorage — so by
    // the time initStorage resolves, both scans have been issued. Before
    // this change the week-doc migration ran its own scan on every
    // startup as well, for three in total.
    expect(globalThis.__idbKeysCalls).toBe(2);
  });
});
