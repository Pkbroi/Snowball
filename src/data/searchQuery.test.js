import { describe, it, expect } from 'vitest';
import {
  parseSearchQuery,
  dayMatchesQuery,
  dayOutlineMatchesQuery,
  remarksMatchQuery,
} from './searchQuery.js';

// Tag search language (2026-11-27): tag=(gapup+loss) for both tags,
// tag=(gapup+loss) + loss for both tags AND 'loss' in the notes,
// '+' = AND (intersection), ',' = OR (union), '+' binds tighter than ','.

const day = (tags, notes, remarks = '') => ({
  tags: tags.map((t) => t.toLowerCase()),
  notes: notes.toLowerCase(),
  remarks: remarks.toLowerCase(),
});

describe('parseSearchQuery', () => {
  it('returns null for empty or content-free queries', () => {
    expect(parseSearchQuery('')).toBeNull();
    expect(parseSearchQuery('   ')).toBeNull();
    expect(parseSearchQuery('+,,')).toBeNull();
    expect(parseSearchQuery('tag=')).toBeNull();
    expect(parseSearchQuery('tag=()')).toBeNull();
    expect(parseSearchQuery('tag= + ,')).toBeNull();
  });

  it('parses a single tag term', () => {
    expect(parseSearchQuery('tag=gapup')).toEqual({
      orGroups: [[{ type: 'tags', orGroups: [['gapup']] }]],
    });
  });

  it('parses tag=(a+b) as both tags, tag=(a,b) as either tag', () => {
    expect(parseSearchQuery('tag=(gapup+loss)')).toEqual({
      orGroups: [[{ type: 'tags', orGroups: [['gapup', 'loss']] }]],
    });
    expect(parseSearchQuery('tag=(gapup,breakout)')).toEqual({
      orGroups: [[{ type: 'tags', orGroups: [['gapup'], ['breakout']] }]],
    });
    expect(parseSearchQuery('tag=(gapup+loss,breakout)')).toEqual({
      orGroups: [[{ type: 'tags', orGroups: [['gapup', 'loss'], ['breakout']] }]],
    });
  });

  it('parses the user example: tag=(gapup+loss) + loss', () => {
    expect(parseSearchQuery('tag=(gapup+loss) + loss')).toEqual({
      orGroups: [[
        { type: 'tags', orGroups: [['gapup', 'loss']] },
        { type: 'notes', value: 'loss' },
      ]],
    });
  });

  it('AND binds tighter than OR', () => {
    expect(parseSearchQuery('loss , tag=gapup + breakout')).toEqual({
      orGroups: [
        [{ type: 'notes', value: 'loss' }],
        [{ type: 'tags', orGroups: [['gapup']] }, { type: 'notes', value: 'breakout' }],
      ],
    });
  });

  it('is case-insensitive and ignores spaces around operators', () => {
    expect(parseSearchQuery('TAG=(GAPUP+LOSS) + LOSS')).toEqual(
      parseSearchQuery('tag=(gapup+loss) + loss'),
    );
    expect(parseSearchQuery('tag = ( gapup + loss ) + loss')).toEqual(
      parseSearchQuery('tag=(gapup+loss) + loss'),
    );
    expect(parseSearchQuery('tag=gapup+tag=breakout')).toEqual({
      orGroups: [[
        { type: 'tags', orGroups: [['gapup']] },
        { type: 'tags', orGroups: [['breakout']] },
      ]],
    });
  });

  it('is forgiving about a missing closing paren and a trailing operator', () => {
    expect(parseSearchQuery('tag=(gapup')).toEqual(parseSearchQuery('tag=(gapup)'));
    expect(parseSearchQuery('tag=gapup +')).toEqual(parseSearchQuery('tag=gapup'));
    expect(parseSearchQuery('tag=gapup + + loss')).toEqual(
      parseSearchQuery('tag=gapup + loss'),
    );
  });

  it('parses rem= terms and bare words', () => {
    expect(parseSearchQuery('rem=expiry')).toEqual({
      orGroups: [[{ type: 'remarks', value: 'expiry' }]],
    });
    expect(parseSearchQuery('stop loss')).toEqual({
      orGroups: [[{ type: 'notes', value: 'stop loss' }]],
    });
  });
});

