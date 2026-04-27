/**
 * PostgreSQL storage adapter using Kysely.
 *
 * Provides durable persistence for workflow runs, steps, and events with
 * support for distributed deployments and connection pooling.
 *
 * ## Module layout
 *
 *   - `PostgresStorageAdapter` (this file) owns the `pg.Pool` / Kysely
 *     instance, runs schema migrations on `initialize()`, and implements all
 *     non-CRUD methods: connection lifecycle (`close`, `transaction`),
 *     workflow-level operations (`dequeueRun`, `cleanupStaleRuns`,
 *     `markRunsAsFailed`, `getStats`, `deleteRun`, `deleteOldRuns`,
 *     `getInterruptedRuns`, `getLastCompletedStep`), and the
 *     `stepflow_step_results` accessors.
 *
 *   - `PostgresTransactionAdapter` (this file) is a thin shell used by
 *     `PostgresStorageAdapter.transaction()`. It binds a transaction-scoped
 *     Kysely query builder; everything else comes from the shared core.
 *     Exported only for regression tests.
 *
 *   - `PostgresStorageCore` (./postgres-core.ts) holds the shared CRUD
 *     methods (`createRun`, `getRun`, `updateRun`, `listRuns`, `createStep`,
 *     `getStep`, `updateStep`, `getStepsForRun`, `saveEvent`,
 *     `getEventsForRun`), the row mappers, and the JSON-parse helpers. Both
 *     classes here extend it.
 */

import type { Kysely as KyselyType } from 'kysely';
import type { Pool, PoolConfig } from 'pg';
import { loadPostgresDeps } from '../utils/postgres-deps.js';

// Lazy-loaded dependencies - populated by loadPostgresDeps() during initialize()
let Kysely: any;
let PostgresDialect: any;
let sql: any;
let pgModule: any;
import { generateId } from '../utils/id.js';
import type {
  StorageAdapter,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  StepResult,
  ExtendedStepStatus,
} from './types.js';
import {
  PostgresStorageCore,
  mapRunRow,
  mapStepRow,
  safeParseOptionalField,
  type CoreSchemaQueryBuilder,
  type PostgresCoreDatabase,
  type SchemaQueryBuilder,
  type WorkflowRunsTable,
  type WorkflowRunStepsTable,
} from './postgres-core.js';

/** Strip `stack` from a generic error record before persistence. */
function stripStack<T extends Record<string, unknown>>(error: T): Omit<T, 'stack'> {
  const { stack: _stack, ...rest } = error;
  return rest as Omit<T, 'stack'>;
}

// ============================================================================
// Database Types (Kysely schema)
// ============================================================================
//
// The `runs`, `workflow_run_steps`, and `workflow_events` table shapes live
// in `./postgres-core.ts` so the shared CRUD core can target them without
// re-declaration. The full `StepflowDatabase` schema below adds the
// adapter-only `stepflow_step_results` table (extended storage).

/** Kysely row type for the stepflow_step_results table (extended storage). */
interface StepflowStepResultsTable {
  id: string;
  /** Foreign key to runs.id. */
  run_id: string;
  /** Step name identifier. */
  step_name: string;
  /** Current step status (maps to ExtendedStepStatus). */
  status: string;
  /** JSON-serialized step output, null until step completes. */
  output_json: string | null;
  /** JSON-serialized error object, null unless step failed. */
  error_json: string | null;
  /** Current retry attempt number (1-based). */
  attempt: number;
  started_at: Date | null;
  completed_at: Date | null;
}

interface StepflowDatabase extends PostgresCoreDatabase {
  stepflow_step_results: StepflowStepResultsTable;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration options for the PostgreSQL storage adapter.
 */
export interface PostgresStorageConfig {
  /**
   * PostgreSQL connection string.
   * Example: "postgresql://user:pass@localhost:5432/dbname"
   */
  connectionString?: string;

  /**
   * Existing pg.Pool instance for connection sharing with application.
   * If provided, the adapter will not close this pool on close().
   */
  pool?: Pool;

  /**
   * Pool configuration options (if not providing pool or connectionString).
   */
  poolConfig?: PoolConfig;

  /**
   * Schema name for Stepflow tables.
   * @default 'public'
   */
  schema?: string;

