import { describe, it, expect } from 'vitest';
import {
  countMatchingConditions,
  evaluateCondition,
  evaluateConditionsAll,
  evaluateOperator,
  getNestedValue,
} from './conditions';

describe('getNestedValue', () => {
  it('returns nested values via dot notation', () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing segments', () => {
    expect(getNestedValue({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(getNestedValue({}, 'a')).toBeUndefined();
  });
});

describe('evaluateOperator', () => {
  it('handles eq/neq', () => {
    expect(evaluateOperator('eq', 'foo', 'foo')).toBe(true);
    expect(evaluateOperator('neq', 'foo', 'bar')).toBe(true);
  });

  it('handles numeric comparisons', () => {
    expect(evaluateOperator('gt', 2, 1)).toBe(true);
    expect(evaluateOperator('gte', 1, 1)).toBe(true);
    expect(evaluateOperator('lt', 1, 2)).toBe(true);
    expect(evaluateOperator('lte', 1, 1)).toBe(true);
    expect(evaluateOperator('gt', 'a', 'b')).toBe(false);
  });

  it('handles contains for strings and arrays', () => {
    expect(evaluateOperator('contains', 'hello world', 'world')).toBe(true);
    expect(evaluateOperator('contains', ['a', 'b'], 'b')).toBe(true);
    expect(evaluateOperator('contains', ['a', 'b'], 'c')).toBe(false);
  });

  it('uses RE2 for matches and is safe against catastrophic patterns', () => {
    expect(evaluateOperator('matches', 'abc123', '^[a-z]+\\d+$')).toBe(true);

    // RE2 rejects backreferences/lookaround at compile time. A pattern that would
    // hang JS RegExp via catastrophic backtracking should return false (compile
    // failure) and complete almost instantly here.
    const pathological = '(a+)+$';
    const longInput = 'a'.repeat(40) + 'b';
    const start = Date.now();
    const result = evaluateOperator('matches', longInput, pathological);
    const elapsedMs = Date.now() - start;

    expect(typeof result).toBe('boolean');
    expect(elapsedMs).toBeLessThan(500);
  });

  it('handles exists/notExists', () => {
    expect(evaluateOperator('exists', 'value', undefined)).toBe(true);
    expect(evaluateOperator('exists', '', undefined)).toBe(false);
    expect(evaluateOperator('notExists', undefined, undefined)).toBe(true);
  });
});

describe('evaluateCondition / evaluateConditionsAll / countMatchingConditions', () => {
  const input = { user: { tier: 'gold', age: 30 }, tags: ['vip'] };

  it('evaluates a single condition with a nested field', () => {
    expect(
      evaluateCondition({ field: 'user.tier', operator: 'eq', value: 'gold' }, input)
    ).toBe(true);
  });

  it('returns true when conditions are empty or missing', () => {
    expect(evaluateConditionsAll(undefined, input)).toBe(true);
    expect(evaluateConditionsAll([], input)).toBe(true);
  });

  it('requires every condition to match', () => {
    expect(
      evaluateConditionsAll(
        [
          { field: 'user.tier', operator: 'eq', value: 'gold' },
          { field: 'user.age', operator: 'gte', value: 25 },
        ],
        input
      )
    ).toBe(true);

    expect(
      evaluateConditionsAll(
        [
          { field: 'user.tier', operator: 'eq', value: 'gold' },
          { field: 'user.age', operator: 'gte', value: 99 },
        ],
        input
      )
    ).toBe(false);
  });

  it('counts matching conditions for scoring', () => {
    expect(
      countMatchingConditions(
        [
          { field: 'user.tier', operator: 'eq', value: 'gold' },
          { field: 'user.age', operator: 'lt', value: 0 },
        ],
        input
      )
    ).toBe(1);
  });
});
