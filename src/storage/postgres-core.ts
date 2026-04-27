/**
 * Shared core for the PostgreSQL storage adapters.
 *
 * `PostgresStorageAdapter` (the public, pool-owning adapter) and
 * `PostgresTransactionAdapter` (the in-transaction wrapper used by
 * `PostgresStorageAdapter.transaction()`) both implement the same CRUD subset
 * of `StorageAdapter`. Before this refactor they each carried their own copy
 * of every CRUD method, every row mapper, and every JSON-parse helper. The
 * only meaningful difference between them is which Kysely query builder they
 * target — an instance-bound one (`db.withSchema(schema)`) versus a
 * transaction-bound one (`trx.withSchema(schema)`).
 *
 * This module collapses that duplication:
 *
 *   - Pure helpers (`safeJsonParse`, `safeParseField`, `safeParseOptionalField`,
 *     row mappers, `applyRunsFilters`) live as standalone functions so callers
 *     can use them directly without inheritance.
 *
 *   - `PostgresStorageCore` is an abstract base class that implements the
 *     CRUD subset of `StorageAdapter` against an abstract `qb` accessor and
 *     an `ensureReady()` hook. Subclasses supply the schema-scoped query
 *     builder (and an optional pre-call guard, e.g.
 *     `PostgresStorageAdapter.ensureInitialized()`).
 *
 * No behavior change: every query and every JSON-parse path matches the
 * previous in-line implementations. The C2 transaction-pagination fix
 * (same-connection COUNT(*)) is preserved by the shared `listRuns`
 * implementation. The C1 migration error-propagation fix lives on
 * `PostgresStorageAdapter` and is unaffected by this module.
 */

import type { Kysely as KyselyType } from 'kysely';
import { generateId } from '../utils/id.js';
import { requirePostgresDeps } from '../utils/postgres-deps.js';
import { sanitizeErrorForStorage } from '../utils/logger.js';
import type {
  StorageAdapter,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  WorkflowEventRecord,
  ListRunsOptions,
  ListEventsOptions,
  PaginatedResult,
  CreateRunInput,
  UpdateRunInput,
} from './types.js';
import type { RunStatus, StepStatus, WorkflowError } from '../core/types.js';

// ============================================================================
// Database row types (re-declared here so postgres-core.ts is self-contained;
// they mirror the table definitions in postgres.ts)
// ============================================================================

/** Kysely row type for the workflow_runs table. */
export interface WorkflowRunsTable {
  id: string;
  kind: string;
  status: string;
  parent_run_id: string | null;
  input_json: string;
  metadata_json: string;
  context_json: string;
  output_json: string | null;
  error_json: string | null;
  priority: number;
  timeout_ms: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Kysely row type for the workflow_run_steps table. */
export interface WorkflowRunStepsTable {
  id: string;
  run_id: string;
  step_key: string;
  step_name: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Kysely row type for the workflow_events table. */
export interface WorkflowEventsTable {
  id: string;
  run_id: string;
  step_key: string | null;
  event_type: string;
  level: string;
  payload_json: string | null;
  timestamp: Date;
}

/** Combined Kysely schema covering the tables touched by the shared core. */
export interface PostgresCoreDatabase {
  runs: WorkflowRunsTable;
  workflow_run_steps: WorkflowRunStepsTable;
  workflow_events: WorkflowEventsTable;
}

/** Schema-scoped query builder produced by `db.withSchema(schemaName)`. */
export type SchemaQueryBuilder = ReturnType<KyselyType<PostgresCoreDatabase>['withSchema']>;

// ============================================================================
// JSON-parse helpers (pure)
// ============================================================================

/**
 * Parse a JSON string, falling back to `fallback` on `SyntaxError`. Other
 * errors are rethrown so they aren't silently swallowed. Logs a warning when
 * a corrupt row is encountered, tagged with `label` so the source class is
 * identifiable.
 */
export function safeJsonParse(json: string, fallback: unknown, label: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`[${label}] Corrupted JSON in database row, using fallback:`, error.message);
      return fallback;
    }
    throw error;
  }
}

