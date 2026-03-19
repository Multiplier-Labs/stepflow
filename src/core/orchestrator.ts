/**
 * Workflow Orchestrator
 *
 * This module is the heart of the workflow execution system.
 * It manages the execution of workflow steps, handles errors,
 * emits events, and persists state.
 */

import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowContext,
  RunResult,
  Logger,
  SpawnChildOptions,
} from './types';
import type { StorageAdapter } from '../storage/types';
import type { EventTransport, WorkflowEvent } from '../events/types';
import { WorkflowEngineError, StepError, StepTimeoutError, WorkflowCanceledError, WorkflowTimeoutError } from '../utils/errors';
import { createScopedLogger } from '../utils/logger';
import { sleep, calculateRetryDelay } from '../utils/retry';

/**
 * Checkpoint data for resuming workflows.
 */
export interface WorkflowCheckpoint {
  /** Set of step keys that have been completed */
  completedStepKeys: Set<string>;
  /** Accumulated results from completed steps */
  results: Record<string, unknown>;
}

/**
 * Options for executing a workflow.
 */
export interface ExecuteOptions {
  /** The run ID */
  runId: string;
  /** The workflow definition */
  definition: WorkflowDefinition;
  /** Input parameters */
  input: Record<string, unknown>;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Storage adapter */
  storage: StorageAdapter;
  /** Event transport */
  events: EventTransport;
  /** Logger instance */
  logger: Logger;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Function to spawn child workflows */
  spawnChild: (options: SpawnChildOptions) => Promise<string>;
  /** Optional checkpoint for resuming from a previous execution */
  checkpoint?: WorkflowCheckpoint;
}

/**
 * Execute a workflow definition.
 * This is the main execution logic that runs all steps sequentially.
 */
