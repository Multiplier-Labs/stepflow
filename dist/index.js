import {
  MemoryStorageAdapter,
  PostgresStorageAdapter,
  SQLiteStorageAdapter
} from "./chunk-4IDPWWGS.js";
import {
  MemoryEventTransport,
  SocketIOEventTransport,
  WebhookEventTransport
} from "./chunk-ASXSVHWT.js";
import {
  CronScheduler,
  PostgresSchedulePersistence,
  SQLiteSchedulePersistence
} from "./chunk-TVSADUYU.js";
import {
  ConsoleLogger,
  SilentLogger,
  createScopedLogger,
  generateId,
  sanitizeErrorForStorage
} from "./chunk-JPXPB7U5.js";

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
        message: error.message
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

// src/core/orchestrator/persistence.ts
async function markRunRunning(storage, runId, isResume) {
  await storage.updateRun(runId, {
    status: "running",
    ...isResume ? {} : { startedAt: /* @__PURE__ */ new Date() }
  });
}
async function saveCheckpoint(storage, runId, results, completedSteps) {
  await storage.updateRun(runId, {
    context: { ...results },
    completedSteps: [...completedSteps]
  });
}
async function markRunSucceeded(storage, runId, results) {
  await storage.updateRun(runId, {
    status: "succeeded",
    context: results,
    finishedAt: /* @__PURE__ */ new Date()
  });
}
async function markRunFinal(storage, runId, status, results, error) {
  await storage.updateRun(runId, {
    status,
    context: results,
    error,
    finishedAt: /* @__PURE__ */ new Date()
  });
}
async function createStepRecord(storage, runId, stepKey, stepName, attempt) {
  return storage.createStep({
    runId,
    stepKey,
    stepName,
    status: "running",
    attempt,
    startedAt: /* @__PURE__ */ new Date()
  });
}
async function markStepSucceeded(storage, stepId, result) {
  await storage.updateStep(stepId, {
    status: "succeeded",
    result,
    finishedAt: /* @__PURE__ */ new Date()
  });
}
async function markStepFailed(storage, stepId, error, isCanceled) {
  await storage.updateStep(stepId, {
    status: isCanceled ? "canceled" : "failed",
    error: WorkflowEngineError.fromError(error),
    finishedAt: /* @__PURE__ */ new Date()
  });
}
async function markStepCanceled(storage, stepId) {
  await storage.updateStep(stepId, {
    status: "canceled",
    finishedAt: /* @__PURE__ */ new Date()
  });
}
function safeEmitEvent(events, logger, event) {
  try {
    events.emit(event);
  } catch (error) {
    logger.error("Failed to emit event:", error);
  }
}