  /**
   * Automatically create tables on initialize().
   * @default true
   */
  autoMigrate?: boolean;
}

// ============================================================================
// PostgreSQL Storage Adapter
// ============================================================================

/**
 * PostgreSQL implementation of StorageAdapter using Kysely.
 *
 * Features:
 * - Connection pooling (shared or dedicated)
 * - Automatic table creation
 * - Transaction support
 * - Atomic dequeue operations for distributed workers
 * - JSONB storage for flexible data
 *
 * @example
 * ```typescript
 * import { PostgresStorageAdapter } from 'stepflow/storage';
 *
 * const storage = new PostgresStorageAdapter({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * await storage.initialize();
 *
 * const engine = new WorkflowEngine({ storage });
 * ```
 *
 * @example Sharing connection pool
 * ```typescript
 * import pg from 'pg';
 * import { PostgresStorageAdapter } from 'stepflow/storage';
 *
 * // Application's existing pool
 * const pool = new pg.Pool({
 *   connectionString: process.env.DATABASE_URL,
 *   max: 20,
 * });
 *
 * // Share with Stepflow
 * const storage = new PostgresStorageAdapter({ pool });
 * ```
 */
export class PostgresStorageAdapter extends PostgresStorageCore {
  private db!: KyselyType<StepflowDatabase>;
  private pool!: Pool;
  private ownsPool = false;
  private autoMigrate: boolean;
  private initialized = false;
  private config: PostgresStorageConfig;

  constructor(config: PostgresStorageConfig) {
    const schema = config.schema ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) {
      throw new Error(
        `Invalid schema name "${schema}". Schema must start with a letter or underscore, ` +
        `contain only alphanumeric characters and underscores, and be at most 63 characters.`
      );
    }
    super(schema);
    this.autoMigrate = config.autoMigrate !== false;
    this.config = config;
  }

  /**
   * Core-tables query builder consumed by `PostgresStorageCore`. Returns the
   * schema-scoped Kysely view typed against the three core tables, which is
   * what the shared CRUD methods need.
   */
  protected override get qb(): CoreSchemaQueryBuilder {
    return this.db.withSchema(this.schema) as unknown as CoreSchemaQueryBuilder;
  }

  /**
   * Extended query builder for adapter-only tables (currently
   * `stepflow_step_results`). Kept separate from `qb` so the base class stays
   * typed against the core schema.
   */
  private get extQb(): SchemaQueryBuilder<StepflowDatabase> {
    return this.db.withSchema(this.schema);
  }

  /** Tag used by shared row mappers in `console.warn` messages. */
  protected override get warnLabel(): string {
    return 'PostgresStorageAdapter';
  }

