/**
 * Core types for the workflow engine.
 * These are the foundational interfaces used throughout the system.
 */
/**
 * Unique identifier for a workflow type.
 * Used to register and look up workflow definitions.
 */
type WorkflowKind = string;
/**
 * Status of a workflow run.
 */
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
/**
 * Status of a workflow step.
 */
type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled';
/**
 * Error handling strategy for a step.
 * - 'fail': Stop the workflow immediately
 * - 'retry': Retry the step up to maxRetries times
 * - 'skip': Mark as skipped and continue to next step
 */
type StepErrorStrategy = 'fail' | 'retry' | 'skip';
/**
 * Structured error information stored with runs and steps.
 */
interface WorkflowError {
    code: string;
    message: string;
    stack?: string;
    details?: Record<string, unknown>;
}
/**
 * Result of a completed workflow run.
 */
interface RunResult {
    status: 'succeeded' | 'failed' | 'canceled';
    results: Record<string, unknown>;
    error?: WorkflowError;
    duration: number;
}
/**
 * Minimal logger interface that consumers can implement.
 * Compatible with console, pino, winston, etc.
 */
interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/**
 * Options for spawning a child workflow from within a step handler.
 */
interface SpawnChildOptions {
    kind: WorkflowKind;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
/**
 * Runtime context passed to each step handler.
 * Contains all information a step needs to execute and interact with the engine.
 */
interface WorkflowContext<TInput = Record<string, unknown>> {
    /** Unique run identifier */
    runId: string;
    /** Current step identifier (for granular tracking, e.g., token usage) */
    stepId: string;
    /** Workflow type */
    kind: WorkflowKind;
    /** Input parameters passed when starting the run */
    input: TInput;
    /** Accumulated results from previous steps (keyed by step key) */
    results: Record<string, unknown>;
    /** Optional metadata (topicId, userId, etc.) */
    metadata: Record<string, unknown>;
    /** Current step key (set during execution) */
    currentStep?: string;
    /** Logger instance scoped to this run */
    logger: Logger;
    /** Abort signal for cancellation */
    signal: AbortSignal;
    /** Helper to spawn child workflows */
    spawnChild: (options: SpawnChildOptions) => Promise<string>;
    /** Helper to emit custom events */
    emit: (eventType: string, payload?: unknown) => void;
}
/**
 * Definition of a single workflow step.
 * Steps are executed sequentially within a workflow.
 */
interface WorkflowStep<TInput = Record<string, unknown>> {
    /** Unique step identifier within the workflow */
    key: string;
    /** Human-readable step name */
    name: string;
    /** Async function that performs the step's work */
    handler: (ctx: WorkflowContext<TInput>) => Promise<unknown>;
    /** What to do when the step fails (default: 'fail') */
    onError?: StepErrorStrategy;
    /** Maximum retry attempts when onError is 'retry' @default 3 */
    maxRetries?: number;
    /** Delay between retries in ms @default 1000 */
    retryDelay?: number;
    /** Exponential backoff multiplier @default 2 */
    retryBackoff?: number;
    /** Timeout for this step in ms (optional) */
    timeout?: number;
    /** Condition to skip this step */
    skipIf?: (ctx: WorkflowContext<TInput>) => boolean | Promise<boolean>;
}
/**
 * Lifecycle hooks for workflows.
 * Allow custom logic at key points in the workflow execution.
 */
interface WorkflowHooks<TInput = Record<string, unknown>> {
    /** Called before workflow starts */
    beforeRun?: (ctx: WorkflowContext<TInput>) => Promise<void>;
    /** Called after workflow completes (success or failure) */
    afterRun?: (ctx: WorkflowContext<TInput>, result: RunResult) => Promise<void>;
    /** Called before each step */
    beforeStep?: (ctx: WorkflowContext<TInput>, step: WorkflowStep<TInput>) => Promise<void>;
    /** Called after each step (success only) */
    afterStep?: (ctx: WorkflowContext<TInput>, step: WorkflowStep<TInput>, result: unknown) => Promise<void>;
    /** Called when a step fails */
    onStepError?: (ctx: WorkflowContext<TInput>, step: WorkflowStep<TInput>, error: Error) => Promise<void>;
}
/**
 * Complete workflow definition.
 * Registered with the engine to enable starting runs of this type.
 */
interface WorkflowDefinition<TInput = Record<string, unknown>> {
    /** Unique workflow type identifier */
    kind: WorkflowKind;
    /** Human-readable workflow name */
    name: string;
    /** Optional description */
    description?: string;
    /** Ordered list of steps to execute */
    steps: WorkflowStep<TInput>[];
    /** Default error strategy for all steps (default: 'fail') */
    defaultOnError?: StepErrorStrategy;
    /** Global timeout for the entire workflow in ms */
    timeout?: number;
    /** Hooks for workflow lifecycle */
    hooks?: WorkflowHooks<TInput>;
}

export type { Logger as L, RunStatus as R, StepStatus as S, WorkflowKind as W, WorkflowError as a, StepErrorStrategy as b, WorkflowStep as c, RunResult as d, SpawnChildOptions as e, WorkflowContext as f, WorkflowDefinition as g, WorkflowHooks as h };
