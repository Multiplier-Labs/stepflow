import { i as StorageAdapter, j as WorkflowRunRecord, d as ListRunsOptions, P as PaginatedResult, k as WorkflowRunStepRecord, W as WorkflowEventRecord, L as ListEventsOptions, C as CreateRunInput, U as UpdateRunInput, e as StepResult } from '../types-BfWe5yP6.js';
export { E as ExtendedListRunsOptions, a as ExtendedRunStatus, b as ExtendedStepStatus, c as ExtendedWorkflowRunRecord, S as StepRecord, f as StepflowDatabase, g as StepflowRunsTable, h as StepflowStepResultsTable, l as WorkflowStorage } from '../types-BfWe5yP6.js';
import Database from 'better-sqlite3';
import { Logger } from '../index.js';
import { Kysely } from 'kysely';
import { Pool, PoolConfig } from 'pg';

/**
 * In-memory storage adapter for development and testing.
 * All data is lost when the process exits.
 *
 * NOTE: This adapter is intended for development and testing only. It stores
 * all state in-process with no persistence or multi-process safety guarantees.
 */

/**
 * In-memory implementation of StorageAdapter.
 * Useful for development, testing, and lightweight deployments.
 *
 * @example
 * ```typescript
 * import { WorkflowEngine } from 'stepflow';
 * import { MemoryStorageAdapter } from 'stepflow/storage';
 *
 * const storage = new MemoryStorageAdapter();
 * const engine = new WorkflowEngine({ storage });
 * ```
 */
declare class MemoryStorageAdapter implements StorageAdapter {
    private runs;
    private steps;
    private events;
    /** Create and persist a new workflow run record. */
    createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
    /** Retrieve a workflow run by ID, or null if not found. */
    getRun(runId: string): Promise<WorkflowRunRecord | null>;
    /** Apply partial updates to an existing workflow run. No-op if the run does not exist. */
    updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void>;
    /** List workflow runs with optional filtering, sorting, and pagination. */
    listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
    /** Create and persist a new step execution record. */
    createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
    /** Retrieve a step record by ID, or null if not found. */
    getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
    /** Apply partial updates to an existing step record. No-op if the step does not exist. */
    updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
    /** Retrieve all step records for a workflow run, ordered by start time ascending. */
    getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;
    /** Persist a workflow event record. */
    saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
    /** Retrieve events for a workflow run with optional filtering and pagination. */
    getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;
    /** Delete runs (and their associated steps and events) created before the given date. Returns the number of deleted runs. */
    deleteOldRuns(olderThan: Date): Promise<number>;
    /**
     * Clear all stored data. Useful for testing.
     */
    clear(): void;
    /**
     * Get counts of stored records. Useful for testing.
     */
    getStats(): {
        runs: number;
        steps: number;
        events: number;
    };
}

/**
 * SQLite storage adapter using better-sqlite3.
 *
 * Provides durable persistence for workflow runs, steps, and events.
 *
 * ## Module layout
 *
 *   - `SQLiteStorageAdapter` (this file) owns the better-sqlite3 connection,
 *     the prepared-statement cache, and every method on `StorageAdapter`. It
 *     is the only adapter class — unlike the Postgres adapter there is no
 *     transaction-scoped twin, so no abstract CRUD base class is required.
 *
 *   - `sqlite-core.ts` holds the pure row-type interfaces and row mappers
 *     (`mapRunRow`, `mapStepRow`, `mapEventRow`). The mappers route every
 *     JSON-column parse through `safeParseField` / `safeParseOptionalField`
 *     in `src/utils/safe-json.ts`, sharing the corruption-counter +
 *     structured-warn behavior with the Postgres core (audit M2 / L3,
 *     PR #52). The split mirrors `postgres-core.ts` so both adapters
 *     expose mappers in the same shape.
 */

/**
 * Configuration options for the SQLite storage adapter.
 */
