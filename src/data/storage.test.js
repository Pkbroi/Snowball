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
});
