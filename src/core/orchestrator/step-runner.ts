/**
 * Step runner — executes a single workflow step with hooks, retries,
 * cancellation, and timeout handling.
 *
 * The shape of the previous monolithic `executeStep` was a `while (true)`
 * loop containing a `try`/`catch` with multiple nested `if` branches per
 * error path (cancel, hook, skip, retry, fail). This file flattens that:
 *
 *   - Each error path is its own intent-named helper
 *     (handleSkipAction, handleRetryAction, runOnStepErrorHook, etc.)
 *   - The main loop nesting is at most 3 levels (while → try → switch)
 *
 * State-transition rules covered here (see also state-transitions.ts):
 *
 *   pre-attempt:
 *     - abort signal already raised → throw WorkflowCanceledError
 *
 *   per-attempt:
 *     - handler resolves            → markStepSucceeded, emit step.completed, return
 *     - handler rejects + canceled  → markStepFailed(canceled), emit step.failed, rethrow
 *     - handler rejects + policy=skip   → emit step.skipped, return undefined
 *     - handler rejects + policy=retry  → emit step.retry, sleep, continue
 *     - handler rejects + policy=fail   → throw StepError
 */
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowContext,
  Logger,
} from '../types';
import type { StorageAdapter, WorkflowRunStepRecord } from '../../storage/types';
import type { EventTransport } from '../../events/types';
import {
  StepError,
  StepTimeoutError,
  WorkflowCanceledError,
} from '../../utils/errors';
import { sleep, calculateRetryDelay } from '../../utils/retry';
import {
  createStepRecord,
  markStepSucceeded,
  markStepFailed,
  markStepCanceled,
  safeEmitEvent,
} from './persistence';
import {
  resolveStepErrorPolicy,
  decideStepFailureAction,
  type StepErrorPolicy,
} from './state-transitions';

/**
 * Inputs to `executeStep` beyond the step + context themselves.
 */
export interface StepExecutionOptions<TInput = Record<string, unknown>> {
  definition: WorkflowDefinition<TInput>;
  storage: StorageAdapter;
  events: EventTransport;
  logger: Logger;
  abortController: AbortController;
}

/**
 * Execute a single workflow step with error handling and retries.
 *
 * Returns the step's result on success, or `undefined` if the resolved
 * error policy is `skip` and the step failed. Throws on cancellation,
 * timeout, or `fail` policy.
 */
export async function executeStep<TInput>(
  step: WorkflowStep<TInput>,
  context: WorkflowContext<TInput>,
  options: StepExecutionOptions<TInput>
): Promise<unknown> {
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
      const isCanceled =
        error instanceof WorkflowCanceledError || abortController.signal.aborted;

      await markStepFailed(storage, stepRecord.id, error, isCanceled);

      if (isCanceled) {
        emitStepFailedEvent(events, logger, context, step, lastError, attempt);
        throw error;
      }

      await runOnStepErrorHook(definition, context, step, lastError, logger);
      emitStepFailedEvent(events, logger, context, step, lastError, attempt);

      const action = decideStepFailureAction(policy, attempt);

      if (action === 'skip') {
        handleSkipAction(events, logger, context, step, lastError);
        return undefined;
      }

      if (action === 'retry') {
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

      // action === 'fail' — explicit fail strategy or retries exhausted
      throw new StepError(step.key, lastError.message, attempt, lastError);
    }
  }
}

/**
 * Throw a WorkflowCanceledError if the abort signal has already been raised.
 * Called at the top of each attempt so we don't even create a step record
 * after cancellation.
 */
function throwIfCanceled(abortController: AbortController, runId: string): void {
  if (abortController.signal.aborted) {
    throw new WorkflowCanceledError(runId);
  }
}

/**
 * Persist a fresh step record for this attempt, set it as the current step
 * id on the context (so handlers can attach granular telemetry), and emit
 * `step.started`.
 */
async function beginStepAttempt<TInput>(
  storage: StorageAdapter,
  events: EventTransport,
  logger: Logger,
  context: WorkflowContext<TInput>,
  step: WorkflowStep<TInput>,
  attempt: number
): Promise<WorkflowRunStepRecord> {
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
    eventType: 'step.started',
    stepKey: step.key,
    timestamp: new Date(),
    payload: { attempt },
  });
  return stepRecord;
}

/**
 * Invoke the step handler. If the step has its own timeout, race against it
 * AND the abort signal; otherwise just race against the abort signal so a
 * workflow-level timeout/cancellation still interrupts the step.
 */
