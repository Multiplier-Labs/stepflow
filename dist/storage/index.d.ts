import { R as RunStatus, a as WorkflowKind, d as StepStatus, b as WorkflowError } from '../types-V-4dhiZA.js';
import Database from 'better-sqlite3';
import { Pool, PoolConfig } from 'pg';

/**
 * Storage interface types for the workflow engine.
 * Implement StorageAdapter to use your preferred database.
 */

/**
 * Extended status of a workflow run.
 * Adds 'pending' and 'timeout' to the core statuses.
 */
type ExtendedRunStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout';
/**
 * Extended status of a workflow step.
 * Uses 'completed' instead of 'succeeded' for consistency.
 */
type ExtendedStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
/**
 * Stored representation of a workflow run.
 */
interface WorkflowRunRecord {
    id: string;
    kind: string;
    status: RunStatus;
    parentRunId?: string;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
    metadata?: Record<string, unknown>;
    priority?: number;
    timeoutMs?: number;
    createdAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Stored representation of a workflow step execution.
 */
interface WorkflowRunStepRecord {
    id: string;
    runId: string;
    stepKey: string;
    stepName: string;
    status: StepStatus;
    attempt: number;
    result?: unknown;
    error?: WorkflowError;
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Stored workflow event.
 */
interface WorkflowEventRecord {
    id: string;
    runId: string;
    stepKey?: string;
    eventType: string;
    level: 'info' | 'warn' | 'error';
    payload?: unknown;
    timestamp: Date;
}
/**
 * Extended workflow run record with additional fields.
 * Used by new WorkflowStorage implementations.
 */
interface ExtendedWorkflowRunRecord {
    id: string;
    kind: string;
    status: ExtendedRunStatus;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
    metadata?: Record<string, unknown>;
    priority: number;
    timeoutMs?: number;
    createdAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Step result representation.
 */
interface StepResult {
    id: string;
    runId: string;
    stepName: string;
    status: ExtendedStepStatus;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
    attempt: number;
    startedAt?: Date;
    completedAt?: Date;
}
/**
 * Step record for workflow steps.
 */
interface StepRecord {
    stepKey: string;
    stepName: string;
    status: ExtendedStepStatus;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    attempt: number;
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Input for creating a new workflow run.
 */
interface CreateRunInput {
    id?: string;
    kind: string;
    status: ExtendedRunStatus;
    parentRunId?: string;
    input: Record<string, unknown>;
    context?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    priority?: number;
    timeoutMs?: number;
}
/**
 * Input for updating a workflow run.
 */
interface UpdateRunInput {
    status?: ExtendedRunStatus;
    context?: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Options for listing runs.
 */
interface ListRunsOptions {
    kind?: WorkflowKind;
    status?: RunStatus | RunStatus[];
    parentRunId?: string;
    limit?: number;
    offset?: number;
    orderBy?: 'createdAt' | 'startedAt' | 'finishedAt';
    orderDirection?: 'asc' | 'desc';
}
/**
 * Extended options for listing runs.
 */
interface ExtendedListRunsOptions {
    kind?: string;
    status?: ExtendedRunStatus | ExtendedRunStatus[];
    limit?: number;
    offset?: number;
    orderBy?: 'createdAt' | 'startedAt' | 'finishedAt';
    orderDir?: 'asc' | 'desc';
}
/**
 * Options for listing events.
 */
interface ListEventsOptions {
    stepKey?: string;
    level?: 'info' | 'warn' | 'error';
    limit?: number;
    offset?: number;
}
/**
 * Paginated result wrapper.
 */
interface PaginatedResult<T> {
    items: T[];
    total: number;
    limit?: number;
    offset?: number;
}
/**
 * New storage interface for workflow persistence.
 * Implement this interface for new implementations.
 */
interface WorkflowStorage {
    createRun(run: CreateRunInput): Promise<ExtendedWorkflowRunRecord>;
    getRun(id: string): Promise<ExtendedWorkflowRunRecord | null>;
    updateRun(id: string, updates: UpdateRunInput): Promise<void>;
    listRuns(options?: ExtendedListRunsOptions): Promise<PaginatedResult<ExtendedWorkflowRunRecord>>;
    deleteRun(id: string): Promise<void>;
    dequeueRun(workflowKinds: string[]): Promise<ExtendedWorkflowRunRecord | null>;
    cleanupStaleRuns(defaultTimeoutMs?: number): Promise<number>;
    markRunsAsFailed(runIds: string[], reason: string): Promise<void>;
    getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
    getStepResults(runId: string): Promise<StepResult[]>;
    getStepsForRun(runId: string): Promise<StepRecord[]>;
    saveStepResult(result: Omit<StepResult, 'id'> & {
        id?: string;
    }): Promise<void>;
    initialize(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Abstract storage adapter interface.
 * Implement this interface to use your preferred database.
 */
interface StorageAdapter {
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
    transaction?<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
    deleteOldRuns?(olderThan: Date): Promise<number>;
    initialize?(): Promise<void>;
    close?(): void | Promise<void>;
}
/**
 * Database table schema for workflow runs.
 * Note: When used with Kysely, wrap auto-generated fields with Generated<T>.
 */
interface StepflowRunsTable {
    id: string;
    kind: string;
    status: ExtendedRunStatus;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    output: Record<string, unknown> | null;
    error: {
        code: string;
        message: string;
    } | null;
    metadata: Record<string, unknown> | null;
    priority: number;
    timeout_ms: number | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}
/**
 * Database table schema for step results.
 * Note: When used with Kysely, wrap auto-generated fields with Generated<T>.
 */
interface StepflowStepResultsTable {
    id: string;
    run_id: string;
    step_name: string;
    status: ExtendedStepStatus;
    output: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
    attempt: number;
    started_at: Date | null;
    completed_at: Date | null;
}
/**
 * Combined database schema for Stepflow.
 */
interface StepflowDatabase {
    'stepflow.runs': StepflowRunsTable;
    'stepflow.step_results': StepflowStepResultsTable;
}

/**
 * In-memory storage adapter for development and testing.
 * All data is lost when the process exits.
 */

/**
 * In-memory implementation of StorageAdapter.
 * Useful for development, testing, and lightweight deployments.
 */
declare class MemoryStorageAdapter implements StorageAdapter {
    private runs;
    private steps;
    private events;
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
     * Custom table name prefix.
     * Useful when sharing a database with other applications.
     * Default: 'workflow'
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
     * Note: better-sqlite3 uses synchronous transactions internally.
     * For best results, use transactionSync() directly.
     * This async version is provided for interface compatibility but
     * the callback must not contain actual async operations.
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

export { type CreateRunInput, type ExtendedListRunsOptions, type ExtendedRunStatus, type ExtendedStepStatus, type ExtendedWorkflowRunRecord, type ListEventsOptions, type ListRunsOptions, MemoryStorageAdapter, type PaginatedResult, PostgresStorageAdapter as PostgresStorage, PostgresStorageAdapter, type PostgresStorageConfig, type PostgresStorageConfig as PostgresStorageOptions, SQLiteStorageAdapter, type SQLiteStorageConfig, type StepRecord, type StepResult, type StepflowDatabase, type StepflowRunsTable, type StepflowStepResultsTable, type StorageAdapter, type UpdateRunInput, type WorkflowEventRecord, type WorkflowRunRecord, type WorkflowRunStepRecord, type WorkflowStorage };
