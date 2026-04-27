/**
 * Main WorkflowEngine class.
 *
 * This is the primary entry point for the workflow engine.
 * It provides methods for registering workflows, starting runs,
 * and managing workflow execution.
 *
 * Internal concerns are decomposed into co-located submodules under
 * `./engine/` (see `engine/concurrency.ts`, `engine/lifecycle.ts`).
 * WorkflowEngine itself stays the thin public face.
 */

import type {
  WorkflowKind,
  WorkflowDefinition,
  WorkflowContext,
  Logger,
  SpawnChildOptions,
} from './types';
import type { StorageAdapter, WorkflowRunRecord } from '../storage/types';
import type { EventTransport, EventCallback, Unsubscribe, WorkflowEvent } from '../events/types';
import { MemoryStorageAdapter } from '../storage/memory';
import { MemoryEventTransport } from '../events/memory';
import { executeWorkflow } from './orchestrator';
import {
  WorkflowNotFoundError,
  WorkflowAlreadyRegisteredError,
  RunNotFoundError,
  WaitForRunTimeoutError,
} from '../utils/errors';
import { ConsoleLogger } from '../utils/logger';
import { ConcurrencyManager, type QueuedRun } from './engine/concurrency';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the workflow engine.
 */
export interface WorkflowEngineConfig {
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
export interface StartRunOptions<TInput = Record<string, unknown>> {
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

// ============================================================================
// WorkflowEngine Class
// ============================================================================

/**
 * Main workflow engine class.
 *
 * @example
 * ```typescript
 * const engine = new WorkflowEngine({
 *   storage: new MemoryStorageAdapter(),
 * });
 *
 * engine.registerWorkflow({
 *   kind: 'my.workflow',
 *   name: 'My Workflow',
 *   steps: [
 *     {
 *       key: 'step1',
 *       name: 'First Step',
 *       handler: async (ctx) => {
 *         return { message: 'Hello!' };
 *       },
 *     },
 *   ],
 * });
 *
 * const runId = await engine.startRun({ kind: 'my.workflow' });
 * ```
 */
export class WorkflowEngine {
  private registry = new Map<WorkflowKind, WorkflowDefinition>();
  private storage: StorageAdapter;
  private events: EventTransport;
  private logger: Logger;
  private settings: NonNullable<WorkflowEngineConfig['settings']>;
  private concurrency: ConcurrencyManager;

  constructor(config: WorkflowEngineConfig = {}) {
    this.storage = config.storage ?? new MemoryStorageAdapter();
    this.events = config.events ?? new MemoryEventTransport();
    this.logger = config.logger ?? new ConsoleLogger();
    this.settings = config.settings ?? {};
    this.concurrency = new ConcurrencyManager({
      storage: this.storage,
      events: this.events,
      logger: this.logger,
      maxConcurrency: this.settings.maxConcurrency,
    });
  }

  /**
   * Initialize the engine and its storage/event adapters.
   * Call this before starting runs if your storage adapter requires initialization
   * (e.g., PostgresStorageAdapter).
   */
  async initialize(): Promise<void> {
    if (this.storage.initialize) {
      await this.storage.initialize();
    }
  }

  /**
   * Get the current number of active runs.
   */
  getActiveRunCount(): number {
    return this.concurrency.getActiveCount();
  }

  /**
   * Get the number of queued runs waiting for capacity.
   */
  getQueuedRunCount(): number {
    return this.concurrency.getQueuedCount();
  }

  // ============================================================================
  // Workflow Registration
  // ============================================================================

  /**
   * Register a workflow definition.
   * Must be called before runs of this type can be started.
   *
   * @param definition - The workflow definition
   * @throws WorkflowAlreadyRegisteredError if already registered
   */
  registerWorkflow<TInput = Record<string, unknown>>(
    definition: WorkflowDefinition<TInput>
  ): void {
    if (this.registry.has(definition.kind)) {
      throw new WorkflowAlreadyRegisteredError(definition.kind);
    }
    this.registry.set(definition.kind, definition as WorkflowDefinition);
    this.logger.debug(`Registered workflow: ${definition.kind}`);
  }

