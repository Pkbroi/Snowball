import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, scoreParamMap, scoreVerdict } from './rules.js';

const P = (id, points) => ({ id, short: id, label: id, points });

describe('scoreParamMap', () => {
  it('sums points with weights and counts followed / broke / n/a', () => {
    const params = [P('a', 2), P('b', 3), P('c', 1)];
    const r = scoreParamMap(params, { a: 1, b: -1 });
    expect(r).toEqual({ total: -1, followed: 1, broke: 1, answered: 2, na: 1 });
  });

  it('unscored day is all n/a with total 0', () => {
    const r = scoreParamMap(DEFAULT_PARAMS, {});
    expect(r).toEqual({ total: 0, followed: 0, broke: 0, answered: 0, na: 6 });
  });

  it('ignores scores for parameters no longer in the list', () => {
    const params = [P('a', 1)];
    const r = scoreParamMap(params, { a: 1, deleted: -1 });
    expect(r).toEqual({ total: 1, followed: 1, broke: 0, answered: 1, na: 0 });
  });

  it('a deleted parameter stops counting even when it was answered', () => {
    const before = scoreParamMap([P('a', 2), P('b', 1)], { a: 1, b: 1 });
    expect(before.total).toBe(3);
    const after = scoreParamMap([P('b', 1)], { a: 1, b: 1 });
    expect(after).toEqual({ total: 1, followed: 1, broke: 0, answered: 1, na: 0 });
  });
});

describe('scoreVerdict', () => {
  it('positive above zero, negative below zero', () => {
    expect(scoreVerdict([P('a', 1)], { a: 1 })).toBe('positive');
    expect(scoreVerdict([P('a', 1)], { a: -1 })).toBe('negative');
  });

  it('neutral when nothing is answered or the total is zero', () => {
    expect(scoreVerdict([P('a', 1)], {})).toBe('neutral');
    expect(scoreVerdict([P('a', 1), P('b', 1)], { a: 1, b: -1 })).toBe('neutral');
  });
});
