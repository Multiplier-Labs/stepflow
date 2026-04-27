/**
 * Safe JSON parse helpers shared by storage and scheduler adapters.
 *
 * When a stored JSON column is corrupted, we want to surface the problem
 * operationally (structured log + counter) instead of silently returning a
 * fallback. We deliberately log only safe metadata — never the raw payload —
 * because that payload may contain user-provided run/step input.
 *
 * Audit: 2026-04-27 findings L3 (corruption logging) and M2 (do not bypass
 * the structured logger or leak the raw value via console).
 */

import type { Logger } from '../core/types';

/** Module-level counter exposing total JSON parse failures since process start. */
let corruptionCount = 0;

/** Returns the cumulative number of `safeJsonParse` failures since startup. */
export function getJsonParseCorruptionCount(): number {
  return corruptionCount;
}

/** Reset the corruption counter — intended for tests only. */
export function resetJsonParseCorruptionCount(): void {
  corruptionCount = 0;
}

export interface SafeJsonParseContext {
  /** Component label for log filtering (e.g. `SQLiteStorageAdapter`). */
  component: string;
  /** Optional database row id, surfaced in the warning so operators can locate the bad row. */
  rowId?: string;
  /** Optional column name for additional context. */
  column?: string;
  /** Optional structured logger; falls back to a no-op logger. */
  logger?: Logger;
}

/**
 * Parse a JSON string, returning `fallback` and recording a corruption event
 * (warn log + counter increment) if the input is syntactically invalid.
 *
 * Non-syntax errors are rethrown so unexpected runtime issues are still loud.
 *
 * The logger payload contains only safe metadata (length, type, error message,
 * row id, column name). The raw `json` argument is intentionally NEVER logged.
 */
export function safeJsonParse<T = unknown>(
  json: string,
  fallback: T,
  context: SafeJsonParseContext
): T | unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) {
      corruptionCount++;
      const logger = context.logger;
      if (logger) {
        logger.warn(
          `[${context.component}] Corrupted JSON in database row, using fallback`,
          {
            rowId: context.rowId,
            column: context.column,
            length: typeof json === 'string' ? json.length : undefined,
            type: typeof json,
            error: error.message,
            corruptionCount,
          }
        );
      }
      return fallback;
    }
    throw error;
  }
}