interface SQLiteStorageConfig {
    /**
     * The better-sqlite3 database instance.
     * Can be an in-memory database (`:memory:`) or a file path.
     */
    db: Database.Database;
    /**
     * Whether to automatically create tables on initialization.
     * Default: true
     */
    autoCreateTables?: boolean;
    /**
     * @deprecated This option is not currently supported and will be ignored.
     * Table names are always prefixed with 'workflow_'.
     */
    tablePrefix?: string;
    /**
     * Optional structured logger used to surface JSON corruption events.
     * Without one, parse failures still increment the corruption counter
     * exposed via `getJsonParseCorruptionCount()` but produce no log output.
     */
    logger?: Logger;
}
/**
 * SQLite implementation of StorageAdapter using better-sqlite3.
 *
 * Features:
 * - Synchronous operations (better-sqlite3 is sync by design)
 * - Automatic table creation
 * - Transaction support
 * - Customizable table prefix
 *
 * @example
 * ```typescript
 * import Database from 'better-sqlite3';
 * import { SQLiteStorageAdapter } from 'stepflow/storage';
 *
 * const db = new Database('./workflows.db');
 * const storage = new SQLiteStorageAdapter({ db });
 *
 * const engine = new WorkflowEngine({ storage });
 * ```
 */
declare class SQLiteStorageAdapter implements StorageAdapter {
    private db;
    private prefix;
    private logger;
    private stmts;
    constructor(config: SQLiteStorageConfig);
    /**
     * Create the workflow tables if they don't exist.
     */
    private createTables;
    /**
     * Apply additive schema migrations to existing tables.
     *
     * `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists, so
     * any column added to {@link CREATE_TABLES_SQL} after the initial schema is
     * silently absent on databases created by older versions of this adapter.
     * Without this step, the first INSERT/SELECT crashes with
     * `SqliteError: table X has no column named Y`. This mirrors the
     * `ALTER TABLE ADD COLUMN IF NOT EXISTS` block in `postgres.ts`'s
     * `createTables()`.
     *
     * For each entry in {@link SCHEMA_MIGRATIONS}: if the table exists and the
     * column does not, run `ALTER TABLE ADD COLUMN`. The ALTER is wrapped in a
     * try/catch that tolerates `duplicate column` errors so concurrent startups
     * (or any race between the existence check and the ALTER) do not crash.
     * Other SQLite errors propagate.
     */
    private runMigrations;
    /**
     * Prepare all SQL statements for better performance.
     */
    private prepareStatements;
    createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
    getRun(runId: string): Promise<WorkflowRunRecord | null>;
    updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void>;
    listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
    createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
    getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
    updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
    getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;
    saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
    getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;
    /**
     * Execute a function within a database transaction (async interface).
     *
     * @deprecated Use {@link transactionSync} instead. better-sqlite3 transactions
     * are synchronous: COMMIT happens the moment the callback returns control to
     * `db.transaction(fn)()`. If the callback awaits real async I/O (network,
     * timers, etc.), the COMMIT has already happened by the time the awaited work
     * runs, so its operations are **not** transactional.
     *
     * To make the footgun visible the adapter installs a runtime guard: when the
     * callback's promise has not settled by the time the COMMIT returns, the
     * deprecated method emits a `console.warn` so that the misuse surfaces in
     * production logs. The promise is still returned so existing callers keep
     * working — switch to `transactionSync` to silence the warning.
     */
    transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
    /**
     * Execute a synchronous transaction (preferred for better-sqlite3).
     * Use this when you need transaction guarantees.
     *
     * @example
     * ```typescript
     * storage.transactionSync(() => {
     *   // Multiple operations in a single transaction
     *   const run = storage.createRunSync(...);
     *   storage.updateRunSync(run.id, ...);
     * });
     * ```
     */
    transactionSync<T>(fn: () => T): T;
    /**
     * Delete runs older than the specified date.
     * Also deletes associated steps and events (via CASCADE).
     */
    deleteOldRuns(olderThan: Date): Promise<number>;
    /**
     * Get all runs that were interrupted (status is 'running' or 'queued').
     * These runs can potentially be resumed.
     */
    getInterruptedRuns(): Promise<WorkflowRunRecord[]>;
    /**
     * Get the last completed step for a run.
     * Useful for resuming from a checkpoint.
     */
    getLastCompletedStep(runId: string): Promise<WorkflowRunStepRecord | null>;
    /** Mapper context paired with the adapter's component label + optional logger. */
    private get mapperCtx();
    /**
     * Close the database connection.
     */
    close(): void;
    /**
     * Get database statistics.
     */
    getStats(): {
        runs: number;
        steps: number;
        events: number;
    };
}

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

