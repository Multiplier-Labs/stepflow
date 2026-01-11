import {
  MemoryStorageAdapter,
  PostgresStorageAdapter,
  SQLiteStorageAdapter,
  generateId
} from "./chunk-CXW56DTE.js";
import {
  MemoryEventTransport,
  SocketIOEventTransport,
  WebhookEventTransport
} from "./chunk-UTCB6KPT.js";
import {
  __require
} from "./chunk-DGUM43GV.js";

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

// src/utils/logger.ts
var ConsoleLogger = class {
  prefix;
  constructor(prefix = "[workflow]") {
    this.prefix = prefix;
  }
  debug(message, ...args) {
    console.debug(`${this.prefix} [DEBUG]`, message, ...args);
  }
  info(message, ...args) {
    console.info(`${this.prefix} [INFO]`, message, ...args);
  }
  warn(message, ...args) {
    console.warn(`${this.prefix} [WARN]`, message, ...args);
  }
  error(message, ...args) {
    console.error(`${this.prefix} [ERROR]`, message, ...args);
  }
};
var SilentLogger = class {
  debug() {
  }
  info() {
  }
  warn() {
  }
  error() {
  }
};
function createScopedLogger(logger, runId, stepKey) {
  const prefix = stepKey ? `[run:${runId}][step:${stepKey}]` : `[run:${runId}]`;
  return {
    debug: (message, ...args) => logger.debug(`${prefix} ${message}`, ...args),
    info: (message, ...args) => logger.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => logger.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => logger.error(`${prefix} ${message}`, ...args)
  };
}

