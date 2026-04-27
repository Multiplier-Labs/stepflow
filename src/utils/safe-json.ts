/**
 * Safe JSON-parse helpers shared by storage and scheduler adapters.
 *
 * When a stored JSON column is corrupted, we want to surface the problem
 * operationally — structured log + counter — instead of silently degrading.
 * The logger payload is restricted to safe metadata (component, row id,
 * column, payload length, payload type, parser error message). The raw
 * value is intentionally never logged because it may contain user-provided
 * run / step input.
 *
 * Audit: 2026-04-27 findings L3 (corruption visibility) and M2 (do not
 * bypass the configured `Logger` or leak the raw value via `console`).
 */

import type { Logger } from '../core/types';

let corruptionCount = 0;

/** Cumulative number of `safeJsonParse` failures since process start. */
export function getJsonParseCorruptionCount(): number {
  return corruptionCount;
}

/** Reset the corruption counter. Tests only. */
export function resetJsonParseCorruptionCount(): void {
  corruptionCount = 0;
}

export interface SafeJsonParseContext {
  /** Component label, e.g. `SQLiteStorageAdapter`. */
  component: string;
  /** Optional database row id, surfaced in the warning so operators can locate the bad row. */
  rowId?: string;
  /** Optional column name for additional context. */
  column?: string;
  /** Optional structured logger; without one, only the counter is bumped. */
  logger?: Logger;
}

/**
 * Storage-adapter-level slice of `SafeJsonParseContext` — the part each
 * adapter binds once (its component label + optional logger). Row mappers
 * extend this with `rowId` and `column` per field, so corruption logs always
 * identify the bad row.
 *
 * Shared between `src/storage/postgres-core.ts` and
 * `src/storage/sqlite-core.ts` so all storage adapters use one mapper-context
 * shape regardless of backend.
 */
export type MapperContext = Pick<SafeJsonParseContext, 'component' | 'logger'>;

/**
 * Parse a JSON string; on `SyntaxError` return `fallback`, increment the
 * corruption counter, and emit a structured warn log via `ctx.logger` (if
 * supplied). Non-syntax errors propagate so unexpected runtime issues are
 * still loud.
 */
export function safeJsonParse<T = unknown>(
  json: string,
  fallback: T,
  ctx: SafeJsonParseContext
): T | unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) {
      corruptionCount++;
      ctx.logger?.warn(
        `[${ctx.component}] Corrupted JSON in database row, using fallback`,
        {
          rowId: ctx.rowId,
          column: ctx.column,
          length: typeof json === 'string' ? json.length : undefined,
          type: typeof json,
          error: error.message,
          corruptionCount,
        }
      );
      return fallback;
    }
    throw error;
  }
}

/** Parse a column value if it's still a JSON string; pass through otherwise. */
export function safeParseField(
  value: unknown,
  fallback: unknown,
  ctx: SafeJsonParseContext
): unknown {
  if (typeof value === 'string') {
    return safeJsonParse(value, fallback, ctx);
  }
  return value;
}

/** Same as `safeParseField` but returns `undefined` for falsy/missing values. */
export function safeParseOptionalField(
  value: unknown,
  ctx: SafeJsonParseContext
): unknown {
  if (!value) return undefined;
  if (typeof value === 'string') {
    return safeJsonParse(value, undefined, ctx);
  }
  return value;
}