async function runStepHandler<TInput>(
  step: WorkflowStep<TInput>,
  context: WorkflowContext<TInput>,
  abortController: AbortController
): Promise<unknown> {
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

/**
 * Mark the step as succeeded, run the afterStep hook (if any), and emit
 * `step.completed`.
 */
async function completeStepAttempt<TInput>(
  storage: StorageAdapter,
  events: EventTransport,
  logger: Logger,
  stepRecord: WorkflowRunStepRecord,
  context: WorkflowContext<TInput>,
  step: WorkflowStep<TInput>,
  result: unknown,
  definition: WorkflowDefinition<TInput>
): Promise<void> {
  await markStepSucceeded(storage, stepRecord.id, result);
  if (definition.hooks?.afterStep) {
    await definition.hooks.afterStep(context, step, result);
  }
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: 'step.completed',
    stepKey: step.key,
    timestamp: new Date(),
    payload: { result },
  });
}

/**
 * Coerce an unknown thrown value into a real Error, preserving message
 * text for non-Error throws.
 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Run the user's onStepError hook (if defined). Hook failures are logged
 * but never propagated — they must not mask the original step error.
 */
async function runOnStepErrorHook<TInput>(
  definition: WorkflowDefinition<TInput>,
  context: WorkflowContext<TInput>,
  step: WorkflowStep<TInput>,
  lastError: Error,
  logger: Logger
): Promise<void> {
  if (!definition.hooks?.onStepError) return;
  try {
    await definition.hooks.onStepError(context, step, lastError);
  } catch (hookError) {
    logger.error('onStepError hook failed for run ' + context.runId + ':', hookError);
  }
}

/**
 * Emit a `step.failed` event with the canonical payload.
 */
function emitStepFailedEvent<TInput>(
  events: EventTransport,
  logger: Logger,
  context: WorkflowContext<TInput>,
  step: WorkflowStep<TInput>,
  lastError: Error,
  attempt: number
): void {
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: 'step.failed',
    stepKey: step.key,
    timestamp: new Date(),
    payload: { error: lastError.message, attempt },
  });
}

/**
 * Apply the `skip` failure action: warn, emit `step.skipped`, then the
 * caller returns `undefined` from the step.
 */
function handleSkipAction<TInput>(
  events: EventTransport,
  logger: Logger,
  context: WorkflowContext<TInput>,
  step: WorkflowStep<TInput>,
  lastError: Error
): void {
  logger.warn(`Step "${step.key}" failed, skipping (strategy: skip)`);
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: 'step.skipped',
    stepKey: step.key,
    timestamp: new Date(),
    payload: { reason: 'error', error: lastError.message },
  });
}

/**
 * Apply the `retry` failure action: emit `step.retry`, sleep with backoff,
 * and let the loop fall through to the next attempt. If the sleep itself
 * is interrupted by cancellation, mark the step record canceled before
 * rethrowing.
 */
async function handleRetryAction<TInput>(
  storage: StorageAdapter,
  events: EventTransport,
  logger: Logger,
  abortController: AbortController,
  context: WorkflowContext<TInput>,
  step: WorkflowStep<TInput>,
  attempt: number,
  policy: StepErrorPolicy,
  lastError: Error,
  stepRecordId: string
): Promise<void> {
  const delay = calculateRetryDelay(attempt, policy.retryDelay, policy.retryBackoff);
  logger.warn(
    `Step "${step.key}" failed, retrying in ${delay}ms (attempt ${attempt}/${policy.maxRetries})`
  );
  safeEmitEvent(events, logger, {
    runId: context.runId,
    kind: context.kind,
    eventType: 'step.retry',
    stepKey: step.key,
    timestamp: new Date(),
    payload: { attempt, maxRetries: policy.maxRetries, delay, error: lastError.message },
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

/**
 * Execute a function with a timeout.
 *
 * Uses Promise.race to resolve as soon as either the function completes, the
 * timeout fires, or the abort signal triggers. The `finally` block is critical:
 * without it, the losing promise's timer/listener would remain active, leaking
 * memory — especially problematic in long-running engines processing many steps.
 */
export async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  stepKey: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new StepTimeoutError(stepKey, timeoutMs));
        }, timeoutMs);

        onAbort = () => {
          clearTimeout(timeoutId);
          reject(new WorkflowCanceledError('run'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Race a promise against an abort signal.
 *
 * Steps without their own timeout still need to respect workflow-level timeouts
 * and cancellation. This wraps the step handler in a Promise.race so that an
 * abort signal (from workflow timeout or user cancellation) can interrupt it.
 *
 * The `finally` cleanup removes the abort listener to prevent accumulating
 * listeners on the signal across many steps — without it, each step would
 * leave a dangling listener even after completing successfully.
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    throw new WorkflowCanceledError('run');
  }

  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new WorkflowCanceledError('run'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