  /** Override of `PostgresStorageCore.ensureReady()` — enforces `initialize()`. */
  protected override ensureReady(): void {
    this.ensureInitialized();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'PostgresStorageAdapter is not initialized. Call initialize() before using the adapter.'
      );
    }
  }

  /**
   * Initialize the storage adapter.
   * Creates tables if autoMigrate is enabled.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const deps = await loadPostgresDeps();
    Kysely = deps.Kysely;
    PostgresDialect = deps.PostgresDialect;
    sql = deps.sql;
    pgModule = deps.pgModule;

    if (this.config.pool) {
      this.pool = this.config.pool;
      this.ownsPool = false;
    } else if (this.config.connectionString) {
      this.pool = new pgModule.Pool({ connectionString: this.config.connectionString });
      this.ownsPool = true;
    } else if (this.config.poolConfig) {
      this.pool = new pgModule.Pool(this.config.poolConfig);
      this.ownsPool = true;
    } else {
      throw new Error(
        'PostgresStorageConfig must include either pool, connectionString, or poolConfig'
      );
    }

    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: this.pool,
      }),
    });

    if (this.autoMigrate) {
      await this.createTables();
    }

    this.initialized = true;
  }

  /**
   * Close the database connection.
   * Only closes the pool if it was created by this adapter.
   */
  async close(): Promise<void> {
    await this.db.destroy();
    // Kysely's destroy() already calls pool.end() via PostgresDialect,
    // so we must NOT call pool.end() again.
  }

  // ============================================================================
  // Schema Creation
  // ============================================================================

  /**
   * Run a single migration step. Tolerates only known-benign Postgres errors
   * (duplicate object codes that map to "already applied"), and rethrows
   * everything else with a clear message so partial-state upgrades are not
   * silently swallowed.
   */
  protected async runMigration(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (PostgresStorageAdapter.isBenignMigrationError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Schema migration failed (${label}): ${message}`, { cause: err });
    }
  }

  /**
   * Postgres SQLSTATE codes that indicate a migration step has already been
   * applied (object already exists). These are safe to ignore on idempotent
   * re-runs; everything else must propagate.
   *
   * - 42701: duplicate_column
   * - 42P07: duplicate_table
   * - 42P06: duplicate_schema
   * - 42710: duplicate_object (e.g., index, constraint)
   */
  private static readonly BENIGN_MIGRATION_CODES = new Set([
    '42701',
    '42P07',
    '42P06',
    '42710',
  ]);

  private static isBenignMigrationError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && PostgresStorageAdapter.BENIGN_MIGRATION_CODES.has(code);
  }

  /**
   * Create the workflow tables if they don't exist.
   */
  private async createTables(): Promise<void> {
    // Create schema if not public
    if (this.schema !== 'public') {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);
    }

    // Create runs table with new columns
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.runs`)} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        input_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        context_json JSONB NOT NULL DEFAULT '{}',
        output_json JSONB,
        error_json JSONB,
        priority INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT runs_status_check CHECK (
          status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timeout')
        )
      )
    `.execute(this.db);

    // Add new columns if they don't exist (for migrations)
    await this.runMigration(
      `add columns to ${this.schema}.runs`,
      () => sql`
        ALTER TABLE ${sql.table(`${this.schema}.runs`)}
        ADD COLUMN IF NOT EXISTS output_json JSONB,
        ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS timeout_ms INTEGER
      `.execute(this.db)
    );

    // Create indexes for runs
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_kind_status
      ON ${sql.table(`${this.schema}.runs`)} (kind, status)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_parent
      ON ${sql.table(`${this.schema}.runs`)} (parent_run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_created
      ON ${sql.table(`${this.schema}.runs`)} (created_at DESC)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_status
      ON ${sql.table(`${this.schema}.runs`)} (status)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_priority
      ON ${sql.table(`${this.schema}.runs`)} (priority DESC, created_at ASC)
    `.execute(this.db);

    // Create workflow_run_steps table (legacy)
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_run_steps`)} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.runs`)} (id) ON DELETE CASCADE,
        step_key TEXT NOT NULL,
        step_name TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        result_json JSONB,
        error_json JSONB,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT workflow_run_steps_status_check CHECK (
          status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'completed')
        )
      )
    `.execute(this.db);

    // Create indexes for workflow_run_steps
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run
      ON ${sql.table(`${this.schema}.workflow_run_steps`)} (run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_key
      ON ${sql.table(`${this.schema}.workflow_run_steps`)} (run_id, step_key)
    `.execute(this.db);

    // Create stepflow_step_results table (new)
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.stepflow_step_results`)} (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.runs`)} (id) ON DELETE CASCADE,
        step_name TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json JSONB,
        error_json JSONB,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        CONSTRAINT stepflow_step_results_status_check CHECK (
          status IN ('pending', 'running', 'completed', 'failed', 'skipped')
        ),
        UNIQUE (run_id, step_name)
      )
    `.execute(this.db);

    // Create indexes for stepflow_step_results
    await sql`
      CREATE INDEX IF NOT EXISTS idx_stepflow_step_results_run
      ON ${sql.table(`${this.schema}.stepflow_step_results`)} (run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_stepflow_step_results_run_name
      ON ${sql.table(`${this.schema}.stepflow_step_results`)} (run_id, step_name)
    `.execute(this.db);

    // Create workflow_events table
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_events`)} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.runs`)} (id) ON DELETE CASCADE,
        step_key TEXT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json JSONB,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workflow_events_level_check CHECK (
          level IN ('info', 'warn', 'error')
        )
      )
    `.execute(this.db);

    // Create indexes for workflow_events
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run
      ON ${sql.table(`${this.schema}.workflow_events`)} (run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run_ts
      ON ${sql.table(`${this.schema}.workflow_events`)} (run_id, timestamp)
    `.execute(this.db);
  }

  // ============================================================================
  // Run / Step / Event CRUD
  // ============================================================================
  //
  // The CRUD methods (`createRun`, `getRun`, `updateRun`, `listRuns`,
  // `createStep`, `getStep`, `updateStep`, `getStepsForRun`, `saveEvent`,
  // `getEventsForRun`) are inherited from `PostgresStorageCore`. Each call
  // routes through `this.qb` (overridden above) and `this.ensureReady()`
  // which calls `this.ensureInitialized()`.

  // ============================================================================
  // Transaction Support
  // ============================================================================

  /**
   * Execute a function within a database transaction.
   */
  async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    this.ensureInitialized();
    return await this.db.transaction().execute(async (trx) => {
      // Create a transactional adapter wrapper
      const txAdapter = new PostgresTransactionAdapter(trx, this.schema);
      return await fn(txAdapter);
    });
  }

  // ============================================================================
  // Cleanup Operations
  // ============================================================================

  /**
   * Delete runs older than the specified date.
   * Also deletes associated steps and events (via CASCADE).
   */
  async deleteOldRuns(olderThan: Date): Promise<number> {
    this.ensureInitialized();
    const result = await this.qb
      .deleteFrom('runs')
      .where('created_at', '<', olderThan)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  // ============================================================================
  // Resume Support
  // ============================================================================

  /**
   * Get all runs that were interrupted (status is 'running' or 'queued').
   * These runs can potentially be resumed.
   */
  async getInterruptedRuns(): Promise<WorkflowRunRecord[]> {
    this.ensureInitialized();
    const rows = await this.qb
      .selectFrom('runs')
      .selectAll()
      .where('status', 'in', ['queued', 'running'])
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map(row => mapRunRow(row as WorkflowRunsTable, this.warnLabel));
  }

  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId: string): Promise<WorkflowRunStepRecord | null> {
    this.ensureInitialized();
    const row = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .where('status', '=', 'succeeded')
      .orderBy('finished_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row ? mapStepRow(row as WorkflowRunStepsTable, this.warnLabel) : null;
  }

  // ============================================================================
  // Atomic Dequeue (for distributed workers)
  // ============================================================================

  /**
   * Atomically dequeue a run for processing.
   * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
   *
   * @param workflowKinds - Optional list of workflow kinds to filter by
   * @returns The dequeued run, or null if no runs are available
   */
  async dequeueRun(workflowKinds?: string[]): Promise<WorkflowRunRecord | null> {
    this.ensureInitialized();
    // Use raw SQL for FOR UPDATE SKIP LOCKED
    const kindFilter = workflowKinds && workflowKinds.length > 0
      ? sql`AND kind = ANY(${workflowKinds}::text[])`
      : sql``;

    const result = await sql<WorkflowRunsTable>`
      UPDATE ${sql.table(`${this.schema}.runs`)}
      SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM ${sql.table(`${this.schema}.runs`)}
        WHERE status = 'queued' ${kindFilter}
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `.execute(this.db);

    const row = result.rows[0];
    return row ? mapRunRow(row, this.warnLabel) : null;
  }

  // ============================================================================
  // Row Mapping (adapter-only tables)
  // ============================================================================
  //
  // Mappers and JSON-parse helpers for the three core tables live in
  // `./postgres-core.ts`. The single mapper kept here covers
  // `stepflow_step_results`, the only table outside the core schema.

  private mapStepResultRow(row: StepflowStepResultsTable): StepResult {
    return {
      id: row.id,
      runId: row.run_id,
      stepName: row.step_name,
      status: row.status as ExtendedStepStatus,
      output: safeParseOptionalField(row.output_json, this.warnLabel) as
        | Record<string, unknown>
        | undefined,
      error: safeParseOptionalField(row.error_json, this.warnLabel) as
        | Record<string, unknown>
        | undefined,
      attempt: row.attempt,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }

  // ============================================================================
  // New WorkflowStorage Methods
  // ============================================================================

  /**
   * Delete a workflow run by ID.
   * Also deletes associated steps and events (via CASCADE).
   */
  async deleteRun(id: string): Promise<void> {
    this.ensureInitialized();
    await this.qb
      .deleteFrom('runs')
      .where('id', '=', id)
      .execute();
  }

  /**
   * Cleanup stale runs that have exceeded their timeout.
   * Marks them as 'timeout' status with an appropriate error.
   *
   * @param defaultTimeoutMs - Default timeout in ms for runs without explicit timeout (default: 600000 = 10 minutes)
   * @returns Number of runs marked as timed out
   */
  async cleanupStaleRuns(defaultTimeoutMs: number = 600000): Promise<number> {
    this.ensureInitialized();
    const result = await sql<{ id: string }>`
      UPDATE ${sql.table(`${this.schema}.runs`)}
      SET
        status = 'timeout',
        error_json = jsonb_build_object(
          'code', 'WORKFLOW_TIMEOUT',
          'message', 'Workflow exceeded maximum execution time and was marked as timed out'
        ),
        finished_at = NOW()
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND (
          (timeout_ms IS NOT NULL AND started_at < NOW() - (timeout_ms || ' milliseconds')::interval)
          OR
          (timeout_ms IS NULL AND started_at < NOW() - (${defaultTimeoutMs} || ' milliseconds')::interval)
        )
      RETURNING id
    `.execute(this.db);

    return result.rows.length;
  }

  /**
   * Mark multiple runs as failed with a given reason.
   * Useful for cleanup when a worker shuts down unexpectedly.
   *
   * @param runIds - Array of run IDs to mark as failed
   * @param reason - Reason message for the failure
   */
  async markRunsAsFailed(runIds: string[], reason: string): Promise<void> {
    this.ensureInitialized();
    if (runIds.length === 0) return;

    await sql`
      UPDATE ${sql.table(`${this.schema}.runs`)}
      SET
        status = 'failed',
        error_json = jsonb_build_object(
          'code', 'WORKER_SHUTDOWN',
          'message', ${reason}
        ),
        finished_at = NOW()
      WHERE id = ANY(${runIds})
        AND status = 'running'
    `.execute(this.db);
  }

  /**
   * Get a specific step result by run ID and step name.
   */
  async getStepResult(runId: string, stepName: string): Promise<StepResult | undefined> {
    this.ensureInitialized();
    const row = await this.extQb
      .selectFrom('stepflow_step_results')
      .selectAll()
      .where('run_id', '=', runId)
      .where('step_name', '=', stepName)
      .executeTakeFirst();

    return row ? this.mapStepResultRow(row) : undefined;
  }

  /**
   * Get all step results for a run.
   */
  async getStepResults(runId: string): Promise<StepResult[]> {
    this.ensureInitialized();
    const rows = await this.extQb
      .selectFrom('stepflow_step_results')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc')
      .execute();

    return rows.map(row => this.mapStepResultRow(row));
  }

  /**
   * Save or update a step result.
   * Uses upsert to handle both new and existing results.
   */
  async saveStepResult(result: Omit<StepResult, 'id'> & { id?: string }): Promise<void> {
    this.ensureInitialized();
    const id = result.id ?? generateId();

    await this.extQb
      .insertInto('stepflow_step_results')
      .values({
        id,
        run_id: result.runId,
        step_name: result.stepName,
        status: result.status,
        output_json: result.output ? JSON.stringify(result.output) : null,
        error_json: result.error ? JSON.stringify(stripStack(result.error)) : null,
        attempt: result.attempt,
        started_at: result.startedAt ?? null,
        completed_at: result.completedAt ?? null,
      })
      .onConflict(oc =>
        oc.columns(['run_id', 'step_name']).doUpdateSet({
          status: result.status,
          output_json: result.output ? JSON.stringify(result.output) : null,
          error_json: result.error ? JSON.stringify(stripStack(result.error)) : null,
          attempt: result.attempt,
          started_at: result.startedAt ?? null,
          completed_at: result.completedAt ?? null,
        })
      )
      .execute();
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get database statistics.
   */
  async getStats(): Promise<{ runs: number; steps: number; events: number }> {
    this.ensureInitialized();
    const [runsCount, stepsCount, eventsCount] = await Promise.all([
      this.qb.selectFrom('runs').select(sql`count(*)`.as('count')).executeTakeFirst(),
      this.qb.selectFrom('workflow_run_steps').select(sql`count(*)`.as('count')).executeTakeFirst(),
      this.qb.selectFrom('workflow_events').select(sql`count(*)`.as('count')).executeTakeFirst(),
    ]) as { count?: string | number }[];

    return {
      runs: Number(runsCount?.count ?? 0),
      steps: Number(stepsCount?.count ?? 0),
      events: Number(eventsCount?.count ?? 0),
    };
  }
}

// ============================================================================
// Transaction Adapter (wraps Kysely transaction)
// ============================================================================

/**
 * A StorageAdapter wrapper for use within transactions.
 *
 * Used internally by `PostgresStorageAdapter.transaction()`. All CRUD methods
 * are inherited from `PostgresStorageCore`; this class only binds the
 * transaction-scoped query builder.
 *
 * Exported for regression testing; not part of the public API.
 */
export class PostgresTransactionAdapter extends PostgresStorageCore {
  private readonly _qb: CoreSchemaQueryBuilder;

  constructor(trx: KyselyType<StepflowDatabase>, schema: string) {
    super(schema);
    this._qb = trx.withSchema(schema) as unknown as CoreSchemaQueryBuilder;
  }

  protected override get qb(): CoreSchemaQueryBuilder {
    return this._qb;
  }

  protected override get warnLabel(): string {
    return 'PostgresTransactionAdapter';
  }
}

// Convenience aliases for shorter naming
export { PostgresStorageAdapter as PostgresStorage };
export type { PostgresStorageConfig as PostgresStorageOptions };
