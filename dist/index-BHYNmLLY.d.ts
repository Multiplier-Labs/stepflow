import { L as Logger, g as WorkflowDefinition, W as WorkflowKind, R as RunStatus } from './types-CYTuMmf-.js';
import { i as StorageAdapter, j as WorkflowRunRecord } from './types-D0rYGzNK.js';
import { a as EventTransport, E as EventCallback, U as Unsubscribe } from './types-DmQ102bp.js';
import { Database } from 'better-sqlite3';
import { Pool, PoolConfig } from 'pg';

/**
 * Main WorkflowEngine class.
 *
 * This is the primary entry point for the workflow engine.
 * It provides methods for registering workflows, starting runs,
 * and managing workflow execution.
 */

/**
 * Configuration for the workflow engine.
 */
interface WorkflowEngineConfig {
    /** Storage adapter for persistence (default: MemoryStorageAdapter) */
    storage?: StorageAdapter;
    /** Event transport for real-time updates (default: MemoryEventTransport) */
    events?: EventTransport;
    /** Logger instance (default: ConsoleLogger) */
    logger?: Logger;
    /** Global settings */
    settings?: {
        /** Default timeout for workflows in ms */
        defaultTimeout?: number;
        /** Maximum concurrent workflows */
        maxConcurrency?: number;
    };
}
/**
 * Options for starting a workflow run.
 */
