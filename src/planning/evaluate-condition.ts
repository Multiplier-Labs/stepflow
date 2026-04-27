/**
 * Shared condition evaluation helpers used by the planner and registry.
 *
 * Extracted to a single module so the planner's recipe scoring and the
 * registry's `query({ matchConditions })` filter cannot drift apart.
 */

import RE2 from 're2';
import type { ConditionOperator } from './types';

/**
 * Maximum length (in characters) accepted for a `matches` regex pattern.
 *
 * Recipe conditions can come from user-supplied configuration; even with RE2's
 * linear-time guarantee, very large patterns waste CPU/memory at compile time
 * and inflate the per-evaluation cost. Cap the source length so a pathological
 * recipe cannot hand the planner a megabyte of regex.
 */
export const MAX_REGEX_PATTERN_LENGTH = 512;

/**
 * Get a nested value from an object using dot notation.
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string
): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Evaluate a single condition against a value.
 *
 * The `matches` operator uses RE2 (not the JS RegExp engine) to avoid
 * catastrophic-backtracking DoS from untrusted recipe inputs.
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
        if (conditionValue.length > MAX_REGEX_PATTERN_LENGTH) {
          return false;
        }
        try {
          return new RE2(conditionValue).test(fieldValue);
        } catch {
          return false;
        }
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