  /**
   * Unregister a workflow definition.
   *
   * @param kind - The workflow kind to unregister
   * @returns true if the workflow was unregistered, false if not found
   */
  unregisterWorkflow(kind: WorkflowKind): boolean {
    const deleted = this.registry.delete(kind);
    if (deleted) {
      this.logger.debug(`Unregistered workflow: ${kind}`);
    }
    return deleted;
  }

  /**
   * Get a registered workflow definition.
   *
   * @param kind - The workflow kind
   * @returns The workflow definition or undefined
   */
  getWorkflow(kind: WorkflowKind): WorkflowDefinition | undefined {
    return this.registry.get(kind);
  }

  /**
   * Get all registered workflow kinds.
   */
  getRegisteredWorkflows(): WorkflowKind[] {
    return Array.from(this.registry.keys());
  }

  // ============================================================================
  // Run Management
  // ============================================================================

  /**
   * Start a new workflow run (non-blocking).
   * The run executes asynchronously and this method returns immediately.
   * If maxConcurrency is set and reached, the run is queued.
   *
   * @param options - Run options including kind and input
   * @returns The generated run ID
   * @throws WorkflowNotFoundError if the workflow kind is not registered
   */
  async startRun<TInput = Record<string, unknown>>(
    options: StartRunOptions<TInput>
  ): Promise<string> {
    const definition = this.registry.get(options.kind);
    if (!definition) {
      throw new WorkflowNotFoundError(options.kind);
    }

    // Create run record (status: queued)
    const run = await this.storage.createRun({
      kind: options.kind,
      status: 'queued',
      parentRunId: options.parentRunId,
      input: (options.input ?? {}) as Record<string, unknown>,
      metadata: options.metadata ?? {},
      context: {},
    });

    const runId = run.id;

    // Emit run created event
    this.events.emit({
      runId,
      kind: options.kind,
      eventType: 'run.created',
      timestamp: new Date(),
      payload: { input: options.input, metadata: options.metadata, priority: options.priority ?? 0 },
    });

    // Check if we have capacity to start immediately
    if (this.concurrency.hasCapacity()) {
      // Start execution immediately
      this.executeRun(
        runId,
        definition,
        (options.input ?? {}) as Record<string, unknown>,
        options.metadata,
        options.delay
      );
    } else {
      // Queue the run for later execution
      this.concurrency.enqueue({
        runId,
        definition,
        input: (options.input ?? {}) as Record<string, unknown>,
        metadata: options.metadata,
        priority: options.priority ?? 0,
        queuedAt: new Date(),
      });

      this.logger.debug(`Run ${runId} queued (${this.concurrency.getQueuedCount()} in queue)`);

      // Emit queued event
      this.events.emit({
        runId,
        kind: options.kind,
        eventType: 'run.queued',
        timestamp: new Date(),
        payload: { queuePosition: this.concurrency.getQueuedCount() },
      });
    }

    return runId;
  }

  /**
   * Execute a run (internal method).
   */
  private executeRun(
    runId: string,
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    delay?: number
  ): void {
    this.launchRun(runId, definition, input, metadata, delay);
  }

  /**
   * Launch a workflow run asynchronously.
   * Shared by both executeRun (new runs) and resumeRun (checkpoint recovery).
   */
  private launchRun(
    runId: string,
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    delay?: number,
    checkpoint?: { completedStepKeys: Set<string>; results: Record<string, unknown> }
  ): void {
    const abortController = new AbortController();
    this.concurrency.registerActive(runId, abortController);

    const execute = async () => {
      try {
        await executeWorkflow({
          runId,
          definition,
          input,
          metadata,
          storage: this.storage,
          events: this.events,
          logger: this.logger,
          abortController,
          spawnChild: (childOptions: SpawnChildOptions) => this.spawnChild(runId, childOptions),
          checkpoint,
        });
      } finally {
        this.concurrency.unregisterActive(runId);
        this.processQueue();
      }
    };

    // executeWorkflow has its own try/catch that converts errors into a failed
    // run record, but the surrounding `finally` (unregisterActive + processQueue)
    // could still throw, and `setTimeout`/`setImmediate` discards the returned
    // promise — leaving any rejection unhandled and capable of crashing Node.
    // Wrap the launch so those rejections are logged instead.
    const guarded = () => {
      execute().catch((err) => {
        this.concurrency.unregisterActive(runId);
        this.logger.error(`Unhandled error launching run ${runId}`, err);
      });
    };

    this.concurrency.scheduleLaunch(guarded, delay);
  }