export async function executeWorkflow(options: ExecuteOptions): Promise<RunResult> {
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
    checkpoint,
  } = options;

  const startTime = Date.now();
  const isResume = !!checkpoint;

  // Update run status to running (if not already)
  // On resume, don't overwrite the original startedAt
  await storage.updateRun(runId, {
    status: 'running',
    ...(isResume ? {} : { startedAt: new Date() }),
  });

  emitEvent(events, logger, {
    runId,
    kind: definition.kind,
    eventType: isResume ? 'run.resumed' : 'run.started',
    timestamp: new Date(),
    payload: isResume ? { resumedFrom: Array.from(checkpoint.completedStepKeys) } : undefined,
  });

  // Build the execution context, using checkpoint results if resuming
  const context: WorkflowContext = {
    runId,
    stepId: '',  // Will be set for each step before handler is called
    kind: definition.kind,
    input,
    results: checkpoint?.results ? { ...checkpoint.results } : {},
    metadata,
    logger: createScopedLogger(logger, runId),
    signal: abortController.signal,
    spawnChild,
    emit: (eventType: string, payload?: unknown) => {
      emitEvent(events, logger, {
        runId,
        kind: definition.kind,
        eventType,
        timestamp: new Date(),
        payload,
      });
    },
  };

  // Set up workflow-level timeout if specified
  let workflowTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let workflowTimeoutError: WorkflowTimeoutError | undefined;

  if (definition.timeout) {
    workflowTimeoutId = setTimeout(() => {
      workflowTimeoutError = new WorkflowTimeoutError(runId, definition.timeout!);
      abortController.abort();
    }, definition.timeout);
  }

  try {
    // Execute beforeRun hook
    if (definition.hooks?.beforeRun) {
      await definition.hooks.beforeRun(context);
    }

    // Execute each step in sequence
    for (const step of definition.steps) {
      // Check for cancellation
      if (abortController.signal.aborted) {
        throw new WorkflowCanceledError(runId);
      }

      context.currentStep = step.key;

      // Skip already completed steps when resuming
      if (checkpoint?.completedStepKeys.has(step.key)) {
        logger.info(`Skipping step "${step.key}" (already completed in previous run)`);
        emitEvent(events, logger, {
          runId,
          kind: definition.kind,
          eventType: 'step.skipped',
          stepKey: step.key,
          timestamp: new Date(),
          payload: { reason: 'checkpoint' },
        });
        continue;
      }

      // Check skip condition
      if (step.skipIf) {
        const shouldSkip = await step.skipIf(context);
        if (shouldSkip) {
          logger.info(`Skipping step "${step.key}" (condition met)`);

          emitEvent(events, logger, {
            runId,
            kind: definition.kind,
            eventType: 'step.skipped',
            stepKey: step.key,
            timestamp: new Date(),
          });

          continue;
        }
      }

      // Execute the step
      const result = await executeStep(step, context, {
        definition,
        storage,
        events,
        logger,
        abortController,
      });

      // Store result in context
      context.results[step.key] = result;

      // Save checkpoint (accumulated results)
      await storage.updateRun(runId, {
        context: { ...context.results },
      });
    }

    // All steps completed successfully
    // Clear workflow timeout
    if (workflowTimeoutId) {
      clearTimeout(workflowTimeoutId);
    }

    const duration = Date.now() - startTime;
    const runResult: RunResult = {
      status: 'succeeded',
      results: context.results,
      duration,
    };

    // Execute afterRun hook
    if (definition.hooks?.afterRun) {
      await definition.hooks.afterRun(context, runResult);
    }

    // Update run status
    await storage.updateRun(runId, {
      status: 'succeeded',
      context: context.results,
      finishedAt: new Date(),
    });

    emitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType: 'run.completed',
      timestamp: new Date(),
      payload: { results: context.results, duration },
    });

    return runResult;

  } catch (error) {
    // Clear workflow timeout
    if (workflowTimeoutId) {
      clearTimeout(workflowTimeoutId);
    }

    const duration = Date.now() - startTime;

    // Check if this was a workflow timeout (abort triggered by our timeout handler)
    const actualError = workflowTimeoutError ?? error;
    const workflowError = WorkflowEngineError.fromError(actualError);

    // Determine final status
    const isTimeout = actualError instanceof WorkflowTimeoutError;
    const isCanceled = !isTimeout && actualError instanceof WorkflowCanceledError;
    const status = isCanceled ? 'canceled' : 'failed';
    const eventType = isTimeout ? 'run.timeout' : (isCanceled ? 'run.canceled' : 'run.failed');

    const runResult: RunResult = {
      status,
      results: context.results,
      error: workflowError,
      duration,
    };

    // Execute afterRun hook (even on failure)
    if (definition.hooks?.afterRun) {
      try {
        await definition.hooks.afterRun(context, runResult);
      } catch (hookError) {
        logger.error('afterRun hook failed:', hookError);
      }
    }

    // Update run status
    await storage.updateRun(runId, {
      status,
      context: context.results,
      error: workflowError,
      finishedAt: new Date(),
    });

    emitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType,
      timestamp: new Date(),
      payload: { error: workflowError.message, duration },
    });

    return runResult;
  }
}

/**
 * Options for executing a single step.
 */
interface StepExecutionOptions<TInput = Record<string, unknown>> {
  definition: WorkflowDefinition<TInput>;
  storage: StorageAdapter;
  events: EventTransport;
  logger: Logger;
  abortController: AbortController;
}

/**
 * Execute a single workflow step with error handling and retries.
 */
