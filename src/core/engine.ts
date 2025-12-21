/**
 * Main WorkflowEngine class.
 *
 * This is the primary entry point for the workflow engine.
 * It provides methods for registering workflows, starting runs,
 * and managing workflow execution.
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
} from '../utils/errors';
import { ConsoleLogger } from '../utils/logger';

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

    /** Maximum concurrent workflows (not yet implemented) */
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
/**
 * Queued run waiting to be executed when capacity is available.
 */
interface QueuedRun {
  runId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority: number;
  queuedAt: Date;
}

export class WorkflowEngine {
  private registry = new Map<WorkflowKind, WorkflowDefinition>();
  private storage: StorageAdapter;
  private events: EventTransport;
  private logger: Logger;
  private activeRuns = new Map<string, AbortController>();
  private settings: NonNullable<WorkflowEngineConfig['settings']>;
  private runQueue: QueuedRun[] = [];

  constructor(config: WorkflowEngineConfig = {}) {
    this.storage = config.storage ?? new MemoryStorageAdapter();
    this.events = config.events ?? new MemoryEventTransport();
    this.logger = config.logger ?? new ConsoleLogger();
    this.settings = config.settings ?? {};
  }

  /**
   * Get the current number of active runs.
   */
  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  /**
   * Get the number of queued runs waiting for capacity.
   */
  getQueuedRunCount(): number {
    return this.runQueue.length;
  }

  /**
   * Check if capacity is available for a new run.
   */
  private hasCapacity(): boolean {
    const maxConcurrency = this.settings.maxConcurrency;
    if (maxConcurrency === undefined || maxConcurrency <= 0) {
      return true; // No limit
    }
    return this.activeRuns.size < maxConcurrency;
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
    if (this.hasCapacity()) {
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
      this.queueRun({
        runId,
        definition,
        input: (options.input ?? {}) as Record<string, unknown>,
        metadata: options.metadata,
        priority: options.priority ?? 0,
        queuedAt: new Date(),
      });

      this.logger.debug(`Run ${runId} queued (${this.runQueue.length} in queue)`);

      // Emit queued event
      this.events.emit({
        runId,
        kind: options.kind,
        eventType: 'run.queued',
        timestamp: new Date(),
        payload: { queuePosition: this.runQueue.length },
      });
    }

    return runId;
  }

  /**
   * Queue a run in priority order.
   */
  private queueRun(queuedRun: QueuedRun): void {
    // Insert in priority order (higher priority first, then FIFO for same priority)
    let inserted = false;
    for (let i = 0; i < this.runQueue.length; i++) {
      if (queuedRun.priority > this.runQueue[i].priority) {
        this.runQueue.splice(i, 0, queuedRun);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.runQueue.push(queuedRun);
    }
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
    // Create abort controller for this run
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);

    // Execute asynchronously (fire and forget)
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
        });
      } finally {
        this.activeRuns.delete(runId);
        // Try to start next queued run
        this.processQueue();
      }
    };

    if (delay) {
      setTimeout(execute, delay);
    } else {
      // Use setImmediate to ensure the function returns before execution starts
      setImmediate(execute);
    }
  }

  /**
   * Process the queue and start runs if capacity is available.
   */
  private processQueue(): void {
    while (this.hasCapacity() && this.runQueue.length > 0) {
      const next = this.runQueue.shift()!;
      this.logger.debug(`Starting queued run ${next.runId}`);

      // Emit dequeued event
      this.events.emit({
        runId: next.runId,
        kind: next.definition.kind,
        eventType: 'run.dequeued',
        timestamp: new Date(),
      });

      this.executeRun(
        next.runId,
        next.definition,
        next.input,
        next.metadata
      );
    }
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
   * @throws RunNotFoundError if the run is not found
   */
  async cancelRun(runId: string): Promise<void> {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    // Signal abort to the running workflow
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
    }

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

  /**
   * Wait for a run to complete.
   * Polls the run status until it reaches a terminal state.
   *
   * @param runId - The run ID to wait for
   * @param options - Polling options
   * @returns The final run record
   */
  async waitForRun(
    runId: string,
    options: { pollInterval?: number; timeout?: number } = {}
  ): Promise<WorkflowRunRecord> {
    const pollInterval = options.pollInterval ?? 100;
    const timeout = options.timeout ?? 60000;
    const startTime = Date.now();

    while (true) {
      const run = await this.storage.getRun(runId);
      if (!run) {
        throw new RunNotFoundError(runId);
      }

      if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
        return run;
      }

      if (Date.now() - startTime > timeout) {
        throw new Error(`Timeout waiting for run ${runId}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
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
   * @throws RunNotFoundError if the run is not found
   * @throws Error if the run is already completed or workflow not registered
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
    if (this.activeRuns.has(runId)) {
      this.logger.warn(`Run ${runId} is already active, skipping resume`);
      return runId;
    }

    this.logger.info(`Resuming run ${runId} from checkpoint`);

    // Get completed step keys from the context
    const completedStepKeys = new Set(Object.keys(run.context));

    // Create abort controller for this run
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);

    // Emit resume event
    this.events.emit({
      runId,
      kind: run.kind,
      eventType: 'run.resumed',
      timestamp: new Date(),
      payload: { completedSteps: Array.from(completedStepKeys) },
    });

    // Execute asynchronously (fire and forget)
    const execute = async () => {
      try {
        await executeWorkflow({
          runId,
          definition,
          input: run.input,
          metadata: run.metadata,
          storage: this.storage,
          events: this.events,
          logger: this.logger,
          abortController,
          spawnChild: (childOptions: SpawnChildOptions) => this.spawnChild(runId, childOptions),
          // Pass the checkpoint data
          checkpoint: {
            completedStepKeys,
            results: run.context,
          },
        });
      } finally {
        this.activeRuns.delete(runId);
      }
    };

    setImmediate(execute);

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

    // Cancel all active runs
    for (const [runId, controller] of this.activeRuns) {
      this.logger.debug(`Canceling active run: ${runId}`);
      controller.abort();
    }

    // Close event transport
    if (this.events.close) {
      this.events.close();
    }

    this.activeRuns.clear();
    this.logger.info('Workflow engine shutdown complete');
  }
}
