/**
 * PostgreSQL storage adapter using Kysely.
 *
 * Provides durable persistence for workflow runs, steps, and events
 * with support for distributed deployments and connection pooling.
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
  WorkflowEventRecord,
  ListRunsOptions,
  ListEventsOptions,
  PaginatedResult,
  CreateRunInput,
  UpdateRunInput,
  StepResult,
  ExtendedWorkflowRunRecord,
  ExtendedRunStatus,
  ExtendedStepStatus,
} from './types.js';
import type { Logger, RunStatus, StepStatus, WorkflowError } from '../core/types.js';
import { sanitizeErrorForStorage } from '../utils/logger.js';
import { safeJsonParse as safeJsonParseShared } from '../utils/safe-json.js';

/** Strip `stack` from a generic error record before persistence. */
function stripStack<T extends Record<string, unknown>>(error: T): Omit<T, 'stack'> {
  const { stack: _stack, ...rest } = error;
  return rest as Omit<T, 'stack'>;
}

// ============================================================================
// Database Types (Kysely schema)
// ============================================================================

/** Kysely row type for the workflow_runs table. */
interface WorkflowRunsTable {
  id: string;
  /** Workflow kind identifier (e.g. 'order-processing'). */
  kind: string;
  /** Current run status (maps to RunStatus). */
  status: string;
  /** Parent run ID for child workflows, null for top-level runs. */
  parent_run_id: string | null;
  /** JSON-serialized input payload. */
  input_json: string;
  /** JSON-serialized arbitrary metadata. */
  metadata_json: string;
  /** JSON-serialized workflow context (accumulated step results). */
  context_json: string;
  /** JSON-serialized output payload, null until run completes. */
  output_json: string | null;
  /** JSON-serialized error object, null unless run failed. */
  error_json: string | null;
  /** Execution priority (lower number = higher precedence). */
  priority: number;
  /** Workflow-level timeout in milliseconds, null for no timeout. */
  timeout_ms: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Kysely row type for the workflow_run_steps table. */
interface WorkflowRunStepsTable {
  id: string;
  /** Foreign key to workflow_runs.id. */
  run_id: string;
  /** Unique step identifier within the workflow definition. */
  step_key: string;
  /** Human-readable step name. */
  step_name: string;
  /** Current step status (maps to StepStatus). */
  status: string;
  /** Current retry attempt number (1-based). */
  attempt: number;
  /** JSON-serialized step result, null until step completes. */
  result_json: string | null;
  /** JSON-serialized error object, null unless step failed. */
  error_json: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

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

/** Kysely row type for the workflow_events table. */
interface WorkflowEventsTable {
  id: string;
  /** Foreign key to workflow_runs.id. */
  run_id: string;
  /** Step key that emitted this event, null for run-level events. */
  step_key: string | null;
  /** Event type identifier (e.g. 'run.started', 'step.completed'). */
  event_type: string;
  /** Severity level: 'info', 'warn', or 'error'. */
  level: string;
  /** JSON-serialized event payload, null if no extra data. */
  payload_json: string | null;
  timestamp: Date;
}

interface StepflowDatabase {
  runs: WorkflowRunsTable;
  workflow_run_steps: WorkflowRunStepsTable;
  workflow_events: WorkflowEventsTable;
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

  /**
   * Optional structured logger used to surface JSON corruption events.
   * Without one, parse failures still increment the corruption counter
   * exposed via `getJsonParseCorruptionCount()` but produce no log output.
   */
  logger?: Logger;
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
export class PostgresStorageAdapter implements StorageAdapter {
  private db!: KyselyType<StepflowDatabase>;
  private pool!: Pool;
  private ownsPool = false;
  private schema: string;
  private autoMigrate: boolean;
  private initialized = false;
  private config: PostgresStorageConfig;
  private logger: Logger | undefined;

  constructor(config: PostgresStorageConfig) {
    this.schema = config.schema ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.schema)) {
      throw new Error(
        `Invalid schema name "${this.schema}". Schema must start with a letter or underscore, ` +
        `contain only alphanumeric characters and underscores, and be at most 63 characters.`
      );
    }
    this.autoMigrate = config.autoMigrate !== false;
    this.config = config;
    this.logger = config.logger;
  }