  /**
   * Drain the queue, dispatching each ready run via `executeRun`. Resilience
   * against per-item dispatch failures lives in `ConcurrencyManager.processQueue`.
   */
  private processQueue(): void {
    this.concurrency.processQueue((next) => {
      this.executeRun(next.runId, next.definition, next.input, next.metadata);
    });
  }

  /**
   * Start a child workflow from within a parent workflow.
   * Called internally by the context.spawnChild helper.
   */
  private async spawnChild(parentRunId: string, options: SpawnChildOptions): Promise<string> {
    return this.startRun({
      kind: options.kind,
      input: options.input,
      metadata: options.metadata,
      parentRunId,
    });
  }

  /**
   * Cancel a running workflow.
   * Signals the workflow to stop at the next cancellation point.
   *
   * @param runId - The run ID to cancel
   * @throws {RunNotFoundError} If no run with the given ID exists
   */
  async cancelRun(runId: string): Promise<void> {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    // Don't overwrite terminal statuses
    if (['succeeded', 'failed', 'canceled', 'timeout'].includes(run.status)) {
      return;
    }

    // Remove from queue if queued, then signal abort if active
    this.concurrency.removeFromQueue(runId);
    this.concurrency.abortActive(runId);

    // Update status in storage (the orchestrator will also update on completion)
    await this.storage.updateRun(runId, {
      status: 'canceled',
      finishedAt: new Date(),
    });

    this.events.emit({
      runId,
      kind: run.kind,
      eventType: 'run.canceled',
      timestamp: new Date(),
    });
  }

  /**
   * Get the current status of a run.
   *
   * @param runId - The run ID to look up
   * @returns The run record or null if not found
   */
  async getRunStatus(runId: string): Promise<WorkflowRunRecord | null> {
    return this.storage.getRun(runId);
  }

  private static readonly TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled', 'timeout'];
  private static readonly TERMINAL_EVENT_TYPES = ['run.completed', 'run.failed', 'run.canceled', 'run.timeout'];

  /**
   * Wait for a run to complete.
   * Subscribes to run events and resolves when a terminal event fires.
   * Falls back to an initial storage read to avoid race conditions.
   *
   * @param runId - The run ID to wait for
   * @param options - Wait options
   * @returns The final run record
   */
  async waitForRun(
    runId: string,
    options: { timeout?: number } = {}
  ): Promise<WorkflowRunRecord> {
    const timeout = options.timeout ?? 60000;

    return new Promise<WorkflowRunRecord>(async (resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) unsubscribe();
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      // Set up timeout
      timeoutId = setTimeout(() => {
        settle(() => reject(new WaitForRunTimeoutError(runId, timeout)));
      }, timeout);

      // Subscribe to run events FIRST to avoid missing terminal events
      unsubscribe = this.events.subscribe(runId, async (event) => {
        if (WorkflowEngine.TERMINAL_EVENT_TYPES.includes(event.eventType)) {
          try {
            const run = await this.storage.getRun(runId);
            settle(() => {
              if (!run) {
                reject(new RunNotFoundError(runId));
              } else {
                resolve(run);
              }
            });
          } catch (err) {
            settle(() => reject(err));
          }
        }
      });

      // THEN check storage for already-terminal runs
      try {
        const existingRun = await this.storage.getRun(runId);
        if (!existingRun) {
          settle(() => reject(new RunNotFoundError(runId)));
          return;
        }
        if (WorkflowEngine.TERMINAL_STATUSES.includes(existingRun.status)) {
          settle(() => resolve(existingRun));
          return;
        }
      } catch (err) {
        settle(() => reject(err));
      }
    });
  }

