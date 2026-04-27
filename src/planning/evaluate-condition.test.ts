import { describe, it, expect } from 'vitest';
import { evaluateCondition, getNestedValue } from './evaluate-condition';

describe('getNestedValue', () => {
  it('returns top-level values', () => {
    expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
  });

  it('returns nested values via dot notation', () => {
    expect(getNestedValue({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });

  it('returns undefined for missing paths', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when traversing through a non-object', () => {
    expect(getNestedValue({ a: 5 }, 'a.b')).toBeUndefined();
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
  });

  it('preserves falsy values (0, false, empty string)', () => {
    expect(getNestedValue({ a: 0 }, 'a')).toBe(0);
    expect(getNestedValue({ a: false }, 'a')).toBe(false);
    expect(getNestedValue({ a: '' }, 'a')).toBe('');
  });
});

describe('evaluateCondition', () => {
  describe('eq / neq', () => {
    it('uses strict equality', () => {
      expect(evaluateCondition('eq', 1, 1)).toBe(true);
      expect(evaluateCondition('eq', 1, '1')).toBe(false);
      expect(evaluateCondition('eq', 'a', 'a')).toBe(true);
      expect(evaluateCondition('neq', 1, 2)).toBe(true);
      expect(evaluateCondition('neq', 'a', 'a')).toBe(false);
    });
  });

  describe('numeric comparisons', () => {
    it('gt / gte / lt / lte work for numbers', () => {
      expect(evaluateCondition('gt', 5, 3)).toBe(true);
      expect(evaluateCondition('gt', 3, 5)).toBe(false);
      expect(evaluateCondition('gt', 5, 5)).toBe(false);
      expect(evaluateCondition('gte', 5, 5)).toBe(true);
      expect(evaluateCondition('lt', 3, 5)).toBe(true);
      expect(evaluateCondition('lt', 5, 5)).toBe(false);
      expect(evaluateCondition('lte', 5, 5)).toBe(true);
    });

    it('returns false when either side is not a number', () => {
      expect(evaluateCondition('gt', '5', 3)).toBe(false);
      expect(evaluateCondition('gt', 5, '3')).toBe(false);
      expect(evaluateCondition('gte', null, 0)).toBe(false);
      expect(evaluateCondition('lt', undefined, 1)).toBe(false);
      expect(evaluateCondition('lte', true, 0)).toBe(false);
    });
  });

  describe('contains', () => {
    it('matches substrings in strings', () => {
      expect(evaluateCondition('contains', 'hello world', 'world')).toBe(true);
      expect(evaluateCondition('contains', 'hello world', 'xyz')).toBe(false);
    });

    it('matches elements in arrays', () => {
      expect(evaluateCondition('contains', [1, 2, 3], 2)).toBe(true);
      expect(evaluateCondition('contains', ['a', 'b'], 'c')).toBe(false);
    });

    it('returns false for unsupported types', () => {
      expect(evaluateCondition('contains', 42, 4)).toBe(false);
      expect(evaluateCondition('contains', { a: 1 }, 'a')).toBe(false);
    });
  });

  describe('matches', () => {
    it('returns true for matching regex', () => {
      expect(evaluateCondition('matches', 'hello world', '^hello')).toBe(true);
      expect(evaluateCondition('matches', 'foo123', '\\d+')).toBe(true);
    });

    it('returns false for non-matching regex', () => {
      expect(evaluateCondition('matches', 'hello', '^world')).toBe(false);
    });

    it('returns false on invalid regex (does not throw)', () => {
      expect(evaluateCondition('matches', 'hello', '[invalid')).toBe(false);
    });

    it('returns false when either side is not a string', () => {
      expect(evaluateCondition('matches', 123, '\\d+')).toBe(false);
      expect(evaluateCondition('matches', 'abc', /abc/)).toBe(false);
    });

    it('rejects unsafe RE2-incompatible patterns rather than throwing', () => {
      // Backreferences are unsupported in RE2 — verify we degrade gracefully.
      expect(evaluateCondition('matches', 'aa', '(a)\\1')).toBe(false);
    });
  });

  describe('exists / notExists', () => {
    it('exists is true for any non-empty value', () => {
      expect(evaluateCondition('exists', 'value', undefined)).toBe(true);
      expect(evaluateCondition('exists', 0, undefined)).toBe(true);
      expect(evaluateCondition('exists', false, undefined)).toBe(true);
      expect(evaluateCondition('exists', [], undefined)).toBe(true);
    });

    it('exists is false for undefined, null, or empty string', () => {
      expect(evaluateCondition('exists', undefined, undefined)).toBe(false);
      expect(evaluateCondition('exists', null, undefined)).toBe(false);
      expect(evaluateCondition('exists', '', undefined)).toBe(false);
    });

    it('notExists mirrors exists', () => {
      expect(evaluateCondition('notExists', undefined, undefined)).toBe(true);
      expect(evaluateCondition('notExists', null, undefined)).toBe(true);
      expect(evaluateCondition('notExists', '', undefined)).toBe(true);
      expect(evaluateCondition('notExists', 'value', undefined)).toBe(false);
      expect(evaluateCondition('notExists', 0, undefined)).toBe(false);
    });
  });

  describe('unknown operator', () => {
    it('returns false for an unrecognized operator', () => {
      // Cast through unknown to test the default branch.
      expect(
        evaluateCondition(
          'bogus' as unknown as Parameters<typeof evaluateCondition>[0],
          1,
          1
        )
      ).toBe(false);
    });
  });
});