  /**
   * Get a schema-scoped query builder.
   * All queries MUST use this instead of this.db directly to respect config.schema.
   */
  private get qb() {
    return this.db.withSchema(this.schema);
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
  // Run Operations
  // ============================================================================

  /**
   * Create a new workflow run.
   * Supports both legacy and new CreateRunInput interfaces.
   */
  async createRun(run: CreateRunInput | Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord> {
    this.ensureInitialized();
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
        context_json: JSON.stringify(run.context ?? {}), // Default to empty object
        output_json: null,
        error_json: 'error' in run && run.error ? JSON.stringify(sanitizeErrorForStorage(run.error)) : null,
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
    this.ensureInitialized();
    const row = await this.qb
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    return row ? this.mapRunRow(row) : null;
  }

  /**
   * Update a workflow run.
   * Supports both legacy Partial<WorkflowRunRecord> and new UpdateRunInput interfaces.
   */
  async updateRun(runId: string, updates: UpdateRunInput | Partial<WorkflowRunRecord>): Promise<void> {
    this.ensureInitialized();
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
      updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error));
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

  /**
   * List workflow runs with filtering and pagination.
   */
  /**
   * Apply common run filters to a Kysely query builder.
   * Used by both the data query and count query in listRuns to avoid duplication.
   */
  private applyRunsFilters<T extends { where(col: any, op: any, val: any): T }>(
    query: T,
    options: ListRunsOptions
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

  async listRuns(options: ListRunsOptions = {}): Promise<PaginatedResult<WorkflowRunRecord>> {
    this.ensureInitialized();
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    let query = this.applyRunsFilters(
      this.qb.selectFrom('runs').selectAll(),
      options
    );

    const countQuery = this.applyRunsFilters(
      this.qb.selectFrom('runs').select(sql<number>`count(*)`.as('count')),
      options
    );

    const countResult = await countQuery.executeTakeFirst() as { count?: string | number } | undefined;
    const total = Number(countResult?.count ?? 0);

    // Order
    const orderBy = options.orderBy ?? 'createdAt';
    const orderDirection = options.orderDirection ?? 'desc';
    const orderColumn = orderBy === 'createdAt' ? 'created_at' :
                       orderBy === 'startedAt' ? 'started_at' : 'finished_at';

    query = query.orderBy(orderColumn, orderDirection);

    // Apply pagination
    query = query.limit(limit).offset(offset);

    const rows = await query.execute();

    return {
      items: rows.map(row => this.mapRunRow(row)),
      total,
    };
  }

  // ============================================================================
  // Step Operations
  // ============================================================================

  async createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord> {
    this.ensureInitialized();
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
        error_json: step.error ? JSON.stringify(sanitizeErrorForStorage(step.error)) : null,
        started_at: step.startedAt ?? null,
        finished_at: step.finishedAt ?? null,
      })
      .execute();

    return { ...step, id };
  }

  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    this.ensureInitialized();
    const row = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('id', '=', stepId)
      .executeTakeFirst();

    return row ? this.mapStepRow(row) : null;
  }

