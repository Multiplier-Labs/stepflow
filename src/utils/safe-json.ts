/**
 * Centralized safe JSON parser for storage adapters.
 *
 * Database rows occasionally contain corrupted or truncated JSON. We want to
 * survive a corrupted row (return a fallback) but the corruption MUST be
 * surfaced to operators rather than silently swallowed. Two security goals:
 *
 * 1. (M2) Route corruption notices through the project's structured logger
 *    rather than `console.warn`/`console.error` directly. Pass only safe
 *    metadata (component, length, type, optional row id) — never the raw row
 *    value or the parser's error message, which can echo back chunks of the
 *    JSON content.
 * 2. (L3) Increment a metric counter on every corruption event so operators
 *    can detect data-quality problems before they cascade.
 */

import type { Logger } from '../core/types';

/** Per-call context for safeJsonParse. */
export interface SafeJsonParseContext {
  /**
   * Logger used to surface corruption. Defaults to a `console.warn`-backed
   * fallback so a missing logger does not silence the warning.
   */
  logger?: Logger;
  /** Component label used as a tag in log output (e.g. 'SQLiteStorageAdapter'). */
  component: string;
  /** Optional row id for cross-referencing the corrupted row in storage. */
  rowId?: string;
  /**
   * Optional callback invoked on every corruption event. Storage adapters
   * pass an increment-counter callback so corruption can be observed via
   * a metric in addition to the log.
   */
  onCorruption?: () => void;
}

const fallbackLogger: Logger = {
  debug() {},
  info() {},
  warn(message: string, ...args: unknown[]) {
    console.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    console.error(message, ...args);
  },
};

/**
 * Parse a JSON string from a database row. On `SyntaxError` the fallback is
 * returned, the corruption is logged with safe metadata only, and the
 * `onCorruption` callback (if any) fires.
 *
 * Non-`SyntaxError` errors are re-thrown so unexpected failures (e.g. stack
 * overflows on pathological inputs) are not swallowed.
 */
export function safeJsonParse(
  json: string,
  fallback: unknown,
  ctx: SafeJsonParseContext
): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const logger = ctx.logger ?? fallbackLogger;
      // We deliberately do NOT include `json` or `error.message` in the log
      // payload: both can leak raw row contents into log aggregation systems.
      logger.warn(
        `[${ctx.component}] Corrupted JSON in database row, using fallback`,
        {
          component: ctx.component,
          rowId: ctx.rowId,
          inputType: typeof json,
          inputLength: typeof json === 'string' ? json.length : undefined,
        }
      );
      ctx.onCorruption?.();
      return fallback;
    }
    throw error;
  }
}