/** Parse a column value if it's still a JSON string; pass through otherwise. */
export function safeParseField(value: unknown, fallback: unknown, label: string): unknown {
  if (typeof value === 'string') {
    return safeJsonParse(value, fallback, label);
  }
  return value;
}

/** Same as `safeParseField` but returns `undefined` for falsy/missing values. */
export function safeParseOptionalField(value: unknown, label: string): unknown {
  if (!value) return undefined;
  if (typeof value === 'string') {
    return safeJsonParse(value, undefined, label);
  }
  return value;
}

// ============================================================================
// Row mappers (pure)
// ============================================================================

/** Map a `runs` row to the public `WorkflowRunRecord` shape. */
export function mapRunRow(row: WorkflowRunsTable, label: string): WorkflowRunRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as RunStatus,
    parentRunId: row.parent_run_id ?? undefined,
    input: safeParseField(row.input_json, {}, label) as Record<string, unknown>,
    context: safeParseField(row.context_json, {}, label) as Record<string, unknown>,
    output: safeParseOptionalField(row.output_json, label) as Record<string, unknown> | undefined,
    error: safeParseOptionalField(row.error_json, label) as WorkflowError | undefined,
    metadata: safeParseField(row.metadata_json, {}, label) as Record<string, unknown>,
    priority: row.priority ?? 0,
    timeoutMs: row.timeout_ms ?? undefined,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
  };
}

/** Map a `workflow_run_steps` row to the public `WorkflowRunStepRecord` shape. */
export function mapStepRow(row: WorkflowRunStepsTable, label: string): WorkflowRunStepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    stepName: row.step_name,
    status: row.status as StepStatus,
    attempt: row.attempt,
    result: safeParseOptionalField(row.result_json, label),
    error: safeParseOptionalField(row.error_json, label) as WorkflowError | undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
  };
}

/** Map a `workflow_events` row to the public `WorkflowEventRecord` shape. */
export function mapEventRow(row: WorkflowEventsTable, label: string): WorkflowEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key ?? undefined,
    eventType: row.event_type,
    level: row.level as 'info' | 'warn' | 'error',
    payload: safeParseOptionalField(row.payload_json, label),
    timestamp: new Date(row.timestamp),
  };
}

// ============================================================================
// Filter helpers (pure)
// ============================================================================

/**
 * Apply the common `kind`/`status`/`parentRunId` filters from `ListRunsOptions`
 * to a Kysely select query. Used by both the data and count queries in
 * `listRuns` so they share exactly the same WHERE clause.
 */
export function applyRunsFilters<T extends { where(col: any, op: any, val: any): T }>(
  query: T,
  options: ListRunsOptions,
): T {
  if (options.kind) {
    query = query.where('kind', '=', options.kind);
  }
  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    query = query.where('status', 'in', statuses);
  }
  if (options.parentRunId !== undefined) {
    query = query.where('parent_run_id', '=', options.parentRunId);
  }
  return query;
}

// ============================================================================
// Shared base class
// ============================================================================

/**
 * Abstract base implementing the CRUD subset of `StorageAdapter` against a
 * schema-scoped Kysely query builder. Subclasses must provide the query
 * builder via `qb` and may override `ensureReady()` to gate calls (the
 * pool-owning adapter uses this to enforce `initialize()` having run).
 *
 * The base class deliberately does **not** own the connection pool, schema
 * migrations, or transaction control — those stay with `PostgresStorageAdapter`.
 */
export abstract class PostgresStorageCore implements StorageAdapter {
  protected constructor(protected readonly schema: string) {}

  /** Schema-scoped query builder. Subclasses return the bound builder. */
  protected abstract get qb(): SchemaQueryBuilder;