  async updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void> {
    this.ensureInitialized();
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
      updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error));
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
    this.ensureInitialized();
    const rows = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc')
      .execute();

    return rows.map(row => this.mapStepRow(row));
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  async saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void> {
    this.ensureInitialized();
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

  async getEventsForRun(runId: string, options: ListEventsOptions = {}): Promise<WorkflowEventRecord[]> {
    this.ensureInitialized();
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

    return rows.map(row => this.mapEventRow(row));
  }

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
      const txAdapter = new PostgresTransactionAdapter(trx, this.schema, this.logger);
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

    return rows.map(row => this.mapRunRow(row));
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

    return row ? this.mapStepRow(row) : null;
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
    return row ? this.mapRunRow(row) : null;
  }

  // ============================================================================
  // Row Mapping
  // ============================================================================

  /**
   * Parse a JSON column safely. On `SyntaxError`, the fallback is returned, a
   * structured warning is emitted via the configured logger (with safe metadata
   * only — never the raw value), and the global corruption counter is bumped.
   */
  private safeJsonParse(json: string, fallback: unknown, rowId?: string, column?: string): unknown {
    return safeJsonParseShared(json, fallback, {
      component: 'PostgresStorageAdapter',
      rowId,
      column,
      logger: this.logger,
    });
  }

  private safeParseField(value: unknown, fallback: unknown, rowId?: string, column?: string): unknown {
    if (typeof value === 'string') {
      return this.safeJsonParse(value, fallback, rowId, column);
    }
    return value;
  }

  private safeParseOptionalField(value: unknown, rowId?: string, column?: string): unknown {
    if (!value) return undefined;
    if (typeof value === 'string') {
      return this.safeJsonParse(value, undefined, rowId, column);
    }
    return value;
  }

  private mapRunRow(row: WorkflowRunsTable): WorkflowRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      parentRunId: row.parent_run_id ?? undefined,
      input: this.safeParseField(row.input_json, {}, row.id, 'input_json') as Record<string, unknown>,
      context: this.safeParseField(row.context_json, {}, row.id, 'context_json') as Record<string, unknown>,
      output: this.safeParseOptionalField(row.output_json, row.id, 'output_json') as Record<string, unknown> | undefined,
      error: this.safeParseOptionalField(row.error_json, row.id, 'error_json') as WorkflowError | undefined,
      metadata: this.safeParseField(row.metadata_json, {}, row.id, 'metadata_json') as Record<string, unknown>,
      priority: row.priority ?? 0,
      timeoutMs: row.timeout_ms ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  /**
   * Map a database row to an extended workflow run record.
   */
  private mapExtendedRunRow(row: WorkflowRunsTable): ExtendedWorkflowRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as ExtendedRunStatus,
      input: this.safeParseField(row.input_json, {}, row.id, 'input_json') as Record<string, unknown>,
      metadata: this.safeParseField(row.metadata_json, {}, row.id, 'metadata_json') as Record<string, unknown>,
      context: this.safeParseField(row.context_json, {}, row.id, 'context_json') as Record<string, unknown>,
      output: this.safeParseOptionalField(row.output_json, row.id, 'output_json') as Record<string, unknown> | undefined,
      error: this.safeParseOptionalField(row.error_json, row.id, 'error_json') as WorkflowError | undefined,
      priority: row.priority ?? 0,
      timeoutMs: row.timeout_ms ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapStepResultRow(row: StepflowStepResultsTable): StepResult {
    return {
      id: row.id,
      runId: row.run_id,
      stepName: row.step_name,
      status: row.status as ExtendedStepStatus,
      output: this.safeParseOptionalField(row.output_json, row.id, 'output_json') as Record<string, unknown> | undefined,
      error: this.safeParseOptionalField(row.error_json, row.id, 'error_json') as Record<string, unknown> | undefined,
      attempt: row.attempt,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }

  private mapStepRow(row: WorkflowRunStepsTable): WorkflowRunStepRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status as StepStatus,
      attempt: row.attempt,
      result: this.safeParseOptionalField(row.result_json, row.id, 'result_json'),
      error: this.safeParseOptionalField(row.error_json, row.id, 'error_json') as WorkflowError | undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapEventRow(row: WorkflowEventsTable): WorkflowEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? undefined,
      eventType: row.event_type,
      level: row.level as 'info' | 'warn' | 'error',
      payload: this.safeParseOptionalField(row.payload_json, row.id, 'payload_json'),
      timestamp: new Date(row.timestamp),
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
    const row = await this.qb
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
    const rows = await this.qb
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

    await this.qb
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
 * This is used internally by PostgresStorageAdapter.transaction().
 *
 * Exported for regression testing; not part of the public API.
 */
export class PostgresTransactionAdapter implements StorageAdapter {
  private qb: ReturnType<KyselyType<StepflowDatabase>['withSchema']>;

  constructor(
    private trx: KyselyType<StepflowDatabase>,
    private schema: string,
    private logger?: Logger
  ) {
    this.qb = trx.withSchema(schema);
  }

  async createRun(run: CreateRunInput | Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord> {
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
        error_json: 'error' in run && run.error ? JSON.stringify(sanitizeErrorForStorage(run.error)) : null,
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
    const row = await this.qb
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    return row ? this.mapRunRow(row) : null;
  }

  async updateRun(runId: string, updates: UpdateRunInput | Partial<WorkflowRunRecord>): Promise<void> {
    const updateData: Partial<WorkflowRunsTable> = {};

    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.context !== undefined) updateData.context_json = JSON.stringify(updates.context);
    if ('output' in updates && updates.output !== undefined) updateData.output_json = JSON.stringify(updates.output);
    if (updates.error !== undefined) updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error as WorkflowError));
    if (updates.startedAt !== undefined) updateData.started_at = updates.startedAt;
    if (updates.finishedAt !== undefined) updateData.finished_at = updates.finishedAt;

    if (Object.keys(updateData).length > 0) {
      await this.qb.updateTable('runs').set(updateData).where('id', '=', runId).execute();
    }
  }

  async listRuns(options: ListRunsOptions = {}): Promise<PaginatedResult<WorkflowRunRecord>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const applyFilters = <T extends { where(col: any, op: any, val: any): T }>(q: T): T => {
      if (options.kind) q = q.where('kind', '=', options.kind);
      if (options.status) {
        const statuses = Array.isArray(options.status) ? options.status : [options.status];
        q = q.where('status', 'in', statuses);
      }
      if (options.parentRunId !== undefined) {
        q = q.where('parent_run_id', '=', options.parentRunId);
      }
      return q;
    };

    // Use the same transaction-scoped query builder for both COUNT and SELECT
    // so the total reflects rows visible to this transaction (including
    // uncommitted inserts made earlier in it).
    const countQuery = applyFilters(
      this.qb.selectFrom('runs').select(sql<number>`count(*)`.as('count'))
    );
    const dataQuery = applyFilters(this.qb.selectFrom('runs').selectAll());

    const orderColumn = (options.orderBy ?? 'createdAt') === 'createdAt' ? 'created_at' :
                        options.orderBy === 'startedAt' ? 'started_at' : 'finished_at';
    const orderDirection = options.orderDirection ?? 'desc';

    const countResult = await countQuery.executeTakeFirst() as { count?: string | number } | undefined;
    const total = Number(countResult?.count ?? 0);

    const rows = await dataQuery
      .orderBy(orderColumn, orderDirection)
      .limit(limit)
      .offset(offset)
      .execute();

    return {
      items: rows.map(row => this.mapRunRow(row)),
      total,
    };
  }

  async createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord> {
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
        error_json: step.error ? JSON.stringify(sanitizeErrorForStorage(step.error)) : null,
        started_at: step.startedAt ?? null,
        finished_at: step.finishedAt ?? null,
      })
      .execute();

    return { ...step, id };
  }

  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    const row = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('id', '=', stepId)
      .executeTakeFirst();

    return row ? this.mapStepRow(row) : null;
  }

  async updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void> {
    const updateData: Partial<WorkflowRunStepsTable> = {};

    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.attempt !== undefined) updateData.attempt = updates.attempt;
    if (updates.result !== undefined) updateData.result_json = JSON.stringify(updates.result);
    if (updates.error !== undefined) updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error as WorkflowError));
    if (updates.finishedAt !== undefined) updateData.finished_at = updates.finishedAt;

    if (Object.keys(updateData).length > 0) {
      await this.qb.updateTable('workflow_run_steps').set(updateData).where('id', '=', stepId).execute();
    }
  }

  async getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]> {
    const rows = await this.qb
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc')
      .execute();

    return rows.map(row => this.mapStepRow(row));
  }

  async saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void> {
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

  async getEventsForRun(runId: string, options: ListEventsOptions = {}): Promise<WorkflowEventRecord[]> {
    let query = this.qb
      .selectFrom('workflow_events')
      .selectAll()
      .where('run_id', '=', runId);

    if (options.stepKey) query = query.where('step_key', '=', options.stepKey);
    if (options.level) query = query.where('level', '=', options.level);

    const rows = await query
      .orderBy('timestamp', 'asc')
      .limit(options.limit ?? 1000)
      .offset(options.offset ?? 0)
      .execute();

    return rows.map(row => this.mapEventRow(row));
  }

  private safeJsonParse(json: string, fallback: unknown, rowId?: string, column?: string): unknown {
    return safeJsonParseShared(json, fallback, {
      component: 'PostgresTransactionAdapter',
      rowId,
      column,
      logger: this.logger,
    });
  }

  private safeParseField(value: unknown, fallback: unknown, rowId?: string, column?: string): unknown {
    if (typeof value === 'string') {
      return this.safeJsonParse(value, fallback, rowId, column);
    }
    return value;
  }

  private safeParseOptionalField(value: unknown, rowId?: string, column?: string): unknown {
    if (!value) return undefined;
    if (typeof value === 'string') {
      return this.safeJsonParse(value, undefined, rowId, column);
    }
    return value;
  }

  private mapRunRow(row: WorkflowRunsTable): WorkflowRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      parentRunId: row.parent_run_id ?? undefined,
      input: this.safeParseField(row.input_json, {}, row.id, 'input_json') as Record<string, unknown>,
      context: this.safeParseField(row.context_json, {}, row.id, 'context_json') as Record<string, unknown>,
      output: this.safeParseOptionalField(row.output_json, row.id, 'output_json') as Record<string, unknown> | undefined,
      error: this.safeParseOptionalField(row.error_json, row.id, 'error_json') as WorkflowError | undefined,
      metadata: this.safeParseField(row.metadata_json, {}, row.id, 'metadata_json') as Record<string, unknown>,
      priority: row.priority ?? 0,
      timeoutMs: row.timeout_ms ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapStepRow(row: WorkflowRunStepsTable): WorkflowRunStepRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status as StepStatus,
      attempt: row.attempt,
      result: this.safeParseOptionalField(row.result_json, row.id, 'result_json'),
      error: this.safeParseOptionalField(row.error_json, row.id, 'error_json') as WorkflowError | undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapEventRow(row: WorkflowEventsTable): WorkflowEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? undefined,
      eventType: row.event_type,
      level: row.level as 'info' | 'warn' | 'error',
      payload: this.safeParseOptionalField(row.payload_json, row.id, 'payload_json'),
      timestamp: new Date(row.timestamp),
    };
  }
}

// Convenience aliases for shorter naming
export { PostgresStorageAdapter as PostgresStorage };
export type { PostgresStorageConfig as PostgresStorageOptions };
