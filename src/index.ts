/**
 * Stepflow - Workflow Engine
 *
 * A framework-agnostic workflow engine that provides:
 * - Workflow Definition & Registration
 * - Async Execution Engine (non-blocking, fire-and-forget)
 * - State Management (run/step status tracking with checkpointing)
 * - Event System (real-time events for monitoring and UI updates)
 * - Pluggable Storage (bring your own database/persistence layer)
 * - Retry & Error Handling (configurable per-step error strategies)
 *
 * @example
 * ```typescript
 * import { WorkflowEngine, MemoryStorageAdapter } from 'stepflow';
 *
 * const engine = new WorkflowEngine({
 *   storage: new MemoryStorageAdapter(),
 * });
 *
 * engine.registerWorkflow({
 *   kind: 'email.send_campaign',
 *   name: 'Send Email Campaign',
 *   steps: [
 *     {
 *       key: 'load_recipients',
 *       name: 'Load Recipients',
 *       handler: async (ctx) => {
 *         const recipients = await loadRecipients(ctx.input.campaignId);
 *         return { recipients };
 *       },
 *     },
 *     {
 *       key: 'send_emails',
 *       name: 'Send Emails',
 *       handler: async (ctx) => {
 *         const { recipients } = ctx.results.load_recipients;
 *         // Send emails...
 *         return { sent: recipients.length };
 *       },
 *       onError: 'retry',
 *       maxRetries: 3,
 *     },
 *   ],
 * });
 *
 * const runId = await engine.startRun({
 *   kind: 'email.send_campaign',
 *   input: { campaignId: '123' },
 * });
 *
 * // Subscribe to events
 * engine.subscribeToRun(runId, (event) => {
 *   console.log(`${event.eventType}: ${event.stepKey ?? 'run'}`);
 * });
 * ```
 */

// ============================================================================
// Core Types and Classes
// ============================================================================

export {
  // Types
  type WorkflowKind,
  type RunStatus,
  type StepStatus,
  type StepErrorStrategy,
  type WorkflowError,
  type RunResult,
  type Logger,
  type SpawnChildOptions,
  type WorkflowContext,
  type WorkflowStep,
  type WorkflowHooks,
  type WorkflowDefinition,
} from './core/types';

export {
  // Main Engine
  WorkflowEngine,
  type WorkflowEngineConfig,
  type StartRunOptions,
} from './core/engine';

// ============================================================================
// Storage
// ============================================================================

export {
  // Types
  type StorageAdapter,
  type WorkflowRunRecord,
  type WorkflowRunStepRecord,
  type WorkflowEventRecord,
  type ListRunsOptions,
  type ListEventsOptions,
  type PaginatedResult,
} from './storage/types';

export {
  // In-Memory Storage
  MemoryStorageAdapter,
} from './storage/memory';

export {
  // SQLite Storage
  SQLiteStorageAdapter,
  type SQLiteStorageConfig,
} from './storage/sqlite';

export {
  // PostgreSQL Storage
  PostgresStorageAdapter,
  type PostgresStorageConfig,
} from './storage/postgres';

// ============================================================================
// Events
// ============================================================================

export {
  // Types
  type EventTransport,
  type WorkflowEvent,
  type WorkflowEventType,
  type BuiltInEventType,
  type EventCallback,
  type Unsubscribe,
} from './events/types';

export {
  // In-Memory Event Transport
  MemoryEventTransport,
} from './events/memory';

export {
  // Socket.IO Event Transport
  SocketIOEventTransport,
  type SocketIOEventTransportConfig,
  type SocketIOServer,
  type SocketIOSocket,
} from './events/socketio';

export {
  // Webhook Event Transport
  WebhookEventTransport,
  type WebhookEventTransportConfig,
  type WebhookEndpoint,
  type WebhookPayload,
} from './events/webhook';

// ============================================================================
// Scheduler
// ============================================================================

export {
  type TriggerType,
  type WorkflowSchedule,
  type Scheduler,
} from './scheduler/types';

export {
  CronScheduler,
  type CronSchedulerConfig,
  type SchedulePersistence,
} from './scheduler/cron';

export {
  SQLiteSchedulePersistence,
  type SQLiteSchedulePersistenceConfig,
} from './scheduler/sqlite-persistence';

export {
  PostgresSchedulePersistence,
  type PostgresSchedulePersistenceConfig,
} from './scheduler/postgres-persistence';

// ============================================================================
// Utilities
// ============================================================================

export {
  // ID Generation
  generateId,
} from './utils/id';

export {
  // Errors
  WorkflowEngineError,
  WorkflowNotFoundError,
  WorkflowAlreadyRegisteredError,
  RunNotFoundError,
  StepError,
  StepTimeoutError,
  WorkflowCanceledError,
  WorkflowTimeoutError,
} from './utils/errors';

export {
  // Logger
  ConsoleLogger,
  SilentLogger,
  createScopedLogger,
} from './utils/logger';

export {
  // Retry
  type RetryOptions,
  DEFAULT_RETRY_OPTIONS,
  sleep,
  withRetry,
  calculateRetryDelay,
} from './utils/retry';

// ============================================================================
// Planning
// ============================================================================

export {
  // Types
  type ConditionOperator,
  type RecipeCondition,
  type RecipeDefaults,
  type StepHandlerRef,
  type RecipeStep,
  type Recipe,
  type PlanModificationType,
  type PlanModification,
  type PlannedStep,
  type ChildWorkflowPlan,
  type ResourceEstimate,
  type Plan,
  type PlanningPriority,
  type PlanningConstraints,
  type PlanningHints,
  type PlanningContext,
  type RecipeSelectionResult,
  type PlanValidationResult,
  type Planner,
  type RegisteredStepHandler,
  type StepHandlerRegistry,
  type RecipeQueryOptions,
  type RecipeRegistry,

  // Implementations
  MemoryStepHandlerRegistry,
  MemoryRecipeRegistry,
  createRegistry,
  type CombinedRegistry,
  RuleBasedPlanner,
  type RuleBasedPlannerConfig,
} from './planning';