  /** Tag used in `console.warn` messages when corrupt rows are encountered. */
  protected abstract get warnLabel(): string;

  /**
   * Hook called at the start of every CRUD method. The pool-owning adapter
   * overrides this to throw before `initialize()` has run; the transaction
   * wrapper leaves it as a no-op.
   */
  protected ensureReady(): void {}

  // --------------------------------------------------------------------------
  // Run operations
  // --------------------------------------------------------------------------

  async createRun(
    run: CreateRunInput | Omit<WorkflowRunRecord, 'id' | 'createdAt'>,
  ): Promise<WorkflowRunRecord> {
    this.ensureReady();
    const id = 'id' in run && run.id ? run.id : generateId();
    const createdAt = new Date();

    await this.qb
      .insertInto('runs')
      .values({
        id,
        kind: run.kind,
        status: run.status,
        parent_run_id: 'parentRunId' in run ? (run.parentRunId ?? null) : null,
        input_json: JSON.stringify(run.input),
        metadata_json: JSON.stringify(run.metadata ?? {}),
        context_json: JSON.stringify(run.context ?? {}),
        output_json: null,
        error_json:
          'error' in run && run.error
            ? JSON.stringify(sanitizeErrorForStorage(run.error))
            : null,
        priority: 'priority' in run ? (run.priority ?? 0) : 0,
        timeout_ms: 'timeoutMs' in run ? (run.timeoutMs ?? null) : null,
        created_at: createdAt,
        started_at: null,
        finished_at: null,
      })
      .execute();

    return {
      id,
      kind: run.kind,
      status: run.status as RunStatus,
      parentRunId: 'parentRunId' in run ? run.parentRunId : undefined,
      input: run.input,
      context: run.context ?? {},
      output: undefined,
      error: undefined,
      metadata: run.metadata ?? {},
      priority: 'priority' in run ? (run.priority ?? 0) : 0,
      timeoutMs: 'timeoutMs' in run ? run.timeoutMs : undefined,
      createdAt,
    };
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    this.ensureReady();
    const row = await this.qb
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    return row ? mapRunRow(row as WorkflowRunsTable, this.warnLabel) : null;
  }

  async updateRun(
    runId: string,
    updates: UpdateRunInput | Partial<WorkflowRunRecord>,
  ): Promise<void> {
    this.ensureReady();
    const updateData: Partial<WorkflowRunsTable> = {};

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.context !== undefined) {
      updateData.context_json = JSON.stringify(updates.context);
    }
    if ('output' in updates && updates.output !== undefined) {
      updateData.output_json = JSON.stringify(updates.output);
    }
    if (updates.error !== undefined) {
      updateData.error_json = JSON.stringify(
        sanitizeErrorForStorage(updates.error as WorkflowError),
      );
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt;
    }
    if (updates.finishedAt !== undefined) {
      updateData.finished_at = updates.finishedAt;
    }