// src/core/orchestrator/state-transitions.ts
function decideRunFinalState(error) {
  if (error instanceof WorkflowTimeoutError) {
    return { status: "failed", eventType: "run.timeout" };
  }
  if (error instanceof WorkflowCanceledError) {
    return { status: "canceled", eventType: "run.canceled" };
  }
  return { status: "failed", eventType: "run.failed" };
}
function resolveStepErrorPolicy(step, definition) {
  return {
    onError: step.onError ?? definition.defaultOnError ?? "fail",
    maxRetries: step.maxRetries ?? 3,
    retryDelay: step.retryDelay ?? 1e3,
    retryBackoff: step.retryBackoff ?? 2
  };
}
function decideStepFailureAction(policy, attempt) {
  if (policy.onError === "skip") return "skip";
  if (policy.onError === "retry" && attempt <= policy.maxRetries) return "retry";
  return "fail";
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
      reject(new WorkflowCanceledError("run"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timeoutId);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    };
    let onAbort;
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        cleanup();
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
      throw new WorkflowCanceledError("run");
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

// src/core/orchestrator/step-runner.ts
async function executeStep(step, context, options) {
  const { definition, storage, events, logger, abortController } = options;
  const policy = resolveStepErrorPolicy(step, definition);
  let attempt = 0;
  while (true) {
    attempt++;
    throwIfCanceled(abortController, context.runId);
    const stepRecord = await beginStepAttempt(
      storage,
      events,
      logger,
      context,
      step,
      attempt
    );
    if (definition.hooks?.beforeStep) {
      await definition.hooks.beforeStep(context, step);
    }
    try {
      throwIfCanceled(abortController, context.runId);
      const result = await runStepHandler(step, context, abortController);
      await completeStepAttempt(
        storage,
        events,
        logger,
        stepRecord,
        context,
        step,
        result,
        definition
      );
      return result;
    } catch (error) {
      const lastError = toError(error);
      const isCanceled = error instanceof WorkflowCanceledError || abortController.signal.aborted;
      await markStepFailed(storage, stepRecord.id, error, isCanceled);
      if (isCanceled) {
        emitStepFailedEvent(events, logger, context, step, lastError, attempt);
        throw error;
      }
      await runOnStepErrorHook(definition, context, step, lastError, logger);
      emitStepFailedEvent(events, logger, context, step, lastError, attempt);
      const action = decideStepFailureAction(policy, attempt);
      if (action === "skip") {
        handleSkipAction(events, logger, context, step, lastError);
        return void 0;
      }
      if (action === "retry") {
        await handleRetryAction(
          storage,
          events,
          logger,
          abortController,
          context,
          step,
          attempt,
          policy,
          lastError,
          stepRecord.id
        );
        continue;
      }
      throw new StepError(step.key, lastError.message, attempt, lastError);
    }
  }
}
function throwIfCanceled(abortController, runId) {
  if (abortController.signal.aborted) {
    throw new WorkflowCanceledError(runId);
  }
}
async function beginStepAttempt(storage, events, logger, context, step, attempt) {
  const stepRecord = await createStepRecord(
    storage,
    context.runId,
    step.key,
    step.name,
    attempt
  );
  context.stepId = stepRecord.id;
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: "step.started",
    stepKey: step.key,
    timestamp: /* @__PURE__ */ new Date(),
    payload: { attempt }
  });
  return stepRecord;
}
async function runStepHandler(step, context, abortController) {
  if (step.timeout) {
    return executeWithTimeout(
      () => step.handler(context),
      step.timeout,
      abortController.signal,
      step.key
    );
  }
  return raceWithAbort(step.handler(context), abortController.signal);
}
async function completeStepAttempt(storage, events, logger, stepRecord, context, step, result, definition) {
  await markStepSucceeded(storage, stepRecord.id, result);
  if (definition.hooks?.afterStep) {
    await definition.hooks.afterStep(context, step, result);
  }
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: "step.completed",
    stepKey: step.key,
    timestamp: /* @__PURE__ */ new Date(),
    payload: { result }
  });
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
async function runOnStepErrorHook(definition, context, step, lastError, logger) {
  if (!definition.hooks?.onStepError) return;
  try {
    await definition.hooks.onStepError(context, step, lastError);
  } catch (hookError) {
    logger.error("onStepError hook failed for run " + context.runId + ":", hookError);
  }
}
function emitStepFailedEvent(events, logger, context, step, lastError, attempt) {
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: "step.failed",
    stepKey: step.key,
    timestamp: /* @__PURE__ */ new Date(),
    payload: { error: lastError.message, attempt }
  });
}
function handleSkipAction(events, logger, context, step, lastError) {
  logger.warn(`Step "${step.key}" failed, skipping (strategy: skip)`);
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: "step.skipped",
    stepKey: step.key,
    timestamp: /* @__PURE__ */ new Date(),
    payload: { reason: "error", error: lastError.message }
  });
}
async function handleRetryAction(storage, events, logger, abortController, context, step, attempt, policy, lastError, stepRecordId) {
  const delay = calculateRetryDelay(attempt, policy.retryDelay, policy.retryBackoff);
  logger.warn(
    `Step "${step.key}" failed, retrying in ${delay}ms (attempt ${attempt}/${policy.maxRetries})`
  );
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: "step.retry",
    stepKey: step.key,
    timestamp: /* @__PURE__ */ new Date(),
    payload: { attempt, maxRetries: policy.maxRetries, delay, error: lastError.message }
  });
  try {
    await sleep(delay, abortController.signal);
  } catch (sleepError) {
    if (sleepError instanceof WorkflowCanceledError) {
      await markStepCanceled(storage, stepRecordId);
    }
    throw sleepError;
  }
}
async function executeWithTimeout(fn, timeoutMs, signal, stepKey) {
  if (signal.aborted) throw new WorkflowCanceledError("run");
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

// src/core/orchestrator/plan-resolution.ts
function buildContext(options) {
  const {
    runId,
    definition,
    input,
    metadata,
    events,
    logger,
    abortController,
    spawnChild,
    checkpointResults
  } = options;
  return {
    runId,
    stepId: "",
    // set per-step by the step-runner before each handler call
    kind: definition.kind,
    input,
    results: checkpointResults ? { ...checkpointResults } : {},
    metadata,
    logger: createScopedLogger(logger, runId),
    signal: abortController.signal,
    spawnChild,
    emit: (eventType, payload) => {
      safeEmitEvent(events, logger, {
        runId,
        kind: definition.kind,
        eventType,
        timestamp: /* @__PURE__ */ new Date(),
        payload
      });
    }
  };
}
function setupWorkflowTimeout(runId, definition, abortController) {
  if (!definition.timeout) {
    return {
      clear: () => {
      },
      getTimeoutError: () => void 0
    };
  }
  let timeoutError;
  const timeoutId = setTimeout(() => {
    timeoutError = new WorkflowTimeoutError(runId, definition.timeout);
    abortController.abort();
  }, definition.timeout);
  return {
    clear: () => clearTimeout(timeoutId),
    getTimeoutError: () => timeoutError
  };
}
function initialCompletedSteps(checkpoint) {
  return checkpoint ? Array.from(checkpoint.completedStepKeys) : [];
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
  await markRunRunning(storage, runId, isResume);
  safeEmitEvent(events, logger, {
    runId,
    kind: definition.kind,
    eventType: isResume ? "run.resumed" : "run.started",
    timestamp: /* @__PURE__ */ new Date(),
    payload: isResume ? { resumedFrom: Array.from(checkpoint.completedStepKeys) } : void 0
  });
  const completedSteps = initialCompletedSteps(checkpoint);
  const context = buildContext({
    runId,
    definition,
    input,
    metadata,
    events,
    logger,
    abortController,
    spawnChild,
    checkpointResults: checkpoint?.results
  });
  const timeoutHandle = setupWorkflowTimeout(runId, definition, abortController);
  const checkCancellation = () => {
    if (abortController.signal.aborted) throw new WorkflowCanceledError(runId);
  };
  let afterRunCalled = false;
  try {
    checkCancellation();
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
        safeEmitEvent(events, logger, {
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
          safeEmitEvent(events, logger, {
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
      completedSteps.push(step.key);
      await saveCheckpoint(storage, runId, context.results, completedSteps);
    }
    checkCancellation();
    const duration = Date.now() - startTime;
    const runResult = {
      status: "succeeded",
      results: context.results,
      duration
    };
    if (definition.hooks?.afterRun) {
      afterRunCalled = true;
      await definition.hooks.afterRun(context, runResult);
    }
    checkCancellation();
    timeoutHandle.clear();
    await markRunSucceeded(storage, runId, context.results);
    safeEmitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType: "run.completed",
      timestamp: /* @__PURE__ */ new Date(),
      payload: { results: context.results, duration }
    });
    return runResult;
  } catch (error) {
    timeoutHandle.clear();
    const duration = Date.now() - startTime;
    const actualError = timeoutHandle.getTimeoutError() ?? error;
    const workflowError = WorkflowEngineError.fromError(actualError);
    const { status, eventType } = decideRunFinalState(actualError);
    const runResult = {
      status,
      results: context.results,
      error: workflowError,
      duration
    };
    if (definition.hooks?.afterRun && !afterRunCalled) {
      try {
        await definition.hooks.afterRun(context, runResult);
      } catch (hookError) {
        logger.error("afterRun hook failed for run " + runId + ":", hookError);
      }
    }
    await markRunFinal(storage, runId, status, context.results, workflowError);
    safeEmitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType,
      timestamp: /* @__PURE__ */ new Date(),
      payload: { error: workflowError.message, duration }
    });
    return runResult;
  }
}

