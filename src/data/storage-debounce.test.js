import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clear } from 'idb-keyval';

// Counting IndexedDB `set` calls for week documents: vi.spyOn cannot
// touch an ESM module namespace, so idb-keyval is mocked with a
// pass-through that records every `set` of a `wk_` key (and the last
// document written). (Separate file so the mock touches nothing else.)
vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    set: (key, value) => {
      if (typeof key === 'string' && key.includes('wk_')) {
        globalThis.__wkPuts = (globalThis.__wkPuts ?? 0) + 1;
        globalThis.__lastWkDoc = value;
      }
      return actual.set(key, value);
    },
  };
});

import { initStorage, setNotes, getNotes, flushAllWeekDocs } from './storage';

const WEEK = '2026-11-23';
const DAY = 'Monday';

describe('Debounced week-doc saves (perf 3)', () => {
  beforeEach(async () => {
    await clear();
    window.localStorage.clear();
    await initStorage();
    globalThis.__wkPuts = 0;
    globalThis.__lastWkDoc = null;
  });

  it('20 notes edits spread over time write the week document once', async () => {
    // Edits 60ms apart: each gap is long enough for the old per-keystroke
    // write to complete (so the old code would put ~20 times), but far
    // shorter than the 500ms debounce (so the timer keeps resetting).
    // A synchronous burst would not discriminate — the old write chain
    // already coalesces edits made in the same tick.
    for (let i = 1; i <= 20; i++) {
      setNotes(WEEK, DAY, `<p>note ${i}</p>`);
      await new Promise((r) => setTimeout(r, 60));
    }
    // Nothing written yet — the 500ms debounce has not fired (the last
    // edit was only 60ms ago).
    expect(globalThis.__wkPuts).toBe(0);
    await new Promise((r) => setTimeout(r, 800));
    expect(globalThis.__wkPuts).toBe(1);
    expect(globalThis.__lastWkDoc.days[DAY].notes).toBe('<p>note 20</p>');
  });

  it('flush writes immediately, without waiting for the debounce', async () => {
    for (let i = 1; i <= 20; i++) setNotes(WEEK, DAY, `<p>note ${i}</p>`);
    await flushAllWeekDocs();
    expect(globalThis.__wkPuts).toBe(1);
    expect(globalThis.__lastWkDoc.days[DAY].notes).toBe('<p>note 20</p>');
    // And no second write follows when the debounce timer would have fired.
    await new Promise((r) => setTimeout(r, 800));
    expect(globalThis.__wkPuts).toBe(1);
  });

  it('notes survive an unload before the debounce fires (localStorage stash + replay)', async () => {
    for (let i = 1; i <= 20; i++) setNotes(WEEK, DAY, `<p>note ${i}</p>`);
    // The unload flush fires (beforeunload), then a fresh load replays
    // the stash into IndexedDB before reading the week docs.
    window.dispatchEvent(new window.Event('beforeunload'));
    await initStorage();
    expect(getNotes(WEEK, DAY)).toBe('<p>note 20</p>');
  });
});