describe('dayMatchesQuery', () => {
  const d = day(['gapup', 'loss'], 'took a small loss here', 'expiry week');

  it('tag terms match exactly, not as substrings', () => {
    expect(dayMatchesQuery(parseSearchQuery('tag=gapup'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('tag=gap'), d)).toBe(false);
    expect(dayMatchesQuery(parseSearchQuery('tag=(gapup+loss)'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('tag=(gapup+breakout)'), d)).toBe(false);
    expect(dayMatchesQuery(parseSearchQuery('tag=(gapup,breakout)'), d)).toBe(true);
  });

  it('notes terms match as substrings; AND requires the same day', () => {
    expect(dayMatchesQuery(parseSearchQuery('loss'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('losses'), d)).toBe(false);
    expect(dayMatchesQuery(parseSearchQuery('tag=(gapup+loss) + loss'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('tag=(gapup+loss) + profit'), d)).toBe(false);
    // The AND is per day: a day with the tags but no 'profit' in its
    // notes does not match, even if another day has it.
    expect(dayMatchesQuery(parseSearchQuery('tag=gapup + profit'), day(['gapup'], 'profit here'))).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('tag=gapup + profit'), day(['gapup'], 'no word'))).toBe(false);
  });

  it('rem terms read the week remarks', () => {
    expect(dayMatchesQuery(parseSearchQuery('rem=expiry'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('rem=other'), d)).toBe(false);
    expect(dayMatchesQuery(parseSearchQuery('tag=gapup + rem=expiry'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('tag=gapup + rem=other'), d)).toBe(false);
  });

  it('OR unions the searches', () => {
    expect(dayMatchesQuery(parseSearchQuery('tag=gapup , tag=breakout'), d)).toBe(true);
    expect(dayMatchesQuery(parseSearchQuery('tag=breakout , profit'), d)).toBe(false);
    expect(dayMatchesQuery(parseSearchQuery('tag=breakout , loss'), d)).toBe(true);
  });

  it('null query matches everything', () => {
    expect(dayMatchesQuery(null, d)).toBe(true);
  });
});

describe('dayOutlineMatchesQuery', () => {
  it('a rem-only query outlines no day cells', () => {
    const d = day(['gapup'], 'notes', 'expiry week');
    expect(dayOutlineMatchesQuery(parseSearchQuery('rem=expiry'), d)).toBe(false);
  });

  it('drops rem terms: outline follows the day-level terms only', () => {
    const withTag = day(['gapup'], 'notes', 'expiry week');
    const withoutTag = day(['loss'], 'notes', 'expiry week');
    expect(dayOutlineMatchesQuery(parseSearchQuery('tag=gapup + rem=expiry'), withTag)).toBe(true);
    expect(dayOutlineMatchesQuery(parseSearchQuery('tag=gapup + rem=expiry'), withoutTag)).toBe(false);
    expect(dayOutlineMatchesQuery(parseSearchQuery('tag=gapup , rem=expiry'), withTag)).toBe(true);
    expect(dayOutlineMatchesQuery(parseSearchQuery('tag=gapup , rem=expiry'), withoutTag)).toBe(false);
  });
});

describe('remarksMatchQuery', () => {
  it('true only when a rem term matches', () => {
    expect(remarksMatchQuery(parseSearchQuery('rem=expiry'), 'expiry week')).toBe(true);
    expect(remarksMatchQuery(parseSearchQuery('rem=other'), 'expiry week')).toBe(false);
    expect(remarksMatchQuery(parseSearchQuery('tag=gapup'), 'expiry week')).toBe(false);
    expect(remarksMatchQuery(parseSearchQuery('tag=gapup + rem=expiry'), 'expiry week')).toBe(true);
    expect(remarksMatchQuery(null, 'expiry week')).toBe(false);
  });
});