async function executeStep<TInput>(
  step: WorkflowStep<TInput>,
  context: WorkflowContext<TInput>,
  options: StepExecutionOptions<TInput>
): Promise<unknown> {
  const { definition, storage, events, logger, abortController } = options;

  // Determine error strategy
  const onError = step.onError ?? definition.defaultOnError ?? 'fail';
  const maxRetries = step.maxRetries ?? 3;
  const retryDelay = step.retryDelay ?? 1000;
  const retryBackoff = step.retryBackoff ?? 2;

  let attempt = 0;
  let lastError: Error | undefined;

  while (true) {
    attempt++;

    // Check for cancellation
    if (abortController.signal.aborted) {
      throw new WorkflowCanceledError(context.runId);
    }

    // Create step record
    const stepRecord = await storage.createStep({
      runId: context.runId,
      stepKey: step.key,
      stepName: step.name,
      status: 'running',
      attempt,
      startedAt: new Date(),
    });

    // Set the current step's ID in context so handlers can track granular operations (e.g., token usage)
    context.stepId = stepRecord.id;

    // Emit step started event
    emitEvent(events, logger, {
      runId: context.runId,
      kind: context.kind,
      eventType: 'step.started',
      stepKey: step.key,
      timestamp: new Date(),
      payload: { attempt },
    });

    // Execute beforeStep hook
    if (definition.hooks?.beforeStep) {
      await definition.hooks.beforeStep(context, step);
    }

    try {
      // Execute with optional timeout
      // Always race against abort signal to support workflow-level timeouts
      let result: unknown;

      if (step.timeout) {
        result = await executeWithTimeout(
          () => step.handler(context),
          step.timeout,
          abortController.signal,
          step.key
        );
      } else {
        // Race step handler against abort signal for workflow-level timeout support
        result = await raceWithAbort(
          step.handler(context),
          abortController.signal
        );
      }

      // Step succeeded
      await storage.updateStep(stepRecord.id, {
        status: 'succeeded',
        result,
        finishedAt: new Date(),
      });

      // Execute afterStep hook
      if (definition.hooks?.afterStep) {
        await definition.hooks.afterStep(context, step, result);
      }

      emitEvent(events, logger, {
        runId: context.runId,
        kind: context.kind,
        eventType: 'step.completed',
        stepKey: step.key,
        timestamp: new Date(),
        payload: { result },
      });

      return result;

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is a cancellation (abort signal fired)
      const isCanceled = error instanceof WorkflowCanceledError;

      // Update step record with error
      await storage.updateStep(stepRecord.id, {
        status: isCanceled ? 'canceled' : 'failed',
        error: WorkflowEngineError.fromError(error),
        finishedAt: new Date(),
      });

      // If canceled, re-throw immediately without retry/skip logic
      if (isCanceled) {
        emitEvent(events, logger, {
          runId: context.runId,
          kind: context.kind,
          eventType: 'step.failed',
          stepKey: step.key,
          timestamp: new Date(),
          payload: { error: lastError.message, attempt },
        });
        throw error;
      }

      // Execute onStepError hook
      if (definition.hooks?.onStepError) {
        try {
          await definition.hooks.onStepError(context, step, lastError);
        } catch (hookError) {
          logger.error('onStepError hook failed:', hookError);
        }
      }

      emitEvent(events, logger, {
        runId: context.runId,
        kind: context.kind,
        eventType: 'step.failed',
        stepKey: step.key,
        timestamp: new Date(),
        payload: { error: lastError.message, attempt },
      });

      // Handle error based on strategy
      if (onError === 'skip') {
        logger.warn(`Step "${step.key}" failed, skipping (strategy: skip)`);
        emitEvent(events, logger, {
          runId: context.runId,
          kind: context.kind,
          eventType: 'step.skipped',
          stepKey: step.key,
          timestamp: new Date(),
          payload: { reason: 'error', error: lastError.message },
        });
        return undefined;
      }

      if (onError === 'retry' && attempt <= maxRetries) {
        const delay = calculateRetryDelay(attempt, retryDelay, retryBackoff);
        logger.warn(`Step "${step.key}" failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);

        emitEvent(events, logger, {
          runId: context.runId,
          kind: context.kind,
          eventType: 'step.retry',
          stepKey: step.key,
          timestamp: new Date(),
          payload: { attempt, maxRetries, delay, error: lastError.message },
        });

        await sleep(delay, abortController.signal);
        continue;
      }

      // Strategy is 'fail' or retries exhausted
      throw new StepError(step.key, lastError.message, attempt, lastError);
    }
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
async function executeWithTimeout<T>(
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
async function raceWithAbort<T>(
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

/**
 * Helper to emit an event.
 */
function emitEvent(events: EventTransport, logger: Logger, event: WorkflowEvent): void {
  try {
    events.emit(event);
  } catch (error) {
    // Log but don't fail the workflow for event emission errors
    logger.error('Failed to emit event:', error);
  }
}