interface StartRunOptions<TInput = Record<string, unknown>> {
    /** Workflow type to run */
    kind: WorkflowKind;
    /** Input parameters */
    input?: TInput;
    /** Optional metadata (e.g., userId, topicId) */
    metadata?: Record<string, unknown>;
    /** Parent run ID (for child workflows) */
    parentRunId?: string;
    /** Delay before starting (ms) */
    delay?: number;
    /** Priority for queue ordering (higher = runs first, default: 0) */
    priority?: number;
}
declare class WorkflowEngine {
    private registry;
    private storage;
    private events;
    private logger;
    private activeRuns;
    private settings;
    private runQueue;
    constructor(config?: WorkflowEngineConfig);
    /**
     * Initialize the engine and its storage/event adapters.
     * Call this before starting runs if your storage adapter requires initialization
     * (e.g., PostgresStorageAdapter).
     */
    initialize(): Promise<void>;
    /**
     * Get the current number of active runs.
     */
    getActiveRunCount(): number;
    /**
     * Get the number of queued runs waiting for capacity.
     */
    getQueuedRunCount(): number;
    /**
     * Check if capacity is available for a new run.
     */
    private hasCapacity;
    /**
     * Register a workflow definition.
     * Must be called before runs of this type can be started.
     *
     * @param definition - The workflow definition
     * @throws WorkflowAlreadyRegisteredError if already registered
     */
    registerWorkflow<TInput = Record<string, unknown>>(definition: WorkflowDefinition<TInput>): void;
    /**
     * Unregister a workflow definition.
     *
     * @param kind - The workflow kind to unregister
     * @returns true if the workflow was unregistered, false if not found
     */
    unregisterWorkflow(kind: WorkflowKind): boolean;
    /**
     * Get a registered workflow definition.
     *
     * @param kind - The workflow kind
     * @returns The workflow definition or undefined
     */
    getWorkflow(kind: WorkflowKind): WorkflowDefinition | undefined;
    /**
     * Get all registered workflow kinds.
     */
    getRegisteredWorkflows(): WorkflowKind[];
    /**
     * Start a new workflow run (non-blocking).
     * The run executes asynchronously and this method returns immediately.
     * If maxConcurrency is set and reached, the run is queued.
     *
     * @param options - Run options including kind and input
     * @returns The generated run ID
     * @throws WorkflowNotFoundError if the workflow kind is not registered
     */
    startRun<TInput = Record<string, unknown>>(options: StartRunOptions<TInput>): Promise<string>;
    /**
     * Queue a run in priority order.
     */
    private queueRun;
    /**
     * Execute a run (internal method).
     */
    private executeRun;
    /**
     * Launch a workflow run asynchronously.
     * Shared by both executeRun (new runs) and resumeRun (checkpoint recovery).
     */
    private launchRun;
    /**
     * Process the queue and start runs if capacity is available.
     */
    private processQueue;
    /**
     * Start a child workflow from within a parent workflow.
     * Called internally by the context.spawnChild helper.
     */
    private spawnChild;
    /**
     * Cancel a running workflow.
     * Signals the workflow to stop at the next cancellation point.
     *
     * @param runId - The run ID to cancel
     * @throws RunNotFoundError if the run is not found
     */
    cancelRun(runId: string): Promise<void>;
    /**
     * Get the current status of a run.
     *
     * @param runId - The run ID to look up
     * @returns The run record or null if not found
     */
    getRunStatus(runId: string): Promise<WorkflowRunRecord | null>;
    private static readonly TERMINAL_STATUSES;
    private static readonly TERMINAL_EVENT_TYPES;
    /**
     * Wait for a run to complete.
     * Subscribes to run events and resolves when a terminal event fires.
     * Falls back to an initial storage read to avoid race conditions.
     *
     * @param runId - The run ID to wait for
     * @param options - Wait options
     * @returns The final run record
     */
    waitForRun(runId: string, options?: {
        timeout?: number;
    }): Promise<WorkflowRunRecord>;
    /**
     * Resume an interrupted workflow run from its checkpoint.
     * The run must be in 'queued' or 'running' status.
     *
     * @param runId - The run ID to resume
     * @returns The run ID (same as input)
     * @throws RunNotFoundError if the run is not found
     * @throws Error if the run is already completed or workflow not registered
     */
    resumeRun(runId: string): Promise<string>;
    /**
     * Get all runs that were interrupted and can be resumed.
     * Returns runs with status 'queued' or 'running'.
     */
    getResumableRuns(): Promise<WorkflowRunRecord[]>;
    /**
     * Resume all interrupted runs.
     * Useful for recovering after a server restart.
     *
     * @returns Array of resumed run IDs
     */
    resumeAllInterrupted(): Promise<string[]>;
    /**
     * Subscribe to events for a specific run.
     *
     * @param runId - The run ID to subscribe to
     * @param callback - Event handler
     * @returns Unsubscribe function
     */
    subscribeToRun(runId: string, callback: EventCallback): Unsubscribe;
    /**
     * Subscribe to all workflow events.
     *
     * @param callback - Event handler
     * @returns Unsubscribe function
     */
    subscribeToAll(callback: EventCallback): Unsubscribe;
    /**
     * Get the storage adapter.
     * Useful for querying runs and steps directly.
     */
    getStorage(): StorageAdapter;
    /**
     * Get the event transport.
     * Useful for custom event handling.
     */
    getEvents(): EventTransport;
    /**
     * Shutdown the engine gracefully.
     * Cancels all active runs and closes resources.
     */
    shutdown(): Promise<void>;
}

/**
 * Scheduler types for the workflow engine.
 * Note: The full scheduler implementation is in Phase 3.
 * This file defines the interfaces for future implementation.
 */

/**
 * Schedule trigger types.
 */
type TriggerType = 'cron' | 'workflow_completed' | 'manual';
/**
 * Schedule definition.
 */
interface WorkflowSchedule {
    id: string;
    workflowKind: WorkflowKind;
    triggerType: TriggerType;
    cronExpression?: string;
    timezone?: string;
    triggerOnWorkflowKind?: WorkflowKind;
    triggerOnStatus?: RunStatus[];
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    enabled: boolean;
    lastRunAt?: Date;
    lastRunId?: string;
    nextRunAt?: Date;
}
/**
 * Scheduler interface.
 * Implement this to create custom schedulers.
 */
interface Scheduler {
    /** Start the scheduler */
    start(): Promise<void>;
    /** Stop the scheduler */
    stop(): Promise<void>;
    /** Add a schedule */
    addSchedule(schedule: Omit<WorkflowSchedule, 'id'>): Promise<WorkflowSchedule>;
    /** Remove a schedule */
    removeSchedule(scheduleId: string): Promise<void>;
    /** Update a schedule */
    updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;
    /** Get all schedules */
    getSchedules(): Promise<WorkflowSchedule[]>;
    /** Manually trigger a scheduled workflow */
    triggerNow(scheduleId: string): Promise<string>;
}

