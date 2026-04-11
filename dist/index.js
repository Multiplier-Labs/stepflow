import {
  MemoryStorageAdapter,
  PostgresStorageAdapter,
  SQLiteStorageAdapter
} from "./chunk-BEDOATIG.js";
import {
  MemoryEventTransport,
  SocketIOEventTransport,
  WebhookEventTransport
} from "./chunk-UBEIFHK6.js";
import {
  CronScheduler,
  PostgresSchedulePersistence,
  SQLiteSchedulePersistence
} from "./chunk-226JMLXO.js";
import {
  ConsoleLogger,
  SilentLogger,
  createScopedLogger,
  generateId,
  sanitizeErrorForStorage
} from "./chunk-UFSYMSAG.js";

// src/utils/errors.ts
var WorkflowEngineError = class _WorkflowEngineError extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "WorkflowEngineError";
    this.code = code;
    this.details = details;
  }
  /**
   * Convert to a WorkflowError record for storage.
   */
  toRecord() {
    return {
      code: this.code,
      message: this.message,
      stack: this.stack,
      details: this.details
    };
  }
  /**
   * Create a WorkflowError record from any error.
   */
  static fromError(error, defaultCode = "UNKNOWN_ERROR") {
    if (error instanceof _WorkflowEngineError) {
      return error.toRecord();
    }
    if (error instanceof Error) {
      return {
        code: defaultCode,
        message: error.message,
        stack: error.stack
      };
    }
    return {
      code: defaultCode,
      message: String(error)
    };
  }
};
var WorkflowNotFoundError = class extends WorkflowEngineError {
  constructor(kind) {
    super("WORKFLOW_NOT_FOUND", `Workflow "${kind}" is not registered`, { kind });
    this.name = "WorkflowNotFoundError";
  }
};
var WorkflowAlreadyRegisteredError = class extends WorkflowEngineError {
  constructor(kind) {
    super("WORKFLOW_ALREADY_REGISTERED", `Workflow "${kind}" is already registered`, { kind });
    this.name = "WorkflowAlreadyRegisteredError";
  }
};
var RunNotFoundError = class extends WorkflowEngineError {
  constructor(runId) {
    super("RUN_NOT_FOUND", `Run "${runId}" not found`, { runId });
    this.name = "RunNotFoundError";
  }
};
var StepError = class extends WorkflowEngineError {
  stepKey;
  attempt;
  cause;
  constructor(stepKey, message, attempt, cause) {
    super("STEP_ERROR", message, { stepKey, attempt });
    this.name = "StepError";
    this.stepKey = stepKey;
    this.attempt = attempt;
    this.cause = cause;
  }
};
var StepTimeoutError = class extends WorkflowEngineError {
  stepKey;
  timeoutMs;
  constructor(stepKey, timeoutMs) {
    super("STEP_TIMEOUT", `Step "${stepKey}" timed out after ${timeoutMs}ms`, {
      stepKey,
      timeoutMs
    });
    this.name = "StepTimeoutError";
    this.stepKey = stepKey;
    this.timeoutMs = timeoutMs;
  }
};
var WorkflowCanceledError = class extends WorkflowEngineError {
  constructor(runId) {
    super("WORKFLOW_CANCELED", `Workflow run "${runId}" was canceled`, { runId });
    this.name = "WorkflowCanceledError";
  }
};
var WaitForRunTimeoutError = class extends WorkflowEngineError {
  runId;
  timeoutMs;
  constructor(runId, timeoutMs) {
    super("WAIT_FOR_RUN_TIMEOUT", `Timeout waiting for run ${runId} after ${timeoutMs}ms`, {
      runId,
      timeoutMs
    });
    this.name = "WaitForRunTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
};
var WorkflowTimeoutError = class extends WorkflowEngineError {
  timeoutMs;
  constructor(runId, timeoutMs) {
    super("WORKFLOW_TIMEOUT", `Workflow run "${runId}" timed out after ${timeoutMs}ms`, {
      runId,
      timeoutMs
    });
    this.name = "WorkflowTimeoutError";
    this.timeoutMs = timeoutMs;
  }
};

// src/utils/retry.ts
var DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  delay: 1e3,
  backoff: 2
};
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WorkflowCanceledError("run"));
      return;
    }
    let onAbort;
    const timeoutId = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timeoutId);
        reject(new WorkflowCanceledError("run"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
async function withRetry(fn, options = {}) {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError;
  let currentDelay = opts.delay;
  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    if (opts.signal?.aborted) {
      throw new Error("Aborted");
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt > opts.maxRetries) {
        throw lastError;
      }
      opts.onRetry?.(attempt, lastError, currentDelay);
      await sleep(currentDelay, opts.signal);
      currentDelay = Math.round(currentDelay * opts.backoff);
    }
  }
  throw lastError ?? new Error("Retry failed");
}
function calculateRetryDelay(attempt, baseDelay, backoff) {
  return Math.round(baseDelay * Math.pow(backoff, attempt - 1));
}