interface SafeJsonParseContext {
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
type MapperContext = Pick<SafeJsonParseContext, 'component' | 'logger'>;

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

/** Kysely row type for the workflow_runs table. */
interface WorkflowRunsTable {
    id: string;
    kind: string;
    status: string;
    parent_run_id: string | null;
    input_json: string;
    metadata_json: string;
    context_json: string;
    completed_steps_json: string | null;
    output_json: string | null;
    error_json: string | null;
    priority: number;
    timeout_ms: number | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}
/** Kysely row type for the workflow_run_steps table. */
interface WorkflowRunStepsTable {
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
interface WorkflowEventsTable {
    id: string;
    run_id: string;
    step_key: string | null;
    event_type: string;
    level: string;
    payload_json: string | null;
    timestamp: Date;
}
/** Combined Kysely schema covering the tables touched by the shared core. */
interface PostgresCoreDatabase {
    runs: WorkflowRunsTable;
    workflow_run_steps: WorkflowRunStepsTable;
    workflow_events: WorkflowEventsTable;
}
/** Schema-scoped query builder produced by `db.withSchema(schemaName)`. */
type SchemaQueryBuilder<DB extends PostgresCoreDatabase = PostgresCoreDatabase> = ReturnType<Kysely<DB>['withSchema']>;
/** Concrete core-only schema query builder used inside the shared base class. */
type CoreSchemaQueryBuilder = SchemaQueryBuilder<PostgresCoreDatabase>;
/**
 * Abstract base implementing the CRUD subset of `StorageAdapter` against a
 * schema-scoped Kysely query builder. Subclasses must provide the query
 * builder via `qb` and may override `ensureReady()` to gate calls (the
 * pool-owning adapter uses this to enforce `initialize()` having run).
 *
 * The base class deliberately does **not** own the connection pool, schema
 * migrations, or transaction control — those stay with `PostgresStorageAdapter`.
 *
 * The base class targets `PostgresCoreDatabase` (the three core tables) so
 * Kysely's row-type machinery can fully resolve column types on every query.
 * Subclasses with a wider schema (e.g. `PostgresStorageAdapter` with
 * `stepflow_step_results`) keep their own typed handle for the extra tables
 * and return a core-typed view here.
 */
declare abstract class PostgresStorageCore implements StorageAdapter {
    protected readonly schema: string;
    protected readonly logger?: Logger | undefined;
    protected constructor(schema: string, logger?: Logger | undefined);
    /** Schema-scoped query builder. Subclasses return the bound builder. */
    protected abstract get qb(): CoreSchemaQueryBuilder;
    /** Component label used in corruption warnings; defines the JSON-parse `MapperContext`. */
    protected abstract get warnLabel(): string;
    /** Mapper context handed to row mappers — pairs the component label with the optional logger. */
    protected get mapperCtx(): MapperContext;
    /**
     * Hook called at the start of every CRUD method. The pool-owning adapter
     * overrides this to throw before `initialize()` has run; the transaction
     * wrapper leaves it as a no-op.
     */
    protected ensureReady(): void;
    createRun(run: CreateRunInput | Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
    getRun(runId: string): Promise<WorkflowRunRecord | null>;
    updateRun(runId: string, updates: UpdateRunInput | Partial<WorkflowRunRecord>): Promise<void>;
    listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
    createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
    getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
    updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
    getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;
    saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
    getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;
}

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
/**
 * Configuration options for the PostgreSQL storage adapter.
 */
interface PostgresStorageConfig {
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
declare class PostgresStorageAdapter extends PostgresStorageCore {
    private db;
    private pool;
    private ownsPool;
    private autoMigrate;
    private initialized;
    private config;
    constructor(config: PostgresStorageConfig);
    /**
     * Core-tables query builder consumed by `PostgresStorageCore`. Returns the
     * schema-scoped Kysely view typed against the three core tables, which is
     * what the shared CRUD methods need.
     */
    protected get qb(): CoreSchemaQueryBuilder;
    /**
     * Extended query builder for adapter-only tables (currently
     * `stepflow_step_results`). Kept separate from `qb` so the base class stays
     * typed against the core schema.
     */
    private get extQb();
    /** Tag used by shared row mappers in `console.warn` messages. */
    protected get warnLabel(): string;
    /** Override of `PostgresStorageCore.ensureReady()` — enforces `initialize()`. */
    protected ensureReady(): void;
    private ensureInitialized;
    /**
     * Initialize the storage adapter.
     * Creates tables if autoMigrate is enabled.
     */
    initialize(): Promise<void>;
    /**
     * Close the database connection.
     * Only closes the pool if it was created by this adapter.
     */
    close(): Promise<void>;
    /**
     * Run a single migration step. Tolerates only known-benign Postgres errors
     * (duplicate object codes that map to "already applied"), and rethrows
     * everything else with a clear message so partial-state upgrades are not
     * silently swallowed.
     */
    protected runMigration(label: string, fn: () => Promise<unknown>): Promise<void>;
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
    private static readonly BENIGN_MIGRATION_CODES;
    private static isBenignMigrationError;
    /**
     * Create the workflow tables if they don't exist.
     */
    private createTables;
    /**
     * Execute a function within a database transaction.
     */
    transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
    /**
     * Delete runs older than the specified date.
     * Also deletes associated steps and events (via CASCADE).
     */
    deleteOldRuns(olderThan: Date): Promise<number>;
    /**
     * Get all runs that were interrupted (status is 'running' or 'queued').
     * These runs can potentially be resumed.
     */
    getInterruptedRuns(): Promise<WorkflowRunRecord[]>;
    /**
     * Get the last completed step for a run.
     * Useful for resuming from a checkpoint.
     */
    getLastCompletedStep(runId: string): Promise<WorkflowRunStepRecord | null>;
    /**
     * Atomically dequeue a run for processing.
     * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
     *
     * @param workflowKinds - Optional list of workflow kinds to filter by
     * @returns The dequeued run, or null if no runs are available
     */
    dequeueRun(workflowKinds?: string[]): Promise<WorkflowRunRecord | null>;
    private mapStepResultRow;
    /**
     * Delete a workflow run by ID.
     * Also deletes associated steps and events (via CASCADE).
     */
    deleteRun(id: string): Promise<void>;
    /**
     * Cleanup stale runs that have exceeded their timeout.
     * Marks them as 'timeout' status with an appropriate error.
     *
     * @param defaultTimeoutMs - Default timeout in ms for runs without explicit timeout (default: 600000 = 10 minutes)
     * @returns Number of runs marked as timed out
     */
    cleanupStaleRuns(defaultTimeoutMs?: number): Promise<number>;
    /**
     * Mark multiple runs as failed with a given reason.
     * Useful for cleanup when a worker shuts down unexpectedly.
     *
     * @param runIds - Array of run IDs to mark as failed
     * @param reason - Reason message for the failure
     */
    markRunsAsFailed(runIds: string[], reason: string): Promise<void>;
    /**
     * Get a specific step result by run ID and step name.
     */
    getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
    /**
     * Get all step results for a run.
     */
    getStepResults(runId: string): Promise<StepResult[]>;
    /**
     * Save or update a step result.
     * Uses upsert to handle both new and existing results.
     */
    saveStepResult(result: Omit<StepResult, 'id'> & {
        id?: string;
    }): Promise<void>;
    /**
     * Get database statistics.
     */
    getStats(): Promise<{
        runs: number;
        steps: number;
        events: number;
    }>;
}
/**
 * A StorageAdapter wrapper for use within transactions.
 *
 * Used internally by `PostgresStorageAdapter.transaction()`. All CRUD methods
 * are inherited from `PostgresStorageCore`; this class only binds the
 * transaction-scoped query builder.
 *
 * Exported for regression testing; not part of the public API.
 */
declare class PostgresTransactionAdapter extends PostgresStorageCore {
    private readonly _qb;
    constructor(trx: Kysely<StepflowDatabase>, schema: string, logger?: Logger);
    protected get qb(): CoreSchemaQueryBuilder;
    protected get warnLabel(): string;
}

export { CreateRunInput, ListEventsOptions, ListRunsOptions, MemoryStorageAdapter, PaginatedResult, PostgresStorageAdapter as PostgresStorage, PostgresStorageAdapter, PostgresTransactionAdapter, SQLiteStorageAdapter, StepResult, StorageAdapter, UpdateRunInput, WorkflowEventRecord, WorkflowRunRecord, WorkflowRunStepRecord };
export type { PostgresStorageConfig, PostgresStorageConfig as PostgresStorageOptions, SQLiteStorageConfig };