/**
 * CronScheduler - Scheduler implementation using cron expressions.
 *
 * Provides time-based and workflow-completion-based triggers for workflows.
 */

/**
 * Configuration for the CronScheduler.
 */
interface CronSchedulerConfig {
    /** The workflow engine instance */
    engine: WorkflowEngine;
    /** Logger instance */
    logger?: Logger;
    /** Poll interval for checking schedules (ms, default: 1000) */
    pollInterval?: number;
    /** Optional persistence adapter for schedules */
    persistence?: SchedulePersistence;
}
/**
 * Interface for schedule persistence.
 * Implement this to persist schedules to a database.
 */
interface SchedulePersistence {
    /** Load all schedules from storage */
    loadSchedules(): Promise<WorkflowSchedule[]>;
    /** Save a schedule */
    saveSchedule(schedule: WorkflowSchedule): Promise<void>;
    /** Update a schedule */
    updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;
    /** Delete a schedule */
    deleteSchedule(scheduleId: string): Promise<void>;
}
/**
 * Scheduler implementation that supports cron expressions and workflow completion triggers.
 *
 * @example
 * ```typescript
 * const scheduler = new CronScheduler({
 *   engine,
 *   pollInterval: 1000,
 * });
 *
 * // Add a cron schedule (every day at midnight)
 * await scheduler.addSchedule({
 *   workflowKind: 'cleanup.daily',
 *   triggerType: 'cron',
 *   cronExpression: '0 0 * * *',
 *   enabled: true,
 * });
 *
 * // Add a workflow completion trigger
 * await scheduler.addSchedule({
 *   workflowKind: 'notification.send',
 *   triggerType: 'workflow_completed',
 *   triggerOnWorkflowKind: 'order.process',
 *   triggerOnStatus: ['succeeded'],
 *   enabled: true,
 * });
 *
 * await scheduler.start();
 * ```
 */
declare class CronScheduler implements Scheduler {
    private engine;
    private logger;
    private pollInterval;
    private persistence?;
    private schedules;
    private running;
    private pollTimer;
    private eventUnsubscribe;
    constructor(config: CronSchedulerConfig);
    /**
     * Start the scheduler.
     * Begins polling for cron schedules and subscribes to workflow completion events.
     */
    start(): Promise<void>;
    /**
     * Stop the scheduler.
     * Stops polling and unsubscribes from events.
     */
    stop(): Promise<void>;
    /**
     * Add a new schedule.
     */
    addSchedule(scheduleData: Omit<WorkflowSchedule, 'id'>): Promise<WorkflowSchedule>;
    /**
     * Remove a schedule.
     */
    removeSchedule(scheduleId: string): Promise<void>;
    /**
     * Update a schedule.
     */
    updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;
    /**
     * Get all schedules.
     */
    getSchedules(): Promise<WorkflowSchedule[]>;
    /**
     * Get a schedule by ID.
     */
    getSchedule(scheduleId: string): WorkflowSchedule | undefined;
    /**
     * Manually trigger a scheduled workflow.
     */
    triggerNow(scheduleId: string): Promise<string>;
    /**
     * Check all cron schedules and execute those that are due.
     */
    private checkSchedules;
    /**
     * Handle workflow events for completion triggers.
     */
    private handleWorkflowEvent;
    /**
     * Execute a schedule by starting the workflow.
     */
    private executeSchedule;
    /**
     * Update the next run time for a cron schedule.
     */
    private updateNextRunTime;
}

/**
 * SQLite persistence adapter for schedules.
 *
 * Stores workflow schedules in a SQLite database table.
 */

/**
 * Configuration for SQLiteSchedulePersistence.
 */