// src/core/engine/concurrency.ts
var ConcurrencyManager = class {
  activeRuns = /* @__PURE__ */ new Map();
  runQueue = [];
  timerHandles = /* @__PURE__ */ new Map();
  pendingOperations = /* @__PURE__ */ new Set();
  stopping = false;
  storage;
  events;
  logger;
  maxConcurrency;
  constructor(deps) {
    this.storage = deps.storage;
    this.events = deps.events;
    this.logger = deps.logger;
    this.maxConcurrency = deps.maxConcurrency;
  }
  hasCapacity() {
    if (this.stopping) return false;
    if (this.maxConcurrency === void 0 || this.maxConcurrency <= 0) {
      return true;
    }
    return this.activeRuns.size < this.maxConcurrency;
  }
  getActiveCount() {
    return this.activeRuns.size;
  }
  getQueuedCount() {
    return this.runQueue.length;
  }
  isActive(runId) {
    return this.activeRuns.has(runId);
  }
  isQueued(runId) {
    return this.runQueue.some((run) => run.runId === runId);
  }
  assertAccepting() {
    if (this.stopping) throw new Error("Workflow engine is shutting down");
  }
  /** Track execution and admission I/O so adapters stay open until it settles. */
  track(operation) {
    this.pendingOperations.add(operation);
    const cleanup = () => {
      this.pendingOperations.delete(operation);
    };
    operation.then(cleanup, cleanup);
    return operation;
  }
  beginShutdown() {
    this.stopping = true;
    this.clearTimers();
    this.runQueue.length = 0;
  }
  /** Resolves true once tracked work settles, or false if `timeoutMs` elapses first. */
  async waitForIdle(timeoutMs) {
    let timeoutId;
    const deadline = timeoutMs === void 0 ? void 0 : new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(false), timeoutMs);
    });
    const drain = (async () => {
      while (this.pendingOperations.size > 0) {
        await Promise.allSettled([...this.pendingOperations]);
      }
      return true;
    })();
    try {
      return await (deadline ? Promise.race([drain, deadline]) : drain);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  /** Insert a run in priority order (higher priority first, FIFO within same). */
  enqueue(run) {
    this.assertAccepting();
    let inserted = false;
    for (let i = 0; i < this.runQueue.length; i++) {
      if (run.priority > this.runQueue[i].priority) {
        this.runQueue.splice(i, 0, run);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.runQueue.push(run);
    }
  }
  /** Remove a run from the queue if present. Returns true if it was queued. */
  removeFromQueue(runId) {
    const idx = this.runQueue.findIndex((q) => q.runId === runId);
    if (idx === -1) return false;
    this.runQueue.splice(idx, 1);
    return true;
  }
  registerActive(runId, controller) {
    this.assertAccepting();
    this.activeRuns.set(runId, controller);
  }
  unregisterActive(runId) {
    this.activeRuns.delete(runId);
  }
  abortActive(runId) {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  /**
   * Abort every in-flight run. `onAbort` is called for each run id before its
   * controller is signaled (so callers can log, emit, etc.).
   */
  abortAllActive(onAbort) {
    for (const [runId, controller] of this.activeRuns) {
      if (onAbort) onAbort(runId);
      controller.abort();
    }
  }
  /** Forget all active-run bookkeeping without aborting (used during shutdown). */
  clearActive() {
    this.activeRuns.clear();
  }
  /**
   * Schedule a launch via setTimeout (when `delay` is truthy) or setImmediate
   * (otherwise). Tracks the handle so it can be cleared during shutdown.
   */
  scheduleLaunch(fn, delay) {
    this.assertAccepting();
    if (delay) {
      const handle = setTimeout(() => {
        this.timerHandles.delete(handle);
        fn();
      }, delay);
      this.timerHandles.set(handle, () => clearTimeout(handle));
    } else {
      const handle = setImmediate(() => {
        this.timerHandles.delete(handle);
        fn();
      });
      this.timerHandles.set(handle, () => clearImmediate(handle));
    }
  }
  clearTimers() {
    for (const cancel of this.timerHandles.values()) cancel();
    this.timerHandles.clear();
  }
  /**
   * Drain the queue while capacity is available, dispatching each item via
   * `dispatch(run)`. Each iteration is wrapped in try/catch so that a failure
   * dispatching one queued item (e.g., an event-transport that throws) cannot
   * tear down the loop and leave remaining items stuck in the queue. Failed
   * dispatches are logged, the run is marked as failed in storage as
   * best-effort telemetry, and the loop advances to the next item.
   *
   * Emits `run.dequeued` for each dispatched run (this is what the C3
   * resilience test exercises by having the emit throw).
   */
  processQueue(dispatch) {
    while (this.hasCapacity() && this.runQueue.length > 0) {
      const next = this.runQueue.shift();
      try {
        this.logger.debug(`Starting queued run ${next.runId}`);
        this.events.emit({
          runId: next.runId,
          kind: next.definition.kind,
          eventType: "run.dequeued",
          timestamp: /* @__PURE__ */ new Date()
        });
        dispatch(next);
      } catch (err) {
        this.recordQueueDispatchFailure(next, err);
      }
    }
  }
  /**
   * Record a queue-dispatch failure: log it, emit a failure event, and
   * best-effort mark the run as failed in storage. All side-effects are
   * defensively wrapped so this method itself never throws.
   */
  recordQueueDispatchFailure(queued, err) {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Failed to dispatch queued run ${queued.runId}`, err);
    try {
      this.events.emit({
        runId: queued.runId,
        kind: queued.definition.kind,
        eventType: "run.failed",
        timestamp: /* @__PURE__ */ new Date(),
        payload: { error: { code: "QUEUE_DISPATCH_FAILED", message } }
      });
    } catch (emitErr) {
      this.logger.error(`Failed to emit dispatch-failure event for ${queued.runId}`, emitErr);
    }
    this.track(this.storage.updateRun(queued.runId, {
      status: "failed",
      finishedAt: /* @__PURE__ */ new Date(),
      error: { code: "QUEUE_DISPATCH_FAILED", message }
    }).catch((updateErr) => {
      this.logger.error(`Failed to record dispatch failure for ${queued.runId}`, updateErr);
    }));
  }
};

// src/core/engine/lifecycle.ts
var DEFAULT_SHUTDOWN_TIMEOUT_MS = 3e4;
var LifecycleManager = class {
  storage;
  events;
  logger;
  registry;
  concurrency;
  launchRun;
  shutdownTimeout;
  shutdownPromise;
  constructor(deps) {
    this.storage = deps.storage;
    this.events = deps.events;
    this.logger = deps.logger;
    this.registry = deps.registry;
    this.concurrency = deps.concurrency;
    this.launchRun = deps.launchRun;
    this.shutdownTimeout = deps.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  /**
   * Initialize the engine's storage adapter if it requires it.
   * Safe to call when the adapter has no `initialize` hook.
   */
  async initialize() {
    if (this.storage.initialize) {
      await this.storage.initialize();
    }
  }
  /**
   * Shutdown the engine gracefully:
   *   1. stop admission/dispatch and clear pending launch timers
   *   2. abort all in-flight runs
   *   3. await tracked execution and admission I/O
   *   4. close event and storage adapters, then drop active bookkeeping
   */
  shutdown() {
    return this.shutdownPromise ??= this.performShutdown();
  }
  async performShutdown() {
    this.logger.info("Shutting down workflow engine...");
    this.concurrency.beginShutdown();
    this.concurrency.abortAllActive((runId) => {
      this.logger.debug(`Canceling active run: ${runId}`);
    });
    const drained = await this.concurrency.waitForIdle(this.shutdownTimeout);
    if (!drained) {
      this.logger.warn(
        `Shutdown timed out after ${this.shutdownTimeout}ms waiting for in-flight work; closing adapters anyway`
      );
    }
    if (this.events.close) {
      this.events.close();
    }
    if (this.storage.close) {
      await this.storage.close();
    }
    this.concurrency.clearActive();
    this.logger.info("Workflow engine shutdown complete");
  }
  /**
   * Resume an interrupted workflow run from its checkpoint.
   * The run must be in 'queued' or 'running' status.
   */
  async resumeRun(runId) {
    this.concurrency.assertAccepting();
    const run = await this.storage.getRun(runId);
    this.concurrency.assertAccepting();
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
    if (this.concurrency.isActive(runId) || this.concurrency.isQueued(runId)) {
      this.logger.warn(`Run ${runId} is already active or queued, skipping resume`);
      return runId;
    }
    this.logger.info(`Resuming run ${runId} from checkpoint`);
    const completedStepKeys = new Set(run.completedSteps ?? []);
    const checkpoint = {
      completedStepKeys,
      results: run.context
    };
    if (this.concurrency.hasCapacity()) {
      this.launchRun(runId, definition, run.input, run.metadata, void 0, checkpoint);
    } else {
      this.concurrency.enqueue({
        runId,
        definition,
        input: run.input,
        metadata: run.metadata,
        priority: run.priority ?? 0,
        queuedAt: run.createdAt,
        checkpoint
      });
    }
    return runId;
  }
  /**
   * Get all runs that were interrupted and can be resumed.
   * Returns runs with status 'queued' or 'running'.
   */
  async getResumableRuns() {
    const runs = [];
    for (let offset = 0; ; ) {
      const result = await this.storage.listRuns({
        status: ["queued", "running"],
        limit: 100,
        offset
      });
      runs.push(...result.items);
      offset += result.items.length;
      if (result.items.length === 0 || offset >= result.total) return runs;
    }
  }
  /**
   * Resume every interrupted run whose workflow kind is currently registered.
   * Useful for recovering after a server restart.
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
};

// src/core/engine.ts
var WorkflowEngine = class _WorkflowEngine {
  registry = /* @__PURE__ */ new Map();
  storage;
  events;
  logger;
  settings;
  concurrency;
  lifecycle;
  constructor(config = {}) {
    this.storage = config.storage ?? new MemoryStorageAdapter();
    this.events = config.events ?? new MemoryEventTransport();
    this.logger = config.logger ?? new ConsoleLogger();
    this.settings = config.settings ?? {};
    this.concurrency = new ConcurrencyManager({
      storage: this.storage,
      events: this.events,
      logger: this.logger,
      maxConcurrency: this.settings.maxConcurrency
    });
    this.lifecycle = new LifecycleManager({
      storage: this.storage,
      events: this.events,
      logger: this.logger,
      registry: this.registry,
      concurrency: this.concurrency,
      shutdownTimeout: this.settings.shutdownTimeout,
      launchRun: (runId, def, input, metadata, delay, checkpoint) => this.launchRun(runId, def, input, metadata, delay, checkpoint)
    });
  }
  /**
   * Initialize the engine and its storage/event adapters.
   * Call this before starting runs if your storage adapter requires initialization
   * (e.g., PostgresStorageAdapter).
   */
  async initialize() {
    return this.lifecycle.initialize();
  }
  /**
   * Get the current number of active runs.
   */
  getActiveRunCount() {
    return this.concurrency.getActiveCount();
  }
  /**
   * Get the number of queued runs waiting for capacity.
   */
  getQueuedRunCount() {
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
    this.concurrency.assertAccepting();
    return this.concurrency.track(this.createAndStartRun(options));
  }
  async createAndStartRun(options) {
    const notBefore = Date.now() + (options.delay ?? 0);
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
    this.concurrency.assertAccepting();
    safeEmitEvent(this.events, this.logger, {
      runId,
      kind: options.kind,
      eventType: "run.created",
      timestamp: /* @__PURE__ */ new Date(),
      payload: { input: options.input, metadata: options.metadata, priority: options.priority ?? 0 }
    });
    if (this.concurrency.hasCapacity()) {
      this.executeRun(
        runId,
        definition,
        options.input ?? {},
        options.metadata,
        Math.max(0, notBefore - Date.now())
      );
    } else {
      this.concurrency.enqueue({
        runId,
        definition,
        input: options.input ?? {},
        metadata: options.metadata,
        priority: options.priority ?? 0,
        queuedAt: /* @__PURE__ */ new Date(),
        notBefore
      });
      this.logger.debug(`Run ${runId} queued (${this.concurrency.getQueuedCount()} in queue)`);
      safeEmitEvent(this.events, this.logger, {
        runId,
        kind: options.kind,
        eventType: "run.queued",
        timestamp: /* @__PURE__ */ new Date(),
        payload: { queuePosition: this.concurrency.getQueuedCount() }
      });
    }
    return runId;
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
    this.concurrency.registerActive(runId, abortController);
    const execute = async () => {
      try {
        await executeWorkflow({
          runId,
          definition: { ...definition, timeout: definition.timeout ?? this.settings.defaultTimeout },
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
        this.concurrency.unregisterActive(runId);
        this.processQueue();
      }
    };
    const guarded = () => {
      this.concurrency.track(execute().catch((err) => {
        this.concurrency.unregisterActive(runId);
        this.logger.error(`Unhandled error launching run ${runId}`, err);
      }));
    };
    this.concurrency.scheduleLaunch(guarded, delay);
  }
  /**
   * Drain the queue, dispatching each ready run via `executeRun`. Resilience
   * against per-item dispatch failures lives in `ConcurrencyManager.processQueue`.
   */
  processQueue() {
    this.concurrency.processQueue((next) => {
      this.launchRun(
        next.runId,
        next.definition,
        next.input,
        next.metadata,
        Math.max(0, (next.notBefore ?? 0) - Date.now()),
        next.checkpoint
      );
    });
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
   * @throws {RunNotFoundError} If no run with the given ID exists
   */
  async cancelRun(runId) {
    this.concurrency.assertAccepting();
    return this.concurrency.track(this.cancelTrackedRun(runId));
  }
  async cancelTrackedRun(runId) {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    if (["succeeded", "failed", "canceled", "timeout"].includes(run.status)) {
      return;
    }
    this.concurrency.removeFromQueue(runId);
    this.concurrency.abortActive(runId);
    await this.storage.updateRun(runId, {
      status: "canceled",
      finishedAt: /* @__PURE__ */ new Date()
    });
    safeEmitEvent(this.events, this.logger, {
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
    return new Promise(async (resolve, reject) => {
      let timeoutId;
      let unsubscribe;
      let settled = false;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) unsubscribe();
      };
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      timeoutId = setTimeout(() => {
        settle(() => reject(new WaitForRunTimeoutError(runId, timeout)));
      }, timeout);
      unsubscribe = this.events.subscribe(runId, async (event) => {
        if (_WorkflowEngine.TERMINAL_EVENT_TYPES.includes(event.eventType)) {
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
      try {
        const existingRun = await this.storage.getRun(runId);
        if (!existingRun) {
          settle(() => reject(new RunNotFoundError(runId)));
          return;
        }
        if (_WorkflowEngine.TERMINAL_STATUSES.includes(existingRun.status)) {
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
  async resumeRun(runId) {
    return this.concurrency.track(this.lifecycle.resumeRun(runId));
  }
  /**
   * Get all runs that were interrupted and can be resumed.
   * Returns runs with status 'queued' or 'running'.
   */
  async getResumableRuns() {
    this.concurrency.assertAccepting();
    return this.concurrency.track(this.lifecycle.getResumableRuns());
  }
  /**
   * Resume all interrupted runs.
   * Useful for recovering after a server restart.
   *
   * @returns Array of resumed run IDs
   */
  async resumeAllInterrupted() {
    this.concurrency.assertAccepting();
    return this.concurrency.track(this.lifecycle.resumeAllInterrupted());
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
    return this.lifecycle.shutdown();
  }
};

// src/planning/evaluate-condition.ts
import RE2 from "re2";
var MAX_REGEX_PATTERN_LENGTH = 512;
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
        if (conditionValue.length > MAX_REGEX_PATTERN_LENGTH) {
          return false;
        }
        try {
          return new RE2(conditionValue).test(fieldValue);
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
      const fieldValue = getNestedValue(input, condition.field);
      return evaluateCondition(condition.operator, fieldValue, condition.value);
    });
  }
};
function createRegistry() {
  return {
    recipes: new MemoryRecipeRegistry(),
    handlers: new MemoryStepHandlerRegistry()
  };
}

// src/planning/planner.ts
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