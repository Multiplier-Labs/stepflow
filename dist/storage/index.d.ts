import { a as WorkflowKind, R as RunStatus, b as WorkflowError, d as StepStatus } from '../types-V-4dhiZA.js';
import Database from 'better-sqlite3';

/**
 * Storage interface types for the workflow engine.
 * Implement StorageAdapter to use your preferred database.
 */

/**
 * Stored representation of a workflow run.
 */
interface WorkflowRunRecord {
    id: string;
    kind: WorkflowKind;
    status: RunStatus;
    parentRunId?: string;
    input: Record<string, unknown>;
    metadata: Record<string, unknown>;
    /** Accumulated results from completed steps (checkpoint) */
    context: Record<string, unknown>;
    error?: WorkflowError;
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
    limit: number;
    offset: number;
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

export { type ListEventsOptions, type ListRunsOptions, MemoryStorageAdapter, type PaginatedResult, SQLiteStorageAdapter, type SQLiteStorageConfig, type StorageAdapter, type WorkflowEventRecord, type WorkflowRunRecord, type WorkflowRunStepRecord };
