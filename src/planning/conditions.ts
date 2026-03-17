/**
 * Shared condition evaluation utilities.
 * Used by both the RuleBasedPlanner and MemoryRecipeRegistry.
 */

import type { ConditionOperator } from './types';

// Module-level cache for compiled RegExp instances.
// Avoids recompiling the same pattern on every condition evaluation.
const regexpCache = new Map<string, RegExp | null>();

/**
 * Get a cached RegExp for a pattern, or compile and cache it.
 * Returns null if the pattern is invalid.
 */
function getCachedRegExp(pattern: string): RegExp | null {
  if (regexpCache.has(pattern)) {
    return regexpCache.get(pattern)!;
  }
  try {
    const re = new RegExp(pattern);
    regexpCache.set(pattern, re);
    return re;
  } catch {
    regexpCache.set(pattern, null);
    return null;
  }
}

/**
 * Get a nested value from an object using dot notation.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Evaluate a single condition against a value.
 */
export function evaluateCondition(
  operator: ConditionOperator,
  fieldValue: unknown,
  conditionValue: unknown
): boolean {
  switch (operator) {
    case 'eq':
      return fieldValue === conditionValue;

    case 'neq':
      return fieldValue !== conditionValue;

    case 'gt':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue > conditionValue
        : false;

    case 'gte':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue >= conditionValue
        : false;

    case 'lt':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue < conditionValue
        : false;

    case 'lte':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue <= conditionValue
        : false;

    case 'contains':
      if (typeof fieldValue === 'string' && typeof conditionValue === 'string') {
        return fieldValue.includes(conditionValue);
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(conditionValue);
      }
      return false;

    case 'matches':
      if (typeof fieldValue === 'string' && typeof conditionValue === 'string') {
        const re = getCachedRegExp(conditionValue);
        return re ? re.test(fieldValue) : false;
      }
      return false;

    case 'exists':
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';

    case 'notExists':
      return fieldValue === undefined || fieldValue === null || fieldValue === '';

    default:
      return false;
  }
}
