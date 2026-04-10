/**
 * Core types for the workflow engine.
 * These are the foundational interfaces used throughout the system.
 */

// ============================================================================
// Basic Types
// ============================================================================

/**
 * Unique identifier for a workflow type.
 * Used to register and look up workflow definitions.
 */
export type WorkflowKind = string;

/**
 * Status of a workflow run.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/**
 * Status of a workflow step.
 */
export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

/**
 * Error handling strategy for a step.
 * - 'fail': Stop the workflow immediately
 * - 'retry': Retry the step up to maxRetries times
 * - 'skip': Mark as skipped and continue to next step
 */
export type StepErrorStrategy = "fail" | "retry" | "skip";

// ============================================================================
// Error Types
// ============================================================================

/**
 * Structured error information stored with runs and steps.
 */
export interface WorkflowError {
  code: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
}

/**
 * Result of a completed workflow run.
 */
export interface RunResult {
  status: "succeeded" | "failed" | "canceled";
  results: Record<string, unknown>;
  error?: WorkflowError;
  duration: number;
}

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Minimal logger interface that consumers can implement.
 * Compatible with console, pino, winston, etc.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Spawn Child Options
// ============================================================================

/**
 * Options for spawning a child workflow from within a step handler.
 */
export interface SpawnChildOptions {
  kind: WorkflowKind;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Workflow Context
// ============================================================================

/**
 * Runtime context passed to each step handler.
 * Contains all information a step needs to execute and interact with the engine.
 */
export interface WorkflowContext<TInput = Record<string, unknown>> {
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

// ============================================================================
// Workflow Step
// ============================================================================

/**
 * Definition of a single workflow step.
 * Steps are executed sequentially within a workflow.
 */
export interface WorkflowStep<TInput = Record<string, unknown>> {
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

// ============================================================================
// Workflow Hooks
// ============================================================================

/**
 * Lifecycle hooks for workflows.
 * Allow custom logic at key points in the workflow execution.
 */
export interface WorkflowHooks<TInput = Record<string, unknown>> {
  /** Called before workflow starts */
  beforeRun?: (ctx: WorkflowContext<TInput>) => Promise<void>;

  /** Called after workflow completes (success or failure) */
  afterRun?: (ctx: WorkflowContext<TInput>, result: RunResult) => Promise<void>;

  /** Called before each step */
  beforeStep?: (
    ctx: WorkflowContext<TInput>,
    step: WorkflowStep<TInput>,
  ) => Promise<void>;

  /** Called after each step (success only) */
  afterStep?: (
    ctx: WorkflowContext<TInput>,
    step: WorkflowStep<TInput>,
    result: unknown,
  ) => Promise<void>;

  /** Called when a step fails */
  onStepError?: (
    ctx: WorkflowContext<TInput>,
    step: WorkflowStep<TInput>,
    error: Error,
  ) => Promise<void>;
}

// ============================================================================
// Workflow Definition
// ============================================================================

/**
 * Complete workflow definition.
 * Registered with the engine to enable starting runs of this type.
 */
export interface WorkflowDefinition<TInput = Record<string, unknown>> {
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
