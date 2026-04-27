/**
 * Safe regex compilation helpers for user-supplied recipe conditions.
 *
 * Recipe definitions accept arbitrary regex strings via the `matches` operator.
 * Even with RE2 (which avoids catastrophic backtracking), an excessively long
 * pattern can still consume substantial memory and CPU during compilation, so
 * we cap the pattern length defensively before handing it to the engine.
 */

import RE2 from 're2';

/**
 * Maximum allowed length (in characters) of a user-supplied regex pattern
 * passed to the `matches` condition operator. Patterns above this limit are
 * rejected without being compiled.
 *
 * 512 is comfortably larger than any realistic structural pattern (URL, email,
 * UUID, etc.) but small enough to make pathological inputs cheap to reject.
 */
export const MAX_REGEX_PATTERN_LENGTH = 512;

/**
 * Compile a user-supplied pattern with RE2, enforcing the size cap.
 *
 * Returns `null` (rather than throwing) when the pattern is invalid or too
 * long, so callers can treat both cases as "condition does not match" without
 * needing a separate try/catch around every call site.
 */
export function safeCompileRegex(pattern: string): RE2 | null {
  if (typeof pattern !== 'string') return null;
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return null;
  try {
    return new RE2(pattern);
  } catch {
    return null;
  }
}
