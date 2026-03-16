import { i as StorageAdapter, j as WorkflowRunRecord, d as ListRunsOptions, P as PaginatedResult, k as WorkflowRunStepRecord, W as WorkflowEventRecord, L as ListEventsOptions, C as CreateRunInput, U as UpdateRunInput, e as StepResult } from '../types-WS7DYUtd.js';
export { E as ExtendedListRunsOptions, a as ExtendedRunStatus, b as ExtendedStepStatus, c as ExtendedWorkflowRunRecord, S as StepRecord, f as StepflowDatabase, g as StepflowRunsTable, h as StepflowStepResultsTable, l as WorkflowStorage } from '../types-WS7DYUtd.js';
import Database from 'better-sqlite3';
import { Pool, PoolConfig } from 'pg';
import '../types-CYTuMmf-.js';

/**
 * In-memory storage adapter for development and testing.
 * All data is lost when the process exits.
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
    private stmts;
    constructor(config: SQLiteStorageConfig);
    /**
     * Create the workflow tables if they don't exist.
     */
    private createTables;
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
     * @deprecated Use `transactionSync()` instead. This method only works when
     * the callback performs purely synchronous operations wrapped in async/await.
     * If the callback awaits real async I/O (network, timers, etc.), it will
     * throw an error. `transactionSync()` makes the synchronous requirement explicit.
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
    private mapRunRow;
    private mapStepRow;
    private mapEventRow;
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
 * PostgreSQL storage adapter using Kysely.
 *
 * Provides durable persistence for workflow runs, steps, and events
 * with support for distributed deployments and connection pooling.
 */

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
declare class PostgresStorageAdapter implements StorageAdapter {
    private db;
    private pool;
    private ownsPool;
    private schema;
    private autoMigrate;
    private initialized;
    private config;
    constructor(config: PostgresStorageConfig);
    /**
     * Get a schema-scoped query builder.
     * All queries MUST use this instead of this.db directly to respect config.schema.
     */
    private get qb();
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
     * Create the workflow tables if they don't exist.
     */
    private createTables;
    /**
     * Create a new workflow run.
     * Supports both legacy and new CreateRunInput interfaces.
     */
    createRun(run: CreateRunInput | Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
    getRun(runId: string): Promise<WorkflowRunRecord | null>;
    /**
     * Update a workflow run.
     * Supports both legacy Partial<WorkflowRunRecord> and new UpdateRunInput interfaces.
     */
    updateRun(runId: string, updates: UpdateRunInput | Partial<WorkflowRunRecord>): Promise<void>;
    /**
     * List workflow runs with filtering and pagination.
     */
    /**
     * Apply common run filters to a Kysely query builder.
     * Used by both the data query and count query in listRuns to avoid duplication.
     */
    private applyRunsFilters;
    listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
    createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
    getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
    updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
    getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;
    saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
    getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;
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
    private mapRunRow;
    /**
     * Map a database row to an extended workflow run record.
     */
    private mapExtendedRunRow;
    private mapStepResultRow;
    private mapStepRow;
    private mapEventRow;
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

export { CreateRunInput, ListEventsOptions, ListRunsOptions, MemoryStorageAdapter, PaginatedResult, PostgresStorageAdapter as PostgresStorage, PostgresStorageAdapter, type PostgresStorageConfig, type PostgresStorageConfig as PostgresStorageOptions, SQLiteStorageAdapter, type SQLiteStorageConfig, StepResult, StorageAdapter, UpdateRunInput, WorkflowEventRecord, WorkflowRunRecord, WorkflowRunStepRecord };
