import { L as Logger, W as WorkflowDefinition, a as WorkflowKind, R as RunStatus, b as WorkflowError, S as StepErrorStrategy, c as WorkflowStep } from './types-V-4dhiZA.js';
export { e as RunResult, f as SpawnChildOptions, d as StepStatus, g as WorkflowContext, h as WorkflowHooks } from './types-V-4dhiZA.js';
import { StorageAdapter, WorkflowRunRecord } from './storage/index.js';
export { CreateRunInput, ExtendedListRunsOptions, ExtendedRunStatus, ExtendedStepStatus, ExtendedWorkflowRunRecord, ListEventsOptions, ListRunsOptions, MemoryStorageAdapter, PaginatedResult, PostgresStorage, PostgresStorage as PostgresStorageAdapter, PostgresStorageOptions as PostgresStorageConfig, SQLiteStorageAdapter, SQLiteStorageConfig, StepRecord, StepResult, StepflowDatabase, StepflowRunsTable, StepflowStepResultsTable, UpdateRunInput, WorkflowEventRecord, WorkflowRunStepRecord, WorkflowStorage } from './storage/index.js';
import { EventTransport, EventCallback, Unsubscribe } from './events/index.js';
export { BuiltInEventType, MemoryEventTransport, SocketIOEventTransport, SocketIOEventTransportConfig, SocketIOServer, SocketIOSocket, WebhookEndpoint, WebhookEventTransport, WebhookEventTransportConfig, WebhookPayload, WorkflowEvent, WorkflowEventType } from './events/index.js';
import { Database } from 'better-sqlite3';
import { Pool, PoolConfig } from 'pg';
import 'kysely';

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
        /** Maximum concurrent workflows (not yet implemented) */
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
    /**
     * Wait for a run to complete.
     * Polls the run status until it reaches a terminal state.
     *
     * @param runId - The run ID to wait for
     * @param options - Polling options
     * @returns The final run record
     */
    waitForRun(runId: string, options?: {
        pollInterval?: number;
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
    constructor(config: PostgresSchedulePersistenceConfig);
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

/**
 * ID generation utilities for the workflow engine.
 */
/**
 * Generate a unique ID for database records.
 * Uses a ULID-like format: base36 timestamp + random suffix.
 * This provides:
 * - Rough time-ordering (useful for debugging)
 * - High collision resistance
 * - URL-safe characters
 *
 * @returns A unique identifier string (approx 16 characters)
 */
declare function generateId(): string;

/**
 * Custom error classes for the workflow engine.
 */

/**
 * Base error class for workflow-related errors.
 */
declare class WorkflowEngineError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
    /**
     * Convert to a WorkflowError record for storage.
     */
    toRecord(): WorkflowError;
    /**
     * Create a WorkflowError record from any error.
     */
    static fromError(error: unknown, defaultCode?: string): WorkflowError;
}
/**
 * Error thrown when a workflow is not found in the registry.
 */
declare class WorkflowNotFoundError extends WorkflowEngineError {
    constructor(kind: string);
}
/**
 * Error thrown when a workflow is already registered.
 */
declare class WorkflowAlreadyRegisteredError extends WorkflowEngineError {
    constructor(kind: string);
}
/**
 * Error thrown when a run is not found.
 */
declare class RunNotFoundError extends WorkflowEngineError {
    constructor(runId: string);
}
/**
 * Error thrown when a step fails.
 */
declare class StepError extends WorkflowEngineError {
    readonly stepKey: string;
    readonly attempt: number;
    readonly cause?: Error;
    constructor(stepKey: string, message: string, attempt: number, cause?: Error);
}
/**
 * Error thrown when a step times out.
 */
declare class StepTimeoutError extends WorkflowEngineError {
    readonly stepKey: string;
    readonly timeoutMs: number;
    constructor(stepKey: string, timeoutMs: number);
}
/**
 * Error thrown when a workflow is canceled.
 */
declare class WorkflowCanceledError extends WorkflowEngineError {
    constructor(runId: string);
}
/**
 * Error thrown when a workflow times out.
 */
declare class WorkflowTimeoutError extends WorkflowEngineError {
    readonly timeoutMs: number;
    constructor(runId: string, timeoutMs: number);
}

/**
 * Logger utilities for the workflow engine.
 */

/**
 * Console-based logger implementation.
 * Uses console.log with prefixes for different levels.
 */
declare class ConsoleLogger implements Logger {
    private prefix;
    constructor(prefix?: string);
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/**
 * Silent logger that does nothing.
 * Useful for testing or when logs are not wanted.
 */
declare class SilentLogger implements Logger {
    debug(): void;
    info(): void;
    warn(): void;
    error(): void;
}
/**
 * Create a scoped logger that includes run/step context.
 */
declare function createScopedLogger(logger: Logger, runId: string, stepKey?: string): Logger;

/**
 * Retry utilities for the workflow engine.
 */
/**
 * Options for retry behavior.
 */
interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries: number;
    /** Initial delay between retries in ms (default: 1000) */
    delay: number;
    /** Backoff multiplier (default: 2) */
    backoff: number;
    /** Optional abort signal to cancel retries */
    signal?: AbortSignal;
    /** Optional callback before each retry */
    onRetry?: (attempt: number, error: Error, nextDelay: number) => void;
}
/**
 * Default retry options.
 */
declare const DEFAULT_RETRY_OPTIONS: RetryOptions;
/**
 * Sleep for a given number of milliseconds.
 * Can be canceled via AbortSignal.
 */
declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Execute a function with retry logic.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
declare function withRetry<T>(fn: () => Promise<T>, options?: Partial<RetryOptions>): Promise<T>;
/**
 * Calculate the delay for a specific retry attempt.
 */
declare function calculateRetryDelay(attempt: number, baseDelay: number, backoff: number): number;

/**
 * Planning types for the workflow engine.
 * Enables dynamic workflow orchestration through recipes and plans.
 */

/**
 * Comparison operators for recipe conditions.
 */
type ConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'matches' | 'exists' | 'notExists';
/**
 * A condition that determines when a recipe should be selected.
 * Conditions are evaluated against the workflow input.
 */
interface RecipeCondition {
    /** Input field to check (supports dot notation for nested fields) */
    field: string;
    /** Comparison operator */
    operator: ConditionOperator;
    /** Value to compare against (not required for exists/notExists) */
    value?: unknown;
}
/**
 * Default parameters for a recipe.
 */
interface RecipeDefaults {
    /** Workflow-level timeout in ms */
    timeout?: number;
    /** Default max retries for steps */
    maxRetries?: number;
    /** Base retry delay in ms */
    retryDelay?: number;
    /** Retry backoff multiplier */
    retryBackoff?: number;
    /** Default error strategy for steps */
    onError?: StepErrorStrategy;
}
/**
 * Reference to a step handler function.
 * The actual handler is resolved at plan execution time.
 */
interface StepHandlerRef {
    /** Unique handler identifier (e.g., 'handlers.loadDocument') */
    id: string;
    /** Human-readable description */
    description?: string;
}
/**
 * A step definition within a recipe.
 * Similar to WorkflowStep but uses handler references instead of functions.
 */
interface RecipeStep {
    /** Unique step identifier within the recipe */
    key: string;
    /** Human-readable step name */
    name: string;
    /** Reference to the step handler function */
    handlerRef: string;
    /** Step-specific configuration passed to the handler */
    config?: Record<string, unknown>;
    /** Error handling strategy */
    onError?: StepErrorStrategy;
    /** Maximum retry attempts */
    maxRetries?: number;
    /** Retry delay in ms */
    retryDelay?: number;
    /** Retry backoff multiplier */
    retryBackoff?: number;
    /** Step timeout in ms */
    timeout?: number;
    /**
     * Expression to evaluate for skipping (simple field reference).
     * If the referenced field is truthy, the step is skipped.
     * Example: 'input.skipValidation' or 'results.load.alreadyExists'
     */
    skipCondition?: string;
}
/**
 * A recipe is a reusable workflow configuration template.
 * Recipes define the steps to execute and conditions for selection.
 */
interface Recipe {
    /** Unique recipe identifier (e.g., 'summarize.comprehensive') */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what this recipe does */
    description?: string;
    /** Target workflow type */
    workflowKind: WorkflowKind;
    /** Variant name (e.g., 'default', 'fast', 'thorough') */
    variant: string;
    /** Ordered list of steps to execute */
    steps: RecipeStep[];
    /** Default parameters for this recipe */
    defaults?: RecipeDefaults;
    /** Conditions for auto-selecting this recipe */
    conditions?: RecipeCondition[];
    /** Selection priority (higher = preferred when multiple match) */
    priority?: number;
    /** Tags for categorization and filtering */
    tags?: string[];
}
/**
 * Types of modifications that can be made to a plan.
 */
type PlanModificationType = 'add_step' | 'remove_step' | 'modify_step' | 'reorder_steps' | 'set_default';
/**
 * A modification to apply to a recipe when generating a plan.
 */
interface PlanModification {
    /** Type of modification */
    type: PlanModificationType;
    /** Target step key (for step modifications) */
    stepKey?: string;
    /** New value or configuration */
    value: unknown;
    /** Human-readable reason for this modification */
    reason: string;
}
/**
 * A resolved step in a plan, ready for execution.
 */
interface PlannedStep {
    /** Unique step identifier */
    key: string;
    /** Human-readable step name */
    name: string;
    /** Reference to the step handler */
    handlerRef: string;
    /** Resolved configuration for this step */
    config: Record<string, unknown>;
    /** Error handling strategy */
    onError?: StepErrorStrategy;
    /** Maximum retry attempts */
    maxRetries?: number;
    /** Retry delay in ms */
    retryDelay?: number;
    /** Retry backoff multiplier */
    retryBackoff?: number;
    /** Step timeout in ms */
    timeout?: number;
    /** Skip condition expression */
    skipCondition?: string;
}
/**
 * A planned child workflow to spawn during execution.
 */
interface ChildWorkflowPlan {
    /** Workflow type to spawn */
    kind: WorkflowKind;
    /** Input for the child workflow */
    input: Record<string, unknown>;
    /** Whether to wait for the child to complete */
    waitFor?: boolean;
    /** Step key after which to spawn this workflow */
    afterStep?: string;
    /** Optional metadata for the child workflow */
    metadata?: Record<string, unknown>;
}
/**
 * Resource requirements estimated for a plan.
 */
interface ResourceEstimate {
    /** Estimated API calls */
    apiCalls?: number;
    /** Estimated LLM tokens */
    tokens?: number;
    /** Estimated duration in ms */
    duration?: number;
    /** Estimated memory usage in bytes */
    memory?: number;
}
/**
 * A plan is the output of planning - a concrete execution strategy.
 */
interface Plan {
    /** Unique plan identifier */
    id: string;
    /** Recipe this plan is based on */
    recipeId: string;
    /** Recipe variant used */
    variant: string;
    /** Modifications applied to the base recipe */
    modifications: PlanModification[];
    /** Final step sequence after modifications */
    steps: PlannedStep[];
    /** Child workflows to spawn */
    childWorkflows?: ChildWorkflowPlan[];
    /** Resolved default parameters */
    defaults: RecipeDefaults;
    /** Human-readable reasoning for plan decisions */
    reasoning?: string;
    /** Estimated resource requirements */
    resourceEstimate?: ResourceEstimate;
    /** When this plan was generated */
    createdAt: Date;
}
/**
 * Priority modes for planning.
 */
type PlanningPriority = 'speed' | 'quality' | 'cost' | 'balanced';
/**
 * Constraints that limit planning and execution.
 */
interface PlanningConstraints {
    /** Maximum allowed duration in ms */
    maxDuration?: number;
    /** Maximum API calls allowed */
    maxApiCalls?: number;
    /** Maximum LLM tokens allowed */
    maxTokens?: number;
    /** Optimization priority */
    priority?: PlanningPriority;
}
/**
 * User-provided hints to guide planning.
 */
interface PlanningHints {
    /** Preferred recipe variant */
    preferredVariant?: string;
    /** Specific recipe to use (bypasses selection) */
    forceRecipeId?: string;
    /** Steps to skip */
    skipSteps?: string[];
    /** Steps to include (even if normally skipped) */
    includeSteps?: string[];
    /** Focus areas (domain-specific) */
    focusAreas?: string[];
    /** Additional configuration to merge */
    additionalConfig?: Record<string, unknown>;
}
/**
 * Context provided to the planner for decision-making.
 */
interface PlanningContext {
    /** Parent workflow run ID (if spawned as child) */
    parentRunId?: string;
    /** Domain-specific metadata */
    metadata?: Record<string, unknown>;
    /** Resource constraints */
    constraints?: PlanningConstraints;
    /** User-provided hints */
    hints?: PlanningHints;
}
/**
 * Result of recipe selection.
 */
interface RecipeSelectionResult {
    /** Selected recipe */
    recipe: Recipe;
    /** Score indicating confidence (0-100) */
    score: number;
    /** Why this recipe was selected */
    reason: string;
}
/**
 * Validation result for a plan.
 */
interface PlanValidationResult {
    /** Whether the plan is valid */
    valid: boolean;
    /** Validation errors (if any) */
    errors: string[];
    /** Validation warnings */
    warnings: string[];
}
/**
 * Planner interface for generating execution plans.
 */
interface Planner {
    /**
     * Select the best recipe for a workflow and input.
     */
    selectRecipe(workflowKind: WorkflowKind, input: Record<string, unknown>, context?: PlanningContext): Promise<RecipeSelectionResult>;
    /**
     * Generate a plan from a recipe and input.
     */
    generatePlan(recipe: Recipe, input: Record<string, unknown>, context?: PlanningContext): Promise<Plan>;
    /**
     * Combined operation: select recipe and generate plan.
     */
    plan(workflowKind: WorkflowKind, input: Record<string, unknown>, context?: PlanningContext): Promise<Plan>;
    /**
     * Validate a plan before execution.
     */
    validatePlan(plan: Plan): PlanValidationResult;
    /**
     * Estimate resources required for a plan.
     */
    estimateResources(plan: Plan): ResourceEstimate;
}
/**
 * A registered step handler function.
 */
interface RegisteredStepHandler<TInput = Record<string, unknown>> {
    /** Unique handler identifier */
    id: string;
    /** Human-readable description */
    description?: string;
    /** The handler function */
    handler: WorkflowStep<TInput>['handler'];
    /** Tags for categorization */
    tags?: string[];
}
/**
 * Registry for step handlers.
 * Allows recipes to reference handlers by ID.
 */
interface StepHandlerRegistry {
    /**
     * Register a step handler.
     */
    register<TInput = Record<string, unknown>>(handler: RegisteredStepHandler<TInput>): void;
    /**
     * Get a handler by ID.
     */
    get(id: string): RegisteredStepHandler | undefined;
    /**
     * Check if a handler exists.
     */
    has(id: string): boolean;
    /**
     * List all registered handlers.
     */
    list(): RegisteredStepHandler[];
    /**
     * List handlers by tag.
     */
    listByTag(tag: string): RegisteredStepHandler[];
}
/**
 * Options for querying recipes.
 */
interface RecipeQueryOptions {
    /** Filter by workflow kind */
    workflowKind?: WorkflowKind;
    /** Filter by variant */
    variant?: string;
    /** Filter by tags (any match) */
    tags?: string[];
    /** Only include recipes matching conditions */
    matchConditions?: Record<string, unknown>;
}
/**
 * Registry for recipes.
 */
interface RecipeRegistry {
    /**
     * Register a recipe.
     */
    register(recipe: Recipe): void;
    /**
     * Register multiple recipes.
     */
    registerAll(recipes: Recipe[]): void;
    /**
     * Get a recipe by ID.
     */
    get(recipeId: string): Recipe | undefined;
    /**
     * Check if a recipe exists.
     */
    has(recipeId: string): boolean;
    /**
     * Get all recipes for a workflow kind.
     */
    getByKind(workflowKind: WorkflowKind): Recipe[];
    /**
     * Get a specific variant for a workflow kind.
     */
    getVariant(workflowKind: WorkflowKind, variant: string): Recipe | undefined;
    /**
     * Get the default recipe for a workflow kind.
     */
    getDefault(workflowKind: WorkflowKind): Recipe | undefined;
    /**
     * List all available variants for a workflow kind.
     */
    listVariants(workflowKind: WorkflowKind): string[];
    /**
     * Query recipes with filters.
     */
    query(options: RecipeQueryOptions): Recipe[];
    /**
     * List all registered recipes.
     */
    list(): Recipe[];
}

/**
 * Recipe and Step Handler registries.
 * Provides storage and retrieval of recipes and handlers.
 */

/**
 * In-memory implementation of the step handler registry.
 */
declare class MemoryStepHandlerRegistry implements StepHandlerRegistry {
    private handlers;
    private tagIndex;
    register<TInput = Record<string, unknown>>(handler: RegisteredStepHandler<TInput>): void;
    get(id: string): RegisteredStepHandler | undefined;
    has(id: string): boolean;
    list(): RegisteredStepHandler[];
    listByTag(tag: string): RegisteredStepHandler[];
    /**
     * Resolve a handler reference to a WorkflowStep handler function.
     * Returns undefined if the handler is not found.
     */
    resolve(handlerRef: string): WorkflowStep['handler'] | undefined;
    /**
     * Clear all registered handlers (useful for testing).
     */
    clear(): void;
}
/**
 * In-memory implementation of the recipe registry.
 */
declare class MemoryRecipeRegistry implements RecipeRegistry {
    private recipes;
    private kindIndex;
    private variantIndex;
    private tagIndex;
    register(recipe: Recipe): void;
    registerAll(recipes: Recipe[]): void;
    get(recipeId: string): Recipe | undefined;
    has(recipeId: string): boolean;
    getByKind(workflowKind: WorkflowKind): Recipe[];
    getVariant(workflowKind: WorkflowKind, variant: string): Recipe | undefined;
    getDefault(workflowKind: WorkflowKind): Recipe | undefined;
    listVariants(workflowKind: WorkflowKind): string[];
    query(options: RecipeQueryOptions): Recipe[];
    list(): Recipe[];
    /**
     * Clear all registered recipes (useful for testing).
     */
    clear(): void;
    /**
     * Evaluate recipe conditions against an input.
     * Returns true if all conditions match.
     */
    private evaluateConditions;
    /**
     * Get a nested value from an object using dot notation.
     */
    private getNestedValue;
    /**
     * Evaluate a single condition.
     */
    private evaluateCondition;
}
/**
 * Create a combined registry that holds both recipes and step handlers.
 */
interface CombinedRegistry {
    recipes: MemoryRecipeRegistry;
    handlers: MemoryStepHandlerRegistry;
}
/**
 * Create a new combined registry instance.
 */
declare function createRegistry(): CombinedRegistry;

/**
 * Rule-based planner implementation.
 * Selects recipes and generates plans based on conditions and input analysis.
 */

/**
 * Configuration for the RuleBasedPlanner.
 */
interface RuleBasedPlannerConfig {
    /** Recipe registry to use */
    recipeRegistry: RecipeRegistry;
    /** Step handler registry for validation */
    handlerRegistry?: StepHandlerRegistry;
    /** Whether to validate handler references during planning */
    validateHandlers?: boolean;
}
/**
 * Rule-based planner that selects recipes based on condition matching.
 */
declare class RuleBasedPlanner implements Planner {
    private recipeRegistry;
    private handlerRegistry?;
    private validateHandlers;
    constructor(config: RuleBasedPlannerConfig);
    /**
     * Select the best recipe for a workflow kind and input.
     */
    selectRecipe(workflowKind: WorkflowKind, input: Record<string, unknown>, context?: PlanningContext): Promise<RecipeSelectionResult>;
    /**
     * Generate a plan from a recipe and input.
     */
    generatePlan(recipe: Recipe, input: Record<string, unknown>, context?: PlanningContext): Promise<Plan>;
    /**
     * Combined operation: select recipe and generate plan.
     */
    plan(workflowKind: WorkflowKind, input: Record<string, unknown>, context?: PlanningContext): Promise<Plan>;
    /**
     * Validate a plan before execution.
     */
    validatePlan(plan: Plan): PlanValidationResult;
    /**
     * Estimate resources required for a plan.
     */
    estimateResources(plan: Plan): ResourceEstimate;
    /**
     * Convert a recipe step to a planned step.
     */
    private recipeStepToPlannedStep;
    /**
     * Apply constraints to steps and generate modifications.
     */
    private applyConstraints;
    /**
     * Build a human-readable selection reason.
     */
    private buildSelectionReason;
    /**
     * Build reasoning text for a plan.
     */
    private buildPlanReasoning;
}

export { type ChildWorkflowPlan, type CombinedRegistry, type ConditionOperator, ConsoleLogger, CronScheduler, type CronSchedulerConfig, DEFAULT_RETRY_OPTIONS, EventCallback, EventTransport, Logger, MemoryRecipeRegistry, MemoryStepHandlerRegistry, type Plan, type PlanModification, type PlanModificationType, type PlanValidationResult, type PlannedStep, type Planner, type PlanningConstraints, type PlanningContext, type PlanningHints, type PlanningPriority, PostgresSchedulePersistence, type PostgresSchedulePersistenceConfig, type Recipe, type RecipeCondition, type RecipeDefaults, type RecipeQueryOptions, type RecipeRegistry, type RecipeSelectionResult, type RecipeStep, type RegisteredStepHandler, type ResourceEstimate, type RetryOptions, RuleBasedPlanner, type RuleBasedPlannerConfig, RunNotFoundError, RunStatus, SQLiteSchedulePersistence, type SQLiteSchedulePersistenceConfig, type SchedulePersistence, type Scheduler, SilentLogger, type StartRunOptions, StepError, StepErrorStrategy, type StepHandlerRef, type StepHandlerRegistry, StepTimeoutError, StorageAdapter, type TriggerType, Unsubscribe, WorkflowAlreadyRegisteredError, WorkflowCanceledError, WorkflowDefinition, WorkflowEngine, type WorkflowEngineConfig, WorkflowEngineError, WorkflowError, WorkflowKind, WorkflowNotFoundError, WorkflowRunRecord, type WorkflowSchedule, WorkflowStep, WorkflowTimeoutError, calculateRetryDelay, createRegistry, createScopedLogger, generateId, sleep, withRetry };
