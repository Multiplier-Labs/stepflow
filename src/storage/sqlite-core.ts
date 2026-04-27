/**
 * Shared core for the SQLite storage adapter.
 *
 * Mirrors the structure introduced for Postgres in `postgres-core.ts` (PR #50)
 * so all storage adapters expose row mappers and types in the same shape.
 *
 * The SQLite case is simpler than Postgres: there is only one adapter class
 * (`SQLiteStorageAdapter`), with no transaction-scoped twin. So this module
 * carries only the *pure* portion of the postgres-core split:
 *
 *   - SQLite row type interfaces for the three core tables
 *     (`workflow_runs`, `workflow_run_steps`, `workflow_events`).
 *   - Pure row mappers (`mapRunRow`, `mapStepRow`, `mapEventRow`) that take
 *     a `MapperContext = { component, logger }` and route every JSON-column
 *     parse through the shared `safeParseField` / `safeParseOptionalField`
 *     helpers. Corruption is reported via the configured logger with safe
 *     metadata only — the raw value is never logged (audit M2 / L3, PR #52).
 *
 * No abstract base class is needed: the adapter class binds the prepared
 * statements + better-sqlite3 connection in one place and would gain nothing
 * from inheritance. The mappers and row types are extracted purely so they
 * are reusable, testable, and consistent with `postgres-core.ts`.
 */

import {
  safeParseField as sharedSafeParseField,
  safeParseOptionalField as sharedSafeParseOptionalField,
  type MapperContext,
  type SafeJsonParseContext,
} from '../utils/safe-json';
import type {
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  WorkflowEventRecord,
} from './types';
import type { RunStatus, StepStatus, WorkflowError } from '../core/types';

/**
 * Re-export the shared `MapperContext` so callers can `import { MapperContext }`
 * from either storage core module.
 */
export type { MapperContext };

// ============================================================================
// SQLite row types
// ============================================================================
//
// SQLite stores everything as text/integer/real, so timestamps come back as
// ISO-8601 strings (the adapter writes them via `Date.prototype.toISOString`)
// and JSON columns come back as the original `JSON.stringify` output. The
// mappers below convert each row back to the public record shape.

/** Row shape for the `workflow_runs` table. */
export interface SQLiteRunRow {
  id: string;
  kind: string;
  status: string;
  parent_run_id: string | null;
  input_json: string;
  metadata_json: string;
  context_json: string;
  completed_steps_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Row shape for the `workflow_run_steps` table. */
export interface SQLiteStepRow {
  id: string;
  run_id: string;
  step_key: string;
  step_name: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** Row shape for the `workflow_events` table. */
export interface SQLiteEventRow {
  id: string;
  run_id: string;
  step_key: string | null;
  event_type: string;
  level: string;
  payload_json: string | null;
  timestamp: string;
}

// ============================================================================
// Row mappers (pure)
// ============================================================================
//
// Adapters supply a `MapperContext` ({ component, logger }); each helper
// extends it with the row id and column being parsed so a structured log
// emitted on corruption identifies the bad row. The raw value is never
// logged — see `src/utils/safe-json.ts`.

/** Map a `workflow_runs` row to the public `WorkflowRunRecord` shape. */
export function mapRunRow(row: SQLiteRunRow, ctx: MapperContext): WorkflowRunRecord {
  const fieldCtx = (column: string): SafeJsonParseContext => ({ ...ctx, rowId: row.id, column });
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as RunStatus,
    parentRunId: row.parent_run_id ?? undefined,
    input: sharedSafeParseField(row.input_json, {}, fieldCtx('input_json')) as Record<string, unknown>,
    metadata: sharedSafeParseField(row.metadata_json, {}, fieldCtx('metadata_json')) as Record<string, unknown>,
    context: sharedSafeParseField(row.context_json, {}, fieldCtx('context_json')) as Record<string, unknown>,
    completedSteps: sharedSafeParseOptionalField(row.completed_steps_json, fieldCtx('completed_steps_json')) as string[] | undefined,
    error: sharedSafeParseOptionalField(row.error_json, fieldCtx('error_json')) as WorkflowError | undefined,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
  };
}

/** Map a `workflow_run_steps` row to the public `WorkflowRunStepRecord` shape. */
export function mapStepRow(row: SQLiteStepRow, ctx: MapperContext): WorkflowRunStepRecord {
  const fieldCtx = (column: string): SafeJsonParseContext => ({ ...ctx, rowId: row.id, column });
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    stepName: row.step_name,
    status: row.status as StepStatus,
    attempt: row.attempt,
    result: sharedSafeParseOptionalField(row.result_json, fieldCtx('result_json')),
    error: sharedSafeParseOptionalField(row.error_json, fieldCtx('error_json')) as WorkflowError | undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
  };
}

/** Map a `workflow_events` row to the public `WorkflowEventRecord` shape. */
export function mapEventRow(row: SQLiteEventRow, ctx: MapperContext): WorkflowEventRecord {
  const fieldCtx: SafeJsonParseContext = { ...ctx, rowId: row.id, column: 'payload_json' };
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key ?? undefined,
    eventType: row.event_type,
    level: row.level as 'info' | 'warn' | 'error',
    payload: sharedSafeParseOptionalField(row.payload_json, fieldCtx),
    timestamp: new Date(row.timestamp),
  };
}