    if (Object.keys(updateData).length > 0) {
      await this.qb
        .updateTable('runs')
        .set(updateData)
        .where('id', '=', runId)
        .execute();
    }
  }

  async listRuns(
    options: ListRunsOptions = {},
  ): Promise<PaginatedResult<WorkflowRunRecord>> {
    this.ensureReady();
    const { sql } = requirePostgresDeps();
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    // Same-connection COUNT(*) so totals reflect rows visible to this builder
    // (preserves the C2 transaction-pagination fix from PR #47).
    const countQuery = applyRunsFilters(
      this.qb.selectFrom('runs').select(sql<number>`count(*)`.as('count')),
      options,
    );
    const dataQuery = applyRunsFilters(this.qb.selectFrom('runs').selectAll(), options);

    const orderBy = options.orderBy ?? 'createdAt';
    const orderDirection = options.orderDirection ?? 'desc';
    const orderColumn =
      orderBy === 'createdAt'
        ? 'created_at'
        : orderBy === 'startedAt'
          ? 'started_at'
          : 'finished_at';

    const countResult = (await countQuery.executeTakeFirst()) as
      | { count?: string | number }
      | undefined;
    const total = Number(countResult?.count ?? 0);

    const rows = await dataQuery
      .orderBy(orderColumn, orderDirection)
      .limit(limit)
      .offset(offset)
      .execute();

    return {
      items: rows.map((row) => mapRunRow(row as WorkflowRunsTable, this.warnLabel)),
      total,
    };
  }

  // --------------------------------------------------------------------------
  // Step operations
  // --------------------------------------------------------------------------

  async createStep(
    step: Omit<WorkflowRunStepRecord, 'id'>,
  ): Promise<WorkflowRunStepRecord> {
    this.ensureReady();
    const id = generateId();

    await this.qb
      .insertInto('workflow_run_steps')
      .values({
        id,
        run_id: step.runId,
        step_key: step.stepKey,
        step_name: step.stepName,
        status: step.status,
        attempt: step.attempt,
        result_json: step.result !== undefined ? JSON.stringify(step.result) : null,
        error_json: step.error
          ? JSON.stringify(sanitizeErrorForStorage(step.error))
          : null,
        started_at: step.startedAt ?? null,
        finished_at: step.finishedAt ?? null,
      })
      .execute();

    return { ...step, id };
  }

  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    this.ensureReady();
    const row = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('id', '=', stepId)
      .executeTakeFirst();

    return row ? mapStepRow(row as WorkflowRunStepsTable, this.warnLabel) : null;
  }

  async updateStep(
    stepId: string,
    updates: Partial<WorkflowRunStepRecord>,
  ): Promise<void> {
    this.ensureReady();
    const updateData: Partial<WorkflowRunStepsTable> = {};

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.attempt !== undefined) {
      updateData.attempt = updates.attempt;
    }
    if (updates.result !== undefined) {
      updateData.result_json = JSON.stringify(updates.result);
    }
    if (updates.error !== undefined) {
      updateData.error_json = JSON.stringify(
        sanitizeErrorForStorage(updates.error as WorkflowError),
      );
    }
    if (updates.finishedAt !== undefined) {
      updateData.finished_at = updates.finishedAt;
    }

    if (Object.keys(updateData).length > 0) {
      await this.qb
        .updateTable('workflow_run_steps')
        .set(updateData)
        .where('id', '=', stepId)
        .execute();
    }
  }

  async getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]> {
    this.ensureReady();
    const rows = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc')
      .execute();

    return rows.map((row) => mapStepRow(row as WorkflowRunStepsTable, this.warnLabel));
  }

  // --------------------------------------------------------------------------
  // Event operations
  // --------------------------------------------------------------------------

  async saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void> {
    this.ensureReady();
    const id = generateId();

    await this.qb
      .insertInto('workflow_events')
      .values({
        id,
        run_id: event.runId,
        step_key: event.stepKey ?? null,
        event_type: event.eventType,
        level: event.level,
        payload_json: event.payload !== undefined ? JSON.stringify(event.payload) : null,
        timestamp: event.timestamp,
      })
      .execute();
  }

  async getEventsForRun(
    runId: string,
    options: ListEventsOptions = {},
  ): Promise<WorkflowEventRecord[]> {
    this.ensureReady();
    const limit = options.limit ?? 1000;
    const offset = options.offset ?? 0;

    let query = this.qb
      .selectFrom('workflow_events')
      .selectAll()
      .where('run_id', '=', runId);

    if (options.stepKey) {
      query = query.where('step_key', '=', options.stepKey);
    }
    if (options.level) {
      query = query.where('level', '=', options.level);
    }

    query = query.orderBy('timestamp', 'asc').limit(limit).offset(offset);

    const rows = await query.execute();

    return rows.map((row) => mapEventRow(row as WorkflowEventsTable, this.warnLabel));
  }
}