interface SQLiteSchedulePersistenceConfig {
    /** SQLite database instance */
    db: Database;
    /** Table name for schedules (default: workflow_schedules) */
    tableName?: string;
}
/**
 * SQLite-based persistence for workflow schedules.
 *
 * @example
 * ```typescript
 * import Database from 'better-sqlite3';
 *
 * const db = new Database('workflow.db');
 * const persistence = new SQLiteSchedulePersistence({ db });
 *
 * const scheduler = new CronScheduler({
 *   engine,
 *   persistence,
 * });
 * ```
 */
declare class SQLiteSchedulePersistence implements SchedulePersistence {
    private db;
    private tableName;
    private stmts;
    constructor(config: SQLiteSchedulePersistenceConfig);
    private initializeDatabase;
    loadSchedules(): Promise<WorkflowSchedule[]>;
    saveSchedule(schedule: WorkflowSchedule): Promise<void>;
    updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;
    deleteSchedule(scheduleId: string): Promise<void>;
    private rowToSchedule;
}

/**
 * PostgreSQL persistence adapter for schedules.
 *
 * Stores workflow schedules in a PostgreSQL database table using Kysely.
 */

/**
 * Configuration for PostgresSchedulePersistence.
 */
interface PostgresSchedulePersistenceConfig {
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
     * Schema name for the schedules table.
     * @default 'public'
     */
    schema?: string;
    /**
     * Table name for schedules.
     * @default 'workflow_schedules'
     */
    tableName?: string;
    /**
     * Automatically create tables on initialization.
     * @default true
     */
    autoMigrate?: boolean;
}
/**
 * PostgreSQL-based persistence for workflow schedules.
 *
 * @example
 * ```typescript
 * const persistence = new PostgresSchedulePersistence({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * await persistence.initialize();
 *
 * const scheduler = new CronScheduler({
 *   engine,
 *   persistence,
 * });
 * ```
 *
 * @example Sharing connection pool
 * ```typescript
 * import pg from 'pg';
 *
 * const pool = new pg.Pool({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * const persistence = new PostgresSchedulePersistence({ pool });
 * await persistence.initialize();
 * ```
 */
declare class PostgresSchedulePersistence implements SchedulePersistence {
    private db;
    private pool;
    private ownsPool;
    private schema;
    private tableName;
    private autoMigrate;
    private initialized;
    private config;
    constructor(config: PostgresSchedulePersistenceConfig);
    /**
     * Get a schema-scoped query builder.
     * All queries MUST use this instead of this.db directly to respect config.schema.
     */
    private get qb();
    private ensureInitialized;
    /**
     * Initialize the persistence layer.
     * Creates the schedules table if autoMigrate is enabled.
     */
    initialize(): Promise<void>;
    /**
     * Close the database connection.
     * Only closes the pool if it was created by this adapter.
     */
    close(): Promise<void>;
    private createTables;
    loadSchedules(): Promise<WorkflowSchedule[]>;
    saveSchedule(schedule: WorkflowSchedule): Promise<void>;
    updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;
    deleteSchedule(scheduleId: string): Promise<void>;
    /**
     * Get a schedule by ID.
     */
    getSchedule(scheduleId: string): Promise<WorkflowSchedule | null>;
    /**
     * Get all enabled schedules that are due to run.
     */
    getDueSchedules(): Promise<WorkflowSchedule[]>;
    /**
     * Get schedules by workflow kind.
     */
    getSchedulesByWorkflowKind(workflowKind: string): Promise<WorkflowSchedule[]>;
    /**
     * Get workflow completion triggers for a specific workflow kind.
     */
    getCompletionTriggers(triggerOnWorkflowKind: string): Promise<WorkflowSchedule[]>;
    private rowToSchedule;
}

export { CronScheduler as C, PostgresSchedulePersistence as P, SQLiteSchedulePersistence as S, type TriggerType as T, WorkflowEngine as W, type CronSchedulerConfig as a, type PostgresSchedulePersistenceConfig as b, type SQLiteSchedulePersistenceConfig as c, type SchedulePersistence as d, type Scheduler as e, type StartRunOptions as f, type WorkflowEngineConfig as g, type WorkflowSchedule as h };
