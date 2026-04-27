/**
 * Shared condition-evaluation helpers used by both the planner and the recipe
 * registry.
 *
 * Why a single module: `planner.ts` (recipe selection) and `registry.ts`
 * (registry-side queries) historically duplicated this logic, including the
 * `matches` operator's RE2 invocation. Drift between the two implementations
 * would cause a recipe to be selectable in one path but not the other, and —
 * more critically for security — would mean any future hardening of the
 * regex engine (e.g. tightening RE2 timeout/length limits, switching matchers)
 * has to be applied in two places. Centralizing the logic here keeps RE2 usage
 * in lock-step.
 */

import RE2 from 're2';
import type { ConditionOperator, RecipeCondition } from './types';

/**
 * Walk a nested object using dot-notation (`a.b.c`) and return the value, or
 * `undefined` if any segment is missing or the parent is not an object.
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
 * Evaluate a single comparison.
 *
 * The `matches` operator uses RE2, which is linear-time and immune to
 * catastrophic backtracking. A failed regex compile (e.g. invalid pattern)
 * is treated as a non-match rather than an exception so a single malformed
 * recipe condition cannot tear down the entire selection process.
 */
export function evaluateOperator(
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

/**
 * Evaluate a `RecipeCondition` against an input object. Returns `true` when
 * the condition matches.
 */
export function evaluateCondition(
  condition: RecipeCondition,
  input: Record<string, unknown>
): boolean {
  const fieldValue = getNestedValue(input, condition.field);
  return evaluateOperator(condition.operator, fieldValue, condition.value);
}

/**
 * Evaluate every condition in `conditions` against `input` and return `true`
 * when all conditions match. Empty/undefined `conditions` is treated as a
 * match by callers; this helper returns `true` in that case as well.
 */
export function evaluateConditionsAll(
  conditions: RecipeCondition[] | undefined,
  input: Record<string, unknown>
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(condition => evaluateCondition(condition, input));
}

/**
 * Count how many conditions match. Used by the planner to score recipes.
 */
export function countMatchingConditions(
  conditions: RecipeCondition[] | undefined,
  input: Record<string, unknown>
): number {
  if (!conditions || conditions.length === 0) return 0;
  let matched = 0;
  for (const condition of conditions) {
    if (evaluateCondition(condition, input)) matched++;
  }
  return matched;
}