  // ============================================================================
  // Resume Support
  // ============================================================================

  /**
   * Resume an interrupted workflow run from its checkpoint.
   * The run must be in 'queued' or 'running' status.
   *
   * @param runId - The run ID to resume
   * @returns The run ID (same as input)
   * @throws {RunNotFoundError} If no run with the given ID exists
   * @throws {Error} If the run status is not 'queued' or 'running'
   * @throws {WorkflowNotFoundError} If the workflow kind is not registered
   */
  async resumeRun(runId: string): Promise<string> {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    // Check if run can be resumed
    if (!['queued', 'running'].includes(run.status)) {
      throw new Error(`Cannot resume run ${runId}: status is "${run.status}"`);
    }

    // Get the workflow definition
    const definition = this.registry.get(run.kind);
    if (!definition) {
      throw new WorkflowNotFoundError(run.kind);
    }

    // Check if already being executed
    if (this.concurrency.isActive(runId)) {
      this.logger.warn(`Run ${runId} is already active, skipping resume`);
      return runId;
    }

    this.logger.info(`Resuming run ${runId} from checkpoint`);

    // Get completed step keys from the dedicated completedSteps field
    const completedStepKeys = new Set(run.completedSteps ?? []);

    this.launchRun(runId, definition, run.input, run.metadata, undefined, {
      completedStepKeys,
      results: run.context,
    });

    return runId;
  }

  /**
   * Get all runs that were interrupted and can be resumed.
   * Returns runs with status 'queued' or 'running'.
   */
  async getResumableRuns(): Promise<WorkflowRunRecord[]> {
    const result = await this.storage.listRuns({
      status: ['queued', 'running'],
    });
    return result.items;
  }

  /**
   * Resume all interrupted runs.
   * Useful for recovering after a server restart.
   *
   * @returns Array of resumed run IDs
   */
  async resumeAllInterrupted(): Promise<string[]> {
    const resumableRuns = await this.getResumableRuns();
    const resumedIds: string[] = [];

    for (const run of resumableRuns) {
      // Only resume if the workflow is registered
      if (this.registry.has(run.kind)) {
        try {
          await this.resumeRun(run.id);
          resumedIds.push(run.id);
        } catch (error) {
          this.logger.error(`Failed to resume run ${run.id}:`, error);
        }
      } else {
        this.logger.warn(`Cannot resume run ${run.id}: workflow "${run.kind}" not registered`);
      }
    }

    return resumedIds;
  }

  // ============================================================================
  // Event Subscription
  // ============================================================================

  /**
   * Subscribe to events for a specific run.
   *
   * @param runId - The run ID to subscribe to
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  subscribeToRun(runId: string, callback: EventCallback): Unsubscribe {
    return this.events.subscribe(runId, callback);
  }

  /**
   * Subscribe to all workflow events.
   *
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  subscribeToAll(callback: EventCallback): Unsubscribe {
    return this.events.subscribeAll(callback);
  }

  // ============================================================================
  // Storage Access
  // ============================================================================

  /**
   * Get the storage adapter.
   * Useful for querying runs and steps directly.
   */
  getStorage(): StorageAdapter {
    return this.storage;
  }

  /**
   * Get the event transport.
   * Useful for custom event handling.
   */
  getEvents(): EventTransport {
    return this.events;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Shutdown the engine gracefully.
   * Cancels all active runs and closes resources.
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down workflow engine...');

    this.concurrency.clearTimers();

    this.concurrency.abortAllActive((runId) => {
      this.logger.debug(`Canceling active run: ${runId}`);
    });

    // Close event transport
    if (this.events.close) {
      this.events.close();
    }

    // Close storage adapter
    if (this.storage.close) {
      await this.storage.close();
    }

    this.concurrency.clearActive();
    this.logger.info('Workflow engine shutdown complete');
  }
}