// src/core/orchestrator.ts
async function executeWorkflow(options) {
  const {
    runId,
    definition,
    input,
    metadata = {},
    storage,
    events,
    logger,
    abortController,
    spawnChild,
    checkpoint
  } = options;
  const startTime = Date.now();
  const isResume = !!checkpoint;
  await storage.updateRun(runId, {
    status: "running",
    ...isResume ? {} : { startedAt: /* @__PURE__ */ new Date() }
  });
  emitEvent(events, logger, {
    runId,
    kind: definition.kind,
    eventType: isResume ? "run.resumed" : "run.started",
    timestamp: /* @__PURE__ */ new Date(),
    payload: isResume ? { resumedFrom: Array.from(checkpoint.completedStepKeys) } : void 0
  });
  const context = {
    runId,
    stepId: "",
    // Will be set for each step before handler is called
    kind: definition.kind,
    input,
    results: checkpoint?.results ? { ...checkpoint.results } : {},
    metadata,
    logger: createScopedLogger(logger, runId),
    signal: abortController.signal,
    spawnChild,
    emit: (eventType, payload) => {
      emitEvent(events, logger, {
        runId,
        kind: definition.kind,
        eventType,
        timestamp: /* @__PURE__ */ new Date(),
        payload
      });
    }
  };
  let workflowTimeoutId;
  let workflowTimeoutError;
  if (definition.timeout) {
    workflowTimeoutId = setTimeout(() => {
      workflowTimeoutError = new WorkflowTimeoutError(runId, definition.timeout);
      abortController.abort();
    }, definition.timeout);
  }
  try {
    if (definition.hooks?.beforeRun) {
      await definition.hooks.beforeRun(context);
    }
    for (const step of definition.steps) {
      if (abortController.signal.aborted) {
        throw new WorkflowCanceledError(runId);
      }
      context.currentStep = step.key;
      if (checkpoint?.completedStepKeys.has(step.key)) {
        logger.info(`Skipping step "${step.key}" (already completed in previous run)`);
        emitEvent(events, logger, {
          runId,
          kind: definition.kind,
          eventType: "step.skipped",
          stepKey: step.key,
          timestamp: /* @__PURE__ */ new Date(),
          payload: { reason: "checkpoint" }
        });
        continue;
      }
      if (step.skipIf) {
        const shouldSkip = await step.skipIf(context);
        if (shouldSkip) {
          logger.info(`Skipping step "${step.key}" (condition met)`);
          emitEvent(events, logger, {
            runId,
            kind: definition.kind,
            eventType: "step.skipped",
            stepKey: step.key,
            timestamp: /* @__PURE__ */ new Date()
          });
          continue;
        }
      }
      const result = await executeStep(step, context, {
        definition,
        storage,
        events,
        logger,
        abortController
      });
      context.results[step.key] = result;
      await storage.updateRun(runId, {
        context: { ...context.results }
      });
    }
    if (workflowTimeoutId) {
      clearTimeout(workflowTimeoutId);
    }
    const duration = Date.now() - startTime;
    const runResult = {
      status: "succeeded",
      results: context.results,
      duration
    };
    if (definition.hooks?.afterRun) {
      await definition.hooks.afterRun(context, runResult);
    }
    await storage.updateRun(runId, {
      status: "succeeded",
      context: context.results,
      finishedAt: /* @__PURE__ */ new Date()
    });
    emitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType: "run.completed",
      timestamp: /* @__PURE__ */ new Date(),
      payload: { results: context.results, duration }
    });
    return runResult;
  } catch (error) {
    if (workflowTimeoutId) {
      clearTimeout(workflowTimeoutId);
    }
    const duration = Date.now() - startTime;
    const actualError = workflowTimeoutError ?? error;
    const workflowError = WorkflowEngineError.fromError(actualError);
    const isTimeout = actualError instanceof WorkflowTimeoutError;
    const isCanceled = !isTimeout && actualError instanceof WorkflowCanceledError;
    const status = isCanceled ? "canceled" : "failed";
    const eventType = isTimeout ? "run.timeout" : isCanceled ? "run.canceled" : "run.failed";
    const runResult = {
      status,
      results: context.results,
      error: workflowError,
      duration
    };
    if (definition.hooks?.afterRun) {
      try {
        await definition.hooks.afterRun(context, runResult);
      } catch (hookError) {
        logger.error("afterRun hook failed:", hookError);
      }
    }
    await storage.updateRun(runId, {
      status,
      context: context.results,
      error: workflowError,
      finishedAt: /* @__PURE__ */ new Date()
    });
    emitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType,
      timestamp: /* @__PURE__ */ new Date(),
      payload: { error: workflowError.message, duration }
    });
    return runResult;
  }
}
async function executeStep(step, context, options) {
  const { definition, storage, events, logger, abortController } = options;
  const onError = step.onError ?? definition.defaultOnError ?? "fail";
  const maxRetries = step.maxRetries ?? 3;
  const retryDelay = step.retryDelay ?? 1e3;
  const retryBackoff = step.retryBackoff ?? 2;
  let attempt = 0;
  let lastError;
  while (true) {
    attempt++;
    if (abortController.signal.aborted) {
      throw new WorkflowCanceledError(context.runId);
    }
    const stepRecord = await storage.createStep({
      runId: context.runId,
      stepKey: step.key,
      stepName: step.name,
      status: "running",
      attempt,
      startedAt: /* @__PURE__ */ new Date()
    });
    context.stepId = stepRecord.id;
    emitEvent(events, logger, {
      runId: context.runId,
      kind: context.kind,
      eventType: "step.started",
      stepKey: step.key,
      timestamp: /* @__PURE__ */ new Date(),
      payload: { attempt }
    });
    if (definition.hooks?.beforeStep) {
      await definition.hooks.beforeStep(context, step);
    }
    try {
      let result;
      if (step.timeout) {
        result = await executeWithTimeout(
          () => step.handler(context),
          step.timeout,
          abortController.signal,
          step.key
        );
      } else {
        result = await raceWithAbort(
          step.handler(context),
          abortController.signal
        );
      }
      await storage.updateStep(stepRecord.id, {
        status: "succeeded",
        result,
        finishedAt: /* @__PURE__ */ new Date()
      });
      if (definition.hooks?.afterStep) {
        await definition.hooks.afterStep(context, step, result);
      }
      emitEvent(events, logger, {
        runId: context.runId,
        kind: context.kind,
        eventType: "step.completed",
        stepKey: step.key,
        timestamp: /* @__PURE__ */ new Date(),
        payload: { result }
      });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await storage.updateStep(stepRecord.id, {
        status: "failed",
        error: WorkflowEngineError.fromError(error),
        finishedAt: /* @__PURE__ */ new Date()
      });
      if (definition.hooks?.onStepError) {
        try {
          await definition.hooks.onStepError(context, step, lastError);
        } catch (hookError) {
          logger.error("onStepError hook failed:", hookError);
        }
      }
      emitEvent(events, logger, {
        runId: context.runId,
        kind: context.kind,
        eventType: "step.failed",
        stepKey: step.key,
        timestamp: /* @__PURE__ */ new Date(),
        payload: { error: lastError.message, attempt }
      });
      if (onError === "skip") {
        logger.warn(`Step "${step.key}" failed, skipping (strategy: skip)`);
        emitEvent(events, logger, {
          runId: context.runId,
          kind: context.kind,
          eventType: "step.skipped",
          stepKey: step.key,
          timestamp: /* @__PURE__ */ new Date(),
          payload: { reason: "error", error: lastError.message }
        });
        return void 0;
      }
      if (onError === "retry" && attempt <= maxRetries) {
        const delay = calculateRetryDelay(attempt, retryDelay, retryBackoff);
        logger.warn(`Step "${step.key}" failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        emitEvent(events, logger, {
          runId: context.runId,
          kind: context.kind,
          eventType: "step.retry",
          stepKey: step.key,
          timestamp: /* @__PURE__ */ new Date(),
          payload: { attempt, maxRetries, delay, error: lastError.message }
        });
        await sleep(delay, abortController.signal);
        continue;
      }
      throw new StepError(step.key, lastError.message, attempt, lastError);
    }
  }
}
async function executeWithTimeout(fn, timeoutMs, signal, stepKey) {
  let timeoutId;
  let onAbort;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new StepTimeoutError(stepKey, timeoutMs));
        }, timeoutMs);
        onAbort = () => {
          clearTimeout(timeoutId);
          reject(new WorkflowCanceledError("run"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
async function raceWithAbort(promise, signal) {
  if (signal.aborted) {
    throw new WorkflowCanceledError("run");
  }
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(new WorkflowCanceledError("run"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
function emitEvent(events, logger, event) {
  try {
    events.emit(event);
  } catch (error) {
    logger.error("Failed to emit event:", error);
  }
}

// src/core/engine.ts
var WorkflowEngine = class _WorkflowEngine {
  registry = /* @__PURE__ */ new Map();
  storage;
  events;
  logger;
  activeRuns = /* @__PURE__ */ new Map();
  settings;
  runQueue = [];
  constructor(config = {}) {
    this.storage = config.storage ?? new MemoryStorageAdapter();
    this.events = config.events ?? new MemoryEventTransport();
    this.logger = config.logger ?? new ConsoleLogger();
    this.settings = config.settings ?? {};
  }
  /**
   * Initialize the engine and its storage/event adapters.
   * Call this before starting runs if your storage adapter requires initialization
   * (e.g., PostgresStorageAdapter).
   */
  async initialize() {
    if (this.storage.initialize) {
      await this.storage.initialize();
    }
  }
  /**
   * Get the current number of active runs.
   */
  getActiveRunCount() {
    return this.activeRuns.size;
  }
  /**
   * Get the number of queued runs waiting for capacity.
   */
  getQueuedRunCount() {
    return this.runQueue.length;
  }
  /**
   * Check if capacity is available for a new run.
   */
  hasCapacity() {
    const maxConcurrency = this.settings.maxConcurrency;
    if (maxConcurrency === void 0 || maxConcurrency <= 0) {
      return true;
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
  registerWorkflow(definition) {
    if (this.registry.has(definition.kind)) {
      throw new WorkflowAlreadyRegisteredError(definition.kind);
    }
    this.registry.set(definition.kind, definition);
    this.logger.debug(`Registered workflow: ${definition.kind}`);
  }
  /**
   * Unregister a workflow definition.
   *
   * @param kind - The workflow kind to unregister
   * @returns true if the workflow was unregistered, false if not found
   */
  unregisterWorkflow(kind) {
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
  getWorkflow(kind) {
    return this.registry.get(kind);
  }
  /**
   * Get all registered workflow kinds.
   */
  getRegisteredWorkflows() {
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
  async startRun(options) {
    const definition = this.registry.get(options.kind);
    if (!definition) {
      throw new WorkflowNotFoundError(options.kind);
    }
    const run = await this.storage.createRun({
      kind: options.kind,
      status: "queued",
      parentRunId: options.parentRunId,
      input: options.input ?? {},
      metadata: options.metadata ?? {},
      context: {}
    });
    const runId = run.id;
    this.events.emit({
      runId,
      kind: options.kind,
      eventType: "run.created",
      timestamp: /* @__PURE__ */ new Date(),
      payload: { input: options.input, metadata: options.metadata, priority: options.priority ?? 0 }
    });
    if (this.hasCapacity()) {
      this.executeRun(
        runId,
        definition,
        options.input ?? {},
        options.metadata,
        options.delay
      );
    } else {
      this.queueRun({
        runId,
        definition,
        input: options.input ?? {},
        metadata: options.metadata,
        priority: options.priority ?? 0,
        queuedAt: /* @__PURE__ */ new Date()
      });
      this.logger.debug(`Run ${runId} queued (${this.runQueue.length} in queue)`);
      this.events.emit({
        runId,
        kind: options.kind,
        eventType: "run.queued",
        timestamp: /* @__PURE__ */ new Date(),
        payload: { queuePosition: this.runQueue.length }
      });
    }
    return runId;
  }
  /**
   * Queue a run in priority order.
   */
  queueRun(queuedRun) {
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
  executeRun(runId, definition, input, metadata, delay) {
    this.launchRun(runId, definition, input, metadata, delay);
  }
  /**
   * Launch a workflow run asynchronously.
   * Shared by both executeRun (new runs) and resumeRun (checkpoint recovery).
   */
  launchRun(runId, definition, input, metadata, delay, checkpoint) {
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
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
          spawnChild: (childOptions) => this.spawnChild(runId, childOptions),
          checkpoint
        });
      } finally {
        this.activeRuns.delete(runId);
        this.processQueue();
      }
    };
    if (delay) {
      setTimeout(execute, delay);
    } else {
      setImmediate(execute);
    }
  }
  /**
   * Process the queue and start runs if capacity is available.
   */
  processQueue() {
    while (this.hasCapacity() && this.runQueue.length > 0) {
      const next = this.runQueue.shift();
      this.logger.debug(`Starting queued run ${next.runId}`);
      this.events.emit({
        runId: next.runId,
        kind: next.definition.kind,
        eventType: "run.dequeued",
        timestamp: /* @__PURE__ */ new Date()
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
  async spawnChild(parentRunId, options) {
    return this.startRun({
      kind: options.kind,
      input: options.input,
      metadata: options.metadata,
      parentRunId
    });
  }
  /**
   * Cancel a running workflow.
   * Signals the workflow to stop at the next cancellation point.
   *
   * @param runId - The run ID to cancel
   * @throws RunNotFoundError if the run is not found
   */
  async cancelRun(runId) {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    if (["succeeded", "failed", "canceled", "timeout"].includes(run.status)) {
      return;
    }
    const queueIndex = this.runQueue.findIndex((q) => q.runId === runId);
    if (queueIndex !== -1) {
      this.runQueue.splice(queueIndex, 1);
    }
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
    }
    await this.storage.updateRun(runId, {
      status: "canceled",
      finishedAt: /* @__PURE__ */ new Date()
    });
    this.events.emit({
      runId,
      kind: run.kind,
      eventType: "run.canceled",
      timestamp: /* @__PURE__ */ new Date()
    });
  }
  /**
   * Get the current status of a run.
   *
   * @param runId - The run ID to look up
   * @returns The run record or null if not found
   */
  async getRunStatus(runId) {
    return this.storage.getRun(runId);
  }
  static TERMINAL_STATUSES = ["succeeded", "failed", "canceled", "timeout"];
  static TERMINAL_EVENT_TYPES = ["run.completed", "run.failed", "run.canceled", "run.timeout"];
  /**
   * Wait for a run to complete.
   * Subscribes to run events and resolves when a terminal event fires.
   * Falls back to an initial storage read to avoid race conditions.
   *
   * @param runId - The run ID to wait for
   * @param options - Wait options
   * @returns The final run record
   */
  async waitForRun(runId, options = {}) {
    const timeout = options.timeout ?? 6e4;
    const existingRun = await this.storage.getRun(runId);
    if (!existingRun) {
      throw new RunNotFoundError(runId);
    }
    if (_WorkflowEngine.TERMINAL_STATUSES.includes(existingRun.status)) {
      return existingRun;
    }
    return new Promise((resolve, reject) => {
      let timeoutId;
      let unsubscribe;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) unsubscribe();
      };
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new WaitForRunTimeoutError(runId, timeout));
      }, timeout);
      unsubscribe = this.events.subscribe(runId, async (event) => {
        if (_WorkflowEngine.TERMINAL_EVENT_TYPES.includes(event.eventType)) {
          cleanup();
          try {
            const run = await this.storage.getRun(runId);
            if (!run) {
              reject(new RunNotFoundError(runId));
            } else {
              resolve(run);
            }
          } catch (err) {
            reject(err);
          }
        }
      });
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
   * @throws RunNotFoundError if the run is not found
   * @throws Error if the run is already completed or workflow not registered
   */
  async resumeRun(runId) {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    if (!["queued", "running"].includes(run.status)) {
      throw new Error(`Cannot resume run ${runId}: status is "${run.status}"`);
    }
    const definition = this.registry.get(run.kind);
    if (!definition) {
      throw new WorkflowNotFoundError(run.kind);
    }
    if (this.activeRuns.has(runId)) {
      this.logger.warn(`Run ${runId} is already active, skipping resume`);
      return runId;
    }
    this.logger.info(`Resuming run ${runId} from checkpoint`);
    const completedStepKeys = new Set(Object.keys(run.context));
    this.launchRun(runId, definition, run.input, run.metadata, void 0, {
      completedStepKeys,
      results: run.context
    });
    return runId;
  }
  /**
   * Get all runs that were interrupted and can be resumed.
   * Returns runs with status 'queued' or 'running'.
   */
  async getResumableRuns() {
    const result = await this.storage.listRuns({
      status: ["queued", "running"]
    });
    return result.items;
  }
  /**
   * Resume all interrupted runs.
   * Useful for recovering after a server restart.
   *
   * @returns Array of resumed run IDs
   */
  async resumeAllInterrupted() {
    const resumableRuns = await this.getResumableRuns();
    const resumedIds = [];
    for (const run of resumableRuns) {
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
  subscribeToRun(runId, callback) {
    return this.events.subscribe(runId, callback);
  }
  /**
   * Subscribe to all workflow events.
   *
   * @param callback - Event handler
   * @returns Unsubscribe function
   */
  subscribeToAll(callback) {
    return this.events.subscribeAll(callback);
  }
  // ============================================================================
  // Storage Access
  // ============================================================================
  /**
   * Get the storage adapter.
   * Useful for querying runs and steps directly.
   */
  getStorage() {
    return this.storage;
  }
  /**
   * Get the event transport.
   * Useful for custom event handling.
   */
  getEvents() {
    return this.events;
  }
  // ============================================================================
  // Lifecycle
  // ============================================================================
  /**
   * Shutdown the engine gracefully.
   * Cancels all active runs and closes resources.
   */
  async shutdown() {
    this.logger.info("Shutting down workflow engine...");
    for (const [runId, controller] of this.activeRuns) {
      this.logger.debug(`Canceling active run: ${runId}`);
      controller.abort();
    }
    if (this.events.close) {
      this.events.close();
    }
    if (this.storage.close) {
      await this.storage.close();
    }
    this.activeRuns.clear();
    this.logger.info("Workflow engine shutdown complete");
  }
};

// src/planning/registry.ts
var MemoryStepHandlerRegistry = class {
  handlers = /* @__PURE__ */ new Map();
  tagIndex = /* @__PURE__ */ new Map();
  /** Register a step handler. Throws if a handler with the same ID is already registered. */
  register(handler) {
    if (this.handlers.has(handler.id)) {
      throw new Error(`Step handler '${handler.id}' is already registered`);
    }
    this.handlers.set(handler.id, handler);
    if (handler.tags) {
      for (const tag of handler.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, /* @__PURE__ */ new Set());
        }
        this.tagIndex.get(tag).add(handler.id);
      }
    }
  }
  /** Get a handler by its unique ID, or undefined if not registered. */
  get(id) {
    return this.handlers.get(id);
  }
  /** Check whether a handler with the given ID is registered. */
  has(id) {
    return this.handlers.has(id);
  }
  /** List all registered step handlers. */
  list() {
    return Array.from(this.handlers.values());
  }
  /** List all handlers tagged with the given tag. */
  listByTag(tag) {
    const ids = this.tagIndex.get(tag);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.handlers.get(id)).filter((h) => h !== void 0);
  }
  /**
   * Resolve a handler reference to a WorkflowStep handler function.
   * Returns undefined if the handler is not found.
   */
  resolve(handlerRef) {
    const registered = this.handlers.get(handlerRef);
    return registered?.handler;
  }
  /**
   * Clear all registered handlers (useful for testing).
   */
  clear() {
    this.handlers.clear();
    this.tagIndex.clear();
  }
};
var MemoryRecipeRegistry = class {
  recipes = /* @__PURE__ */ new Map();
  kindIndex = /* @__PURE__ */ new Map();
  variantIndex = /* @__PURE__ */ new Map();
  // "kind:variant" -> recipeId
  tagIndex = /* @__PURE__ */ new Map();
  /** Register a single recipe. Throws if a recipe with the same ID or kind:variant pair is already registered. */
  register(recipe) {
    if (this.recipes.has(recipe.id)) {
      throw new Error(`Recipe '${recipe.id}' is already registered`);
    }
    this.recipes.set(recipe.id, recipe);
    if (!this.kindIndex.has(recipe.workflowKind)) {
      this.kindIndex.set(recipe.workflowKind, /* @__PURE__ */ new Set());
    }
    this.kindIndex.get(recipe.workflowKind).add(recipe.id);
    const variantKey = `${recipe.workflowKind}:${recipe.variant}`;
    if (this.variantIndex.has(variantKey)) {
      throw new Error(
        `Recipe variant '${recipe.variant}' for '${recipe.workflowKind}' is already registered`
      );
    }
    this.variantIndex.set(variantKey, recipe.id);
    if (recipe.tags) {
      for (const tag of recipe.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, /* @__PURE__ */ new Set());
        }
        this.tagIndex.get(tag).add(recipe.id);
      }
    }
  }
  /** Register multiple recipes at once. */
  registerAll(recipes) {
    for (const recipe of recipes) {
      this.register(recipe);
    }
  }
  /** Get a recipe by its unique ID, or undefined if not registered. */
  get(recipeId) {
    return this.recipes.get(recipeId);
  }
  /** Check whether a recipe with the given ID is registered. */
  has(recipeId) {
    return this.recipes.has(recipeId);
  }
  /** Get all recipes registered for a given workflow kind. */
  getByKind(workflowKind) {
    const ids = this.kindIndex.get(workflowKind);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.recipes.get(id)).filter((r) => r !== void 0);
  }
  /** Get the recipe for a specific workflow kind and variant combination. */
  getVariant(workflowKind, variant) {
    const variantKey = `${workflowKind}:${variant}`;
    const recipeId = this.variantIndex.get(variantKey);
    if (!recipeId) return void 0;
    return this.recipes.get(recipeId);
  }
  /**
   * Get the default recipe for a workflow kind.
   * Returns the 'default' variant if one exists, otherwise falls back to the
   * recipe with the lowest numeric priority value (lower number = higher precedence).
   */
  getDefault(workflowKind) {
    const defaultRecipe = this.getVariant(workflowKind, "default");
    if (defaultRecipe) return defaultRecipe;
    const recipes = this.getByKind(workflowKind);
    if (recipes.length === 0) return void 0;
    return recipes.reduce((lowest, current) => {
      const currentPriority = current.priority ?? 0;
      const lowestPriority = lowest.priority ?? 0;
      return currentPriority < lowestPriority ? current : lowest;
    });
  }
  /** List all variant names registered for a workflow kind. */
  listVariants(workflowKind) {
    const recipes = this.getByKind(workflowKind);
    return recipes.map((r) => r.variant);
  }
  /** Query recipes with optional filters for kind, variant, tags, and input conditions. */
  query(options) {
    let results = this.list();
    if (options.workflowKind) {
      results = results.filter((r) => r.workflowKind === options.workflowKind);
    }
    if (options.variant) {
      results = results.filter((r) => r.variant === options.variant);
    }
    if (options.tags && options.tags.length > 0) {
      results = results.filter(
        (r) => options.tags.some((tag) => r.tags?.includes(tag))
      );
    }
    if (options.matchConditions) {
      results = results.filter((r) => {
        if (!r.conditions || r.conditions.length === 0) return true;
        return this.evaluateConditions(r.conditions, options.matchConditions);
      });
    }
    return results;
  }
  /** List all registered recipes. */
  list() {
    return Array.from(this.recipes.values());
  }
  /**
   * Clear all registered recipes (useful for testing).
   */
  clear() {
    this.recipes.clear();
    this.kindIndex.clear();
    this.variantIndex.clear();
    this.tagIndex.clear();
  }
  /**
   * Evaluate recipe conditions against an input.
   * Returns true if all conditions match.
   */
  evaluateConditions(conditions, input) {
    if (!conditions || conditions.length === 0) return true;
    return conditions.every((condition) => {
      const fieldValue = this.getNestedValue(input, condition.field);
      return this.evaluateCondition(condition, fieldValue);
    });
  }
  /**
   * Get a nested value from an object using dot notation.
   */
  getNestedValue(obj, path) {
    return path.split(".").reduce((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return current[key];
      }
      return void 0;
    }, obj);
  }
  /**
   * Evaluate a single condition.
   */
  evaluateCondition(condition, fieldValue) {
    const { operator, value } = condition;
    switch (operator) {
      case "eq":
        return fieldValue === value;
      case "neq":
        return fieldValue !== value;
      case "gt":
        return typeof fieldValue === "number" && typeof value === "number" ? fieldValue > value : false;
      case "gte":
        return typeof fieldValue === "number" && typeof value === "number" ? fieldValue >= value : false;
      case "lt":
        return typeof fieldValue === "number" && typeof value === "number" ? fieldValue < value : false;
      case "lte":
        return typeof fieldValue === "number" && typeof value === "number" ? fieldValue <= value : false;
      case "contains":
        if (typeof fieldValue === "string" && typeof value === "string") {
          return fieldValue.includes(value);
        }
        if (Array.isArray(fieldValue)) {
          return fieldValue.includes(value);
        }
        return false;
      case "matches":
        if (typeof fieldValue === "string" && typeof value === "string") {
          try {
            return new RegExp(value).test(fieldValue);
          } catch {
            return false;
          }
        }
        return false;
      case "exists":
        return fieldValue !== void 0 && fieldValue !== null && fieldValue !== "";
      case "notExists":
        return fieldValue === void 0 || fieldValue === null || fieldValue === "";
      default:
        return false;
    }
  }
};
function createRegistry() {
  return {
    recipes: new MemoryRecipeRegistry(),
    handlers: new MemoryStepHandlerRegistry()
  };
}

// src/planning/planner.ts
function getNestedValue(obj, path) {
  return path.split(".").reduce((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return current[key];
    }
    return void 0;
  }, obj);
}
function evaluateCondition(operator, fieldValue, conditionValue) {
  switch (operator) {
    case "eq":
      return fieldValue === conditionValue;
    case "neq":
      return fieldValue !== conditionValue;
    case "gt":
      return typeof fieldValue === "number" && typeof conditionValue === "number" ? fieldValue > conditionValue : false;
    case "gte":
      return typeof fieldValue === "number" && typeof conditionValue === "number" ? fieldValue >= conditionValue : false;
    case "lt":
      return typeof fieldValue === "number" && typeof conditionValue === "number" ? fieldValue < conditionValue : false;
    case "lte":
      return typeof fieldValue === "number" && typeof conditionValue === "number" ? fieldValue <= conditionValue : false;
    case "contains":
      if (typeof fieldValue === "string" && typeof conditionValue === "string") {
        return fieldValue.includes(conditionValue);
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(conditionValue);
      }
      return false;
    case "matches":
      if (typeof fieldValue === "string" && typeof conditionValue === "string") {
        try {
          return new RegExp(conditionValue).test(fieldValue);
        } catch {
          return false;
        }
      }
      return false;
    case "exists":
      return fieldValue !== void 0 && fieldValue !== null && fieldValue !== "";
    case "notExists":
      return fieldValue === void 0 || fieldValue === null || fieldValue === "";
    default:
      return false;
  }
}
function scoreConditions(conditions, input) {
  if (!conditions || conditions.length === 0) {
    return 10;
  }
  let matched = 0;
  for (const condition of conditions) {
    const fieldValue = getNestedValue(input, condition.field);
    if (evaluateCondition(condition.operator, fieldValue, condition.value)) {
      matched++;
    }
  }
  if (matched < conditions.length) {
    return 0;
  }
  return Math.min(100, 50 + conditions.length * 10);
}
var RuleBasedPlanner = class {
  recipeRegistry;
  handlerRegistry;
  validateHandlers;
  resourceEstimates;
  constructor(config) {
    this.recipeRegistry = config.recipeRegistry;
    this.handlerRegistry = config.handlerRegistry;
    this.validateHandlers = config.validateHandlers ?? false;
    this.resourceEstimates = {
      apiCallsPerStep: config.resourceEstimates?.apiCallsPerStep ?? 1,
      tokensPerStep: config.resourceEstimates?.tokensPerStep ?? 500,
      durationPerStep: config.resourceEstimates?.durationPerStep ?? 2e3,
      apiCallsPerChild: config.resourceEstimates?.apiCallsPerChild ?? 5
    };
  }
  /**
   * Select the best recipe for a workflow kind and input.
   */
  async selectRecipe(workflowKind, input, context) {
    if (context?.hints?.forceRecipeId) {
      const forced = this.recipeRegistry.get(context.hints.forceRecipeId);
      if (forced) {
        return {
          recipe: forced,
          score: 100,
          reason: `Forced recipe: ${context.hints.forceRecipeId}`
        };
      }
    }
    if (context?.hints?.preferredVariant) {
      const preferred = this.recipeRegistry.getVariant(
        workflowKind,
        context.hints.preferredVariant
      );
      if (preferred) {
        return {
          recipe: preferred,
          score: 90,
          reason: `Preferred variant: ${context.hints.preferredVariant}`
        };
      }
    }
    const recipes = this.recipeRegistry.getByKind(workflowKind);
    if (recipes.length === 0) {
      throw new Error(`No recipes found for workflow kind: ${workflowKind}`);
    }
    const scored = recipes.map((recipe) => ({
      recipe,
      conditionScore: scoreConditions(recipe.conditions, input),
      priorityScore: recipe.priority ?? 0
    }));
    scored.sort((a, b) => {
      if (b.conditionScore !== a.conditionScore) {
        return b.conditionScore - a.conditionScore;
      }
      return b.priorityScore - a.priorityScore;
    });
    const best = scored.find((s) => s.conditionScore > 0);
    if (best) {
      const reason = this.buildSelectionReason(best.recipe, input);
      return {
        recipe: best.recipe,
        score: best.conditionScore,
        reason
      };
    }
    const defaultRecipe = this.recipeRegistry.getDefault(workflowKind);
    if (defaultRecipe) {
      return {
        recipe: defaultRecipe,
        score: 10,
        reason: `Fallback to default recipe: ${defaultRecipe.id}`
      };
    }
    return {
      recipe: recipes[0],
      score: 5,
      reason: `No matching recipe, using first available: ${recipes[0].id}`
    };
  }
  /**
   * Generate a plan from a recipe and input.
   */
  async generatePlan(recipe, input, context) {
    const modifications = [];
    let steps = recipe.steps.map((step) => this.recipeStepToPlannedStep(step));
    if (context?.hints) {
      const { skipSteps, includeSteps, additionalConfig } = context.hints;
      if (skipSteps && skipSteps.length > 0) {
        for (const stepKey of skipSteps) {
          const stepIndex = steps.findIndex((s) => s.key === stepKey);
          if (stepIndex >= 0) {
            steps = steps.filter((s) => s.key !== stepKey);
            modifications.push({
              type: "remove_step",
              stepKey,
              value: null,
              reason: `Skipped via planning hints`
            });
          }
        }
      }
      if (additionalConfig) {
        for (const step of steps) {
          step.config = { ...step.config, ...additionalConfig };
        }
        modifications.push({
          type: "modify_step",
          value: additionalConfig,
          reason: "Applied additional config from planning hints"
        });
      }
    }
    if (context?.constraints) {
      const constraintMods = this.applyConstraints(steps, context.constraints);
      modifications.push(...constraintMods.modifications);
      steps = constraintMods.steps;
    }
    const plan = {
      id: generateId(),
      recipeId: recipe.id,
      variant: recipe.variant,
      modifications,
      steps,
      defaults: recipe.defaults ?? {},
      reasoning: this.buildPlanReasoning(recipe, modifications, context),
      createdAt: /* @__PURE__ */ new Date()
    };
    plan.resourceEstimate = this.estimateResources(plan);
    return plan;
  }
  /**
   * Combined operation: select recipe and generate plan.
   */
  async plan(workflowKind, input, context) {
    const selection = await this.selectRecipe(workflowKind, input, context);
    const plan = await this.generatePlan(selection.recipe, input, context);
    plan.reasoning = `${selection.reason}. ${plan.reasoning ?? ""}`.trim();
    return plan;
  }
  /**
   * Validate a plan before execution.
   */
  validatePlan(plan) {
    const errors = [];
    const warnings = [];
    if (!plan.steps || plan.steps.length === 0) {
      errors.push("Plan has no steps");
    }
    const stepKeys = /* @__PURE__ */ new Set();
    for (const step of plan.steps) {
      if (stepKeys.has(step.key)) {
        errors.push(`Duplicate step key: ${step.key}`);
      }
      stepKeys.add(step.key);
    }
    for (const step of plan.steps) {
      if (!step.key) {
        errors.push("Step missing key");
      }
      if (!step.name) {
        warnings.push(`Step '${step.key}' missing name`);
      }
      if (!step.handlerRef) {
        errors.push(`Step '${step.key}' missing handlerRef`);
      }
      if (this.validateHandlers && this.handlerRegistry) {
        if (!this.handlerRegistry.has(step.handlerRef)) {
          errors.push(`Step '${step.key}' references unknown handler: ${step.handlerRef}`);
        }
      }
    }
    if (plan.childWorkflows) {
      for (const child of plan.childWorkflows) {
        if (!child.kind) {
          errors.push("Child workflow missing kind");
        }
      }
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
  /**
   * Estimate resources required for a plan.
   */
  estimateResources(plan) {
    const { apiCallsPerStep, tokensPerStep, durationPerStep, apiCallsPerChild } = this.resourceEstimates;
    const stepCount = plan.steps.length;
    const childCount = plan.childWorkflows?.length ?? 0;
    return {
      apiCalls: stepCount * apiCallsPerStep + childCount * apiCallsPerChild,
      tokens: stepCount * tokensPerStep,
      duration: stepCount * durationPerStep
    };
  }
  // ============================================================================
  // Private Helpers
  // ============================================================================
  /**
   * Convert a recipe step to a planned step.
   */
  recipeStepToPlannedStep(step) {
    return {
      key: step.key,
      name: step.name,
      handlerRef: step.handlerRef,
      config: step.config ?? {},
      onError: step.onError,
      maxRetries: step.maxRetries,
      retryDelay: step.retryDelay,
      retryBackoff: step.retryBackoff,
      timeout: step.timeout,
      skipCondition: step.skipCondition
    };
  }
  /**
   * Apply constraints to steps and generate modifications.
   */
  applyConstraints(steps, constraints) {
    const modifications = [];
    const perStepTimeout = constraints.maxDuration ? Math.floor(constraints.maxDuration / steps.length) : void 0;
    const modifiedSteps = steps.map((step) => {
      const modified = { ...step };
      if (constraints.priority === "speed") {
        modified.timeout = modified.timeout ? Math.min(modified.timeout, 3e4) : 3e4;
        modified.maxRetries = Math.min(modified.maxRetries ?? 3, 1);
      }
      if (constraints.priority === "cost") {
        modified.maxRetries = 0;
      }
      if (perStepTimeout !== void 0) {
        modified.timeout = modified.timeout ? Math.min(modified.timeout, perStepTimeout) : perStepTimeout;
      }
      return modified;
    });
    if (constraints.priority === "speed") {
      modifications.push({
        type: "set_default",
        value: { priority: "speed" },
        reason: "Optimized for speed: reduced timeouts and retries"
      });
    }
    if (constraints.priority === "cost") {
      modifications.push({
        type: "set_default",
        value: { priority: "cost" },
        reason: "Optimized for cost: disabled retries"
      });
    }
    if (constraints.maxDuration) {
      modifications.push({
        type: "set_default",
        value: { maxDuration: constraints.maxDuration },
        reason: `Applied duration constraint: ${constraints.maxDuration}ms total`
      });
    }
    return { steps: modifiedSteps, modifications };
  }
  /**
   * Build a human-readable selection reason.
   */
  buildSelectionReason(recipe, input) {
    const parts = [`Selected recipe: ${recipe.id}`];
    if (recipe.conditions && recipe.conditions.length > 0) {
      const conditionDescriptions = recipe.conditions.map((c) => {
        const value = getNestedValue(input, c.field);
        return `${c.field} ${c.operator} ${JSON.stringify(c.value)} (actual: ${JSON.stringify(value)})`;
      });
      parts.push(`Matched conditions: ${conditionDescriptions.join(", ")}`);
    }
    if (recipe.priority !== void 0 && recipe.priority > 0) {
      parts.push(`Priority: ${recipe.priority}`);
    }
    return parts.join(". ");
  }
  /**
   * Build reasoning text for a plan.
   */
  buildPlanReasoning(recipe, modifications, context) {
    const parts = [];
    parts.push(`Using recipe '${recipe.name}' (${recipe.variant} variant)`);
    if (modifications.length > 0) {
      parts.push(`Applied ${modifications.length} modification(s)`);
    }
    if (context?.constraints) {
      const constraintList = [];
      if (context.constraints.priority) {
        constraintList.push(`priority=${context.constraints.priority}`);
      }
      if (context.constraints.maxDuration) {
        constraintList.push(`maxDuration=${context.constraints.maxDuration}ms`);
      }
      if (context.constraints.maxApiCalls) {
        constraintList.push(`maxApiCalls=${context.constraints.maxApiCalls}`);
      }
      if (constraintList.length > 0) {
        parts.push(`Constraints: ${constraintList.join(", ")}`);
      }
    }
    return parts.join(". ") + ".";
  }
};
export {
  ConsoleLogger,
  CronScheduler,
  DEFAULT_RETRY_OPTIONS,
  MemoryEventTransport,
  MemoryRecipeRegistry,
  MemoryStepHandlerRegistry,
  MemoryStorageAdapter,
  PostgresSchedulePersistence,
  PostgresStorageAdapter as PostgresStorage,
  PostgresStorageAdapter,
  RuleBasedPlanner,
  RunNotFoundError,
  SQLiteSchedulePersistence,
  SQLiteStorageAdapter,
  SilentLogger,
  SocketIOEventTransport,
  StepError,
  StepTimeoutError,
  WaitForRunTimeoutError,
  WebhookEventTransport,
  WorkflowAlreadyRegisteredError,
  WorkflowCanceledError,
  WorkflowEngine,
  WorkflowEngineError,
  WorkflowNotFoundError,
  WorkflowTimeoutError,
  calculateRetryDelay,
  createRegistry,
  createScopedLogger,
  generateId,
  sanitizeErrorForStorage,
  sleep,
  withRetry
};
//# sourceMappingURL=index.js.map