// src/utils/retry.ts
var DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  delay: 1e3,
  backoff: 2
};
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timeoutId = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      reject(new Error("Aborted"));
    });
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
    startedAt: /* @__PURE__ */ new Date()
  });
  emitEvent(events, {
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
      emitEvent(events, {
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
        emitEvent(events, {
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
          emitEvent(events, {
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
    emitEvent(events, {
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
    emitEvent(events, {
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
    emitEvent(events, {
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
          abortController.signal
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
      emitEvent(events, {
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
      emitEvent(events, {
        runId: context.runId,
        kind: context.kind,
        eventType: "step.failed",
        stepKey: step.key,
        timestamp: /* @__PURE__ */ new Date(),
        payload: { error: lastError.message, attempt }
      });
      if (onError === "skip") {
        logger.warn(`Step "${step.key}" failed, skipping (strategy: skip)`);
        emitEvent(events, {
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
        emitEvent(events, {
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
async function executeWithTimeout(fn, timeoutMs, signal) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new StepTimeoutError("step", timeoutMs));
      }, timeoutMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        reject(new WorkflowCanceledError("run"));
      });
    })
  ]);
}
async function raceWithAbort(promise, signal) {
  if (signal.aborted) {
    throw new WorkflowCanceledError("run");
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new WorkflowCanceledError("run"));
      }, { once: true });
    })
  ]);
}
function emitEvent(events, event) {
  try {
    events.emit(event);
  } catch (error) {
    console.error("Failed to emit event:", error);
  }
}

// src/core/engine.ts
var WorkflowEngine = class {
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
          spawnChild: (childOptions) => this.spawnChild(runId, childOptions)
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
  /**
   * Wait for a run to complete.
   * Polls the run status until it reaches a terminal state.
   *
   * @param runId - The run ID to wait for
   * @param options - Polling options
   * @returns The final run record
   */
  async waitForRun(runId, options = {}) {
    const pollInterval = options.pollInterval ?? 100;
    const timeout = options.timeout ?? 6e4;
    const startTime = Date.now();
    while (true) {
      const run = await this.storage.getRun(runId);
      if (!run) {
        throw new RunNotFoundError(runId);
      }
      if (["succeeded", "failed", "canceled"].includes(run.status)) {
        return run;
      }
      if (Date.now() - startTime > timeout) {
        throw new Error(`Timeout waiting for run ${runId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
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
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    this.events.emit({
      runId,
      kind: run.kind,
      eventType: "run.resumed",
      timestamp: /* @__PURE__ */ new Date(),
      payload: { completedSteps: Array.from(completedStepKeys) }
    });
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
          spawnChild: (childOptions) => this.spawnChild(runId, childOptions),
          // Pass the checkpoint data
          checkpoint: {
            completedStepKeys,
            results: run.context
          }
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
    this.activeRuns.clear();
    this.logger.info("Workflow engine shutdown complete");
  }
};

// src/scheduler/cron.ts
import cronParser from "cron-parser";
var { parseExpression } = cronParser;
var CronScheduler = class {
  engine;
  logger;
  pollInterval;
  persistence;
  schedules = /* @__PURE__ */ new Map();
  running = false;
  pollTimer = null;
  eventUnsubscribe = null;
  constructor(config) {
    this.engine = config.engine;
    this.logger = config.logger ?? new ConsoleLogger();
    this.pollInterval = config.pollInterval ?? 1e3;
    this.persistence = config.persistence;
  }
  // ============================================================================
  // Scheduler Interface Implementation
  // ============================================================================
  /**
   * Start the scheduler.
   * Begins polling for cron schedules and subscribes to workflow completion events.
   */
  async start() {
    if (this.running) {
      this.logger.warn("Scheduler is already running");
      return;
    }
    this.logger.info("Starting scheduler...");
    if (this.persistence) {
      const loaded = await this.persistence.loadSchedules();
      for (const schedule of loaded) {
        this.schedules.set(schedule.id, schedule);
      }
      this.logger.info(`Loaded ${loaded.length} schedules from persistence`);
    }
    for (const schedule of this.schedules.values()) {
      if (schedule.triggerType === "cron" && schedule.cronExpression) {
        this.updateNextRunTime(schedule);
      }
    }
    this.pollTimer = setInterval(() => this.checkSchedules(), this.pollInterval);
    this.eventUnsubscribe = this.engine.subscribeToAll((event) => {
      this.handleWorkflowEvent(event);
    });
    this.running = true;
    this.logger.info("Scheduler started");
  }
  /**
   * Stop the scheduler.
   * Stops polling and unsubscribes from events.
   */
  async stop() {
    if (!this.running) {
      return;
    }
    this.logger.info("Stopping scheduler...");
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
    this.running = false;
    this.logger.info("Scheduler stopped");
  }
  /**
   * Add a new schedule.
   */
  async addSchedule(scheduleData) {
    const schedule = {
      ...scheduleData,
      id: generateId()
    };
    if (schedule.triggerType === "cron" && schedule.cronExpression) {
      try {
        parseExpression(schedule.cronExpression, {
          tz: schedule.timezone
        });
      } catch (error) {
        throw new Error(`Invalid cron expression: ${schedule.cronExpression}`);
      }
      this.updateNextRunTime(schedule);
    }
    if (schedule.triggerType === "workflow_completed") {
      if (!schedule.triggerOnWorkflowKind) {
        throw new Error("triggerOnWorkflowKind is required for workflow_completed triggers");
      }
    }
    this.schedules.set(schedule.id, schedule);
    if (this.persistence) {
      await this.persistence.saveSchedule(schedule);
    }
    this.logger.info(`Added schedule: ${schedule.id} (${schedule.workflowKind})`);
    return schedule;
  }
  /**
   * Remove a schedule.
   */
  async removeSchedule(scheduleId) {
    if (!this.schedules.has(scheduleId)) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    this.schedules.delete(scheduleId);
    if (this.persistence) {
      await this.persistence.deleteSchedule(scheduleId);
    }
    this.logger.info(`Removed schedule: ${scheduleId}`);
  }
  /**
   * Update a schedule.
   */
  async updateSchedule(scheduleId, updates) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    delete updates.id;
    Object.assign(schedule, updates);
    if (updates.cronExpression !== void 0 || updates.timezone !== void 0) {
      if (schedule.cronExpression) {
        try {
          parseExpression(schedule.cronExpression, {
            tz: schedule.timezone
          });
          this.updateNextRunTime(schedule);
        } catch (error) {
          throw new Error(`Invalid cron expression: ${schedule.cronExpression}`);
        }
      }
    }
    if (this.persistence) {
      await this.persistence.updateSchedule(scheduleId, updates);
    }
    this.logger.debug(`Updated schedule: ${scheduleId}`);
  }
  /**
   * Get all schedules.
   */
  async getSchedules() {
    return Array.from(this.schedules.values());
  }
  /**
   * Get a schedule by ID.
   */
  getSchedule(scheduleId) {
    return this.schedules.get(scheduleId);
  }
  /**
   * Manually trigger a scheduled workflow.
   */
  async triggerNow(scheduleId) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    return this.executeSchedule(schedule);
  }
  // ============================================================================
  // Internal Methods
  // ============================================================================
  /**
   * Check all cron schedules and execute those that are due.
   */
  checkSchedules() {
    const now = /* @__PURE__ */ new Date();
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (schedule.triggerType !== "cron") continue;
      if (!schedule.nextRunAt) continue;
      if (schedule.nextRunAt <= now) {
        this.executeSchedule(schedule).catch((error) => {
          this.logger.error(`Failed to execute schedule ${schedule.id}:`, error);
        });
        this.updateNextRunTime(schedule);
      }
    }
  }
  /**
   * Handle workflow events for completion triggers.
   */
  handleWorkflowEvent(event) {
    if (event.eventType !== "run.completed" && event.eventType !== "run.failed") {
      return;
    }
    const completedStatus = event.eventType === "run.completed" ? "succeeded" : "failed";
    const completedKind = event.kind;
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (schedule.triggerType !== "workflow_completed") continue;
      if (schedule.triggerOnWorkflowKind !== completedKind) continue;
      if (schedule.triggerOnStatus && !schedule.triggerOnStatus.includes(completedStatus)) {
        continue;
      }
      this.executeSchedule(schedule, {
        triggerRunId: event.runId,
        triggerStatus: completedStatus
      }).catch((error) => {
        this.logger.error(`Failed to execute schedule ${schedule.id}:`, error);
      });
    }
  }
  /**
   * Execute a schedule by starting the workflow.
   */
  async executeSchedule(schedule, triggerContext) {
    this.logger.info(`Executing schedule: ${schedule.id} (${schedule.workflowKind})`);
    const metadata = {
      ...schedule.metadata,
      scheduleId: schedule.id,
      triggerType: schedule.triggerType,
      ...triggerContext ?? {}
    };
    const runId = await this.engine.startRun({
      kind: schedule.workflowKind,
      input: schedule.input,
      metadata
    });
    schedule.lastRunAt = /* @__PURE__ */ new Date();
    schedule.lastRunId = runId;
    if (this.persistence) {
      await this.persistence.updateSchedule(schedule.id, {
        lastRunAt: schedule.lastRunAt,
        lastRunId: schedule.lastRunId,
        nextRunAt: schedule.nextRunAt
      });
    }
    return runId;
  }
  /**
   * Update the next run time for a cron schedule.
   */
  updateNextRunTime(schedule) {
    if (!schedule.cronExpression) return;
    try {
      const interval = parseExpression(schedule.cronExpression, {
        currentDate: /* @__PURE__ */ new Date(),
        tz: schedule.timezone
      });
      schedule.nextRunAt = interval.next().toDate();
    } catch (error) {
      this.logger.error(`Failed to parse cron expression for schedule ${schedule.id}:`, error);
      schedule.nextRunAt = void 0;
    }
  }
};

// src/scheduler/sqlite-persistence.ts
var SQLiteSchedulePersistence = class {
  db;
  tableName;
  stmts = null;
  constructor(config) {
    this.db = config.db;
    this.tableName = config.tableName ?? "workflow_schedules";
    this.initializeDatabase();
  }
  // ============================================================================
  // Database Initialization
  // ============================================================================
  initializeDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        workflow_kind TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        cron_expression TEXT,
        timezone TEXT,
        trigger_on_workflow_kind TEXT,
        trigger_on_status TEXT,
        input TEXT,
        metadata TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_run_id TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_workflow_kind
      ON ${this.tableName}(workflow_kind);

      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_enabled
      ON ${this.tableName}(enabled);

      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_trigger_type
      ON ${this.tableName}(trigger_type);
    `);
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO ${this.tableName} (
          id, workflow_kind, trigger_type, cron_expression, timezone,
          trigger_on_workflow_kind, trigger_on_status, input, metadata,
          enabled, last_run_at, last_run_id, next_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      update: this.db.prepare(`
        UPDATE ${this.tableName}
        SET workflow_kind = COALESCE(?, workflow_kind),
            trigger_type = COALESCE(?, trigger_type),
            cron_expression = ?,
            timezone = ?,
            trigger_on_workflow_kind = ?,
            trigger_on_status = ?,
            input = ?,
            metadata = ?,
            enabled = COALESCE(?, enabled),
            last_run_at = ?,
            last_run_id = ?,
            next_run_at = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `),
      delete: this.db.prepare(`
        DELETE FROM ${this.tableName} WHERE id = ?
      `),
      getAll: this.db.prepare(`
        SELECT * FROM ${this.tableName}
      `),
      getById: this.db.prepare(`
        SELECT * FROM ${this.tableName} WHERE id = ?
      `)
    };
  }
  // ============================================================================
  // SchedulePersistence Interface Implementation
  // ============================================================================
  async loadSchedules() {
    const rows = this.stmts.getAll.all();
    return rows.map((row) => this.rowToSchedule(row));
  }
  async saveSchedule(schedule) {
    this.stmts.insert.run(
      schedule.id,
      schedule.workflowKind,
      schedule.triggerType,
      schedule.cronExpression ?? null,
      schedule.timezone ?? null,
      schedule.triggerOnWorkflowKind ?? null,
      schedule.triggerOnStatus ? JSON.stringify(schedule.triggerOnStatus) : null,
      schedule.input ? JSON.stringify(schedule.input) : null,
      schedule.metadata ? JSON.stringify(schedule.metadata) : null,
      schedule.enabled ? 1 : 0,
      schedule.lastRunAt?.toISOString() ?? null,
      schedule.lastRunId ?? null,
      schedule.nextRunAt?.toISOString() ?? null
    );
  }
  async updateSchedule(scheduleId, updates) {
    const existing = this.stmts.getById.get(scheduleId);
    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    const merged = {
      ...this.rowToSchedule(existing),
      ...updates
    };
    this.stmts.update.run(
      updates.workflowKind ?? null,
      updates.triggerType ?? null,
      merged.cronExpression ?? null,
      merged.timezone ?? null,
      merged.triggerOnWorkflowKind ?? null,
      merged.triggerOnStatus ? JSON.stringify(merged.triggerOnStatus) : null,
      merged.input ? JSON.stringify(merged.input) : null,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      updates.enabled !== void 0 ? updates.enabled ? 1 : 0 : null,
      merged.lastRunAt?.toISOString() ?? null,
      merged.lastRunId ?? null,
      merged.nextRunAt?.toISOString() ?? null,
      scheduleId
    );
  }
  async deleteSchedule(scheduleId) {
    this.stmts.delete.run(scheduleId);
  }
  // ============================================================================
  // Helper Methods
  // ============================================================================
  rowToSchedule(row) {
    return {
      id: row.id,
      workflowKind: row.workflow_kind,
      triggerType: row.trigger_type,
      cronExpression: row.cron_expression ?? void 0,
      timezone: row.timezone ?? void 0,
      triggerOnWorkflowKind: row.trigger_on_workflow_kind ?? void 0,
      triggerOnStatus: row.trigger_on_status ? JSON.parse(row.trigger_on_status) : void 0,
      input: row.input ? JSON.parse(row.input) : void 0,
      metadata: row.metadata ? JSON.parse(row.metadata) : void 0,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : void 0,
      lastRunId: row.last_run_id ?? void 0,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : void 0
    };
  }
};

// src/scheduler/postgres-persistence.ts
import { Kysely, PostgresDialect, sql } from "kysely";
var PostgresSchedulePersistence = class {
  db;
  pool;
  ownsPool;
  schema;
  tableName;
  autoMigrate;
  initialized = false;
  constructor(config) {
    this.schema = config.schema ?? "public";
    this.tableName = config.tableName ?? "workflow_schedules";
    this.autoMigrate = config.autoMigrate !== false;
    let pg;
    try {
      pg = __require("pg");
    } catch {
      throw new Error(
        'PostgresSchedulePersistence requires the "pg" package. Install it with: npm install pg'
      );
    }
    if (config.pool) {
      this.pool = config.pool;
      this.ownsPool = false;
    } else if (config.connectionString) {
      this.pool = new pg.Pool({ connectionString: config.connectionString });
      this.ownsPool = true;
    } else if (config.poolConfig) {
      this.pool = new pg.Pool(config.poolConfig);
      this.ownsPool = true;
    } else {
      throw new Error(
        "PostgresSchedulePersistenceConfig must include either pool, connectionString, or poolConfig"
      );
    }
    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: this.pool
      })
    });
  }
  /**
   * Initialize the persistence layer.
   * Creates the schedules table if autoMigrate is enabled.
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    if (this.autoMigrate) {
      await this.createTables();
    }
    this.initialized = true;
  }
  /**
   * Close the database connection.
   * Only closes the pool if it was created by this adapter.
   */
  async close() {
    await this.db.destroy();
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
  // ============================================================================
  // Database Initialization
  // ============================================================================
  async createTables() {
    const fullTableName = this.schema === "public" ? this.tableName : `${this.schema}.${this.tableName}`;
    if (this.schema !== "public") {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);
    }
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(fullTableName)} (
        id TEXT PRIMARY KEY,
        workflow_kind TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        cron_expression TEXT,
        timezone TEXT DEFAULT 'UTC',
        trigger_on_workflow_kind TEXT,
        trigger_on_status JSONB,
        input_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        last_run_at TIMESTAMPTZ,
        last_run_id TEXT,
        next_run_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ${sql.ref(`${this.tableName}_trigger_type_check`)} CHECK (
          trigger_type IN ('cron', 'workflow_completed', 'manual')
        )
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_workflow_kind`)}
      ON ${sql.table(fullTableName)} (workflow_kind)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_enabled`)}
      ON ${sql.table(fullTableName)} (enabled)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_trigger_type`)}
      ON ${sql.table(fullTableName)} (trigger_type)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_next_run`)}
      ON ${sql.table(fullTableName)} (next_run_at)
      WHERE enabled = true
    `.execute(this.db);
  }
  // ============================================================================
  // SchedulePersistence Interface Implementation
  // ============================================================================
  async loadSchedules() {
    const rows = await this.db.selectFrom("workflow_schedules").selectAll().execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  async saveSchedule(schedule) {
    await this.db.insertInto("workflow_schedules").values({
      id: schedule.id,
      workflow_kind: schedule.workflowKind,
      trigger_type: schedule.triggerType,
      cron_expression: schedule.cronExpression ?? null,
      timezone: schedule.timezone ?? null,
      trigger_on_workflow_kind: schedule.triggerOnWorkflowKind ?? null,
      trigger_on_status: schedule.triggerOnStatus ? JSON.stringify(schedule.triggerOnStatus) : null,
      input_json: schedule.input ? JSON.stringify(schedule.input) : null,
      metadata_json: schedule.metadata ? JSON.stringify(schedule.metadata) : null,
      enabled: schedule.enabled,
      last_run_at: schedule.lastRunAt ?? null,
      last_run_id: schedule.lastRunId ?? null,
      next_run_at: schedule.nextRunAt ?? null,
      created_at: /* @__PURE__ */ new Date(),
      updated_at: /* @__PURE__ */ new Date()
    }).execute();
  }
  async updateSchedule(scheduleId, updates) {
    const existing = await this.db.selectFrom("workflow_schedules").selectAll().where("id", "=", scheduleId).executeTakeFirst();
    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    const merged = {
      ...this.rowToSchedule(existing),
      ...updates
    };
    const updateData = {
      updated_at: /* @__PURE__ */ new Date()
    };
    if (updates.workflowKind !== void 0) {
      updateData.workflow_kind = updates.workflowKind;
    }
    if (updates.triggerType !== void 0) {
      updateData.trigger_type = updates.triggerType;
    }
    if (updates.cronExpression !== void 0 || merged.cronExpression !== void 0) {
      updateData.cron_expression = merged.cronExpression ?? null;
    }
    if (updates.timezone !== void 0 || merged.timezone !== void 0) {
      updateData.timezone = merged.timezone ?? null;
    }
    if (updates.triggerOnWorkflowKind !== void 0 || merged.triggerOnWorkflowKind !== void 0) {
      updateData.trigger_on_workflow_kind = merged.triggerOnWorkflowKind ?? null;
    }
    if (updates.triggerOnStatus !== void 0 || merged.triggerOnStatus !== void 0) {
      updateData.trigger_on_status = merged.triggerOnStatus ? JSON.stringify(merged.triggerOnStatus) : null;
    }
    if (updates.input !== void 0 || merged.input !== void 0) {
      updateData.input_json = merged.input ? JSON.stringify(merged.input) : null;
    }
    if (updates.metadata !== void 0 || merged.metadata !== void 0) {
      updateData.metadata_json = merged.metadata ? JSON.stringify(merged.metadata) : null;
    }
    if (updates.enabled !== void 0) {
      updateData.enabled = updates.enabled;
    }
    if (updates.lastRunAt !== void 0 || merged.lastRunAt !== void 0) {
      updateData.last_run_at = merged.lastRunAt ?? null;
    }
    if (updates.lastRunId !== void 0 || merged.lastRunId !== void 0) {
      updateData.last_run_id = merged.lastRunId ?? null;
    }
    if (updates.nextRunAt !== void 0 || merged.nextRunAt !== void 0) {
      updateData.next_run_at = merged.nextRunAt ?? null;
    }
    await this.db.updateTable("workflow_schedules").set(updateData).where("id", "=", scheduleId).execute();
  }
  async deleteSchedule(scheduleId) {
    await this.db.deleteFrom("workflow_schedules").where("id", "=", scheduleId).execute();
  }
  // ============================================================================
  // Additional Methods
  // ============================================================================
  /**
   * Get a schedule by ID.
   */
  async getSchedule(scheduleId) {
    const row = await this.db.selectFrom("workflow_schedules").selectAll().where("id", "=", scheduleId).executeTakeFirst();
    return row ? this.rowToSchedule(row) : null;
  }
  /**
   * Get all enabled schedules that are due to run.
   */
  async getDueSchedules() {
    const now = /* @__PURE__ */ new Date();
    const rows = await this.db.selectFrom("workflow_schedules").selectAll().where("enabled", "=", true).where("trigger_type", "=", "cron").where("next_run_at", "<=", now).execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  /**
   * Get schedules by workflow kind.
   */
  async getSchedulesByWorkflowKind(workflowKind) {
    const rows = await this.db.selectFrom("workflow_schedules").selectAll().where("workflow_kind", "=", workflowKind).execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  /**
   * Get workflow completion triggers for a specific workflow kind.
   */
  async getCompletionTriggers(triggerOnWorkflowKind) {
    const rows = await this.db.selectFrom("workflow_schedules").selectAll().where("enabled", "=", true).where("trigger_type", "=", "workflow_completed").where("trigger_on_workflow_kind", "=", triggerOnWorkflowKind).execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  // ============================================================================
  // Helper Methods
  // ============================================================================
  rowToSchedule(row) {
    return {
      id: row.id,
      workflowKind: row.workflow_kind,
      triggerType: row.trigger_type,
      cronExpression: row.cron_expression ?? void 0,
      timezone: row.timezone ?? void 0,
      triggerOnWorkflowKind: row.trigger_on_workflow_kind ?? void 0,
      triggerOnStatus: row.trigger_on_status ? typeof row.trigger_on_status === "string" ? JSON.parse(row.trigger_on_status) : row.trigger_on_status : void 0,
      input: row.input_json ? typeof row.input_json === "string" ? JSON.parse(row.input_json) : row.input_json : void 0,
      metadata: row.metadata_json ? typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json : void 0,
      enabled: row.enabled,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : void 0,
      lastRunId: row.last_run_id ?? void 0,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : void 0
    };
  }
};

// src/planning/registry.ts
var MemoryStepHandlerRegistry = class {
  handlers = /* @__PURE__ */ new Map();
  tagIndex = /* @__PURE__ */ new Map();
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
  get(id) {
    return this.handlers.get(id);
  }
  has(id) {
    return this.handlers.has(id);
  }
  list() {
    return Array.from(this.handlers.values());
  }
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
  registerAll(recipes) {
    for (const recipe of recipes) {
      this.register(recipe);
    }
  }
  get(recipeId) {
    return this.recipes.get(recipeId);
  }
  has(recipeId) {
    return this.recipes.has(recipeId);
  }
  getByKind(workflowKind) {
    const ids = this.kindIndex.get(workflowKind);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.recipes.get(id)).filter((r) => r !== void 0);
  }
  getVariant(workflowKind, variant) {
    const variantKey = `${workflowKind}:${variant}`;
    const recipeId = this.variantIndex.get(variantKey);
    if (!recipeId) return void 0;
    return this.recipes.get(recipeId);
  }
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
  listVariants(workflowKind) {
    const recipes = this.getByKind(workflowKind);
    return recipes.map((r) => r.variant);
  }
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
  constructor(config) {
    this.recipeRegistry = config.recipeRegistry;
    this.handlerRegistry = config.handlerRegistry;
    this.validateHandlers = config.validateHandlers ?? false;
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
    const baseApiCallsPerStep = 1;
    const baseTokensPerStep = 500;
    const baseDurationPerStep = 2e3;
    const stepCount = plan.steps.length;
    const childCount = plan.childWorkflows?.length ?? 0;
    return {
      apiCalls: stepCount * baseApiCallsPerStep + childCount * 5,
      tokens: stepCount * baseTokensPerStep,
      duration: stepCount * baseDurationPerStep
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
    let modifiedSteps = [...steps];
    if (constraints.priority === "speed") {
      modifiedSteps = modifiedSteps.map((step) => ({
        ...step,
        timeout: step.timeout ? Math.min(step.timeout, 3e4) : 3e4,
        maxRetries: Math.min(step.maxRetries ?? 3, 1)
      }));
      modifications.push({
        type: "set_default",
        value: { priority: "speed" },
        reason: "Optimized for speed: reduced timeouts and retries"
      });
    }
    if (constraints.priority === "cost") {
      modifiedSteps = modifiedSteps.map((step) => ({
        ...step,
        maxRetries: 0
      }));
      modifications.push({
        type: "set_default",
        value: { priority: "cost" },
        reason: "Optimized for cost: disabled retries"
      });
    }
    if (constraints.maxDuration) {
      const perStepTimeout = Math.floor(constraints.maxDuration / modifiedSteps.length);
      modifiedSteps = modifiedSteps.map((step) => ({
        ...step,
        timeout: step.timeout ? Math.min(step.timeout, perStepTimeout) : perStepTimeout
      }));
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
  PostgresStorageAdapter,
  RuleBasedPlanner,
  RunNotFoundError,
  SQLiteSchedulePersistence,
  SQLiteStorageAdapter,
  SilentLogger,
  SocketIOEventTransport,
  StepError,
  StepTimeoutError,
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
  sleep,
  withRetry
};
//# sourceMappingURL=index.js.map