/**
 * Workflow Orchestrator
 *
 * This module is the heart of the workflow execution system.
 * It manages the execution of workflow steps, handles errors,
 * emits events, and persists state.
 */

import type {
  WorkflowDefinition,
  RunResult,
  Logger,
  SpawnChildOptions,
} from './types';
import type { StorageAdapter } from '../storage/types';
import type { EventTransport } from '../events/types';
import { WorkflowEngineError, WorkflowCanceledError } from '../utils/errors';
import {
  markRunRunning,
  saveCheckpoint,
  markRunSucceeded,
  markRunFinal,
  safeEmitEvent,
} from './orchestrator/persistence';
import { decideRunFinalState } from './orchestrator/state-transitions';
import { executeStep } from './orchestrator/step-runner';
import {
  buildContext,
  setupWorkflowTimeout,
  initialCompletedSteps,
} from './orchestrator/plan-resolution';

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
  await markRunRunning(storage, runId, isResume);

  safeEmitEvent(events, logger, {
    runId,
    kind: definition.kind,
    eventType: isResume ? 'run.resumed' : 'run.started',
    timestamp: new Date(),
    payload: isResume ? { resumedFrom: Array.from(checkpoint.completedStepKeys) } : undefined,
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
    checkpointResults: checkpoint?.results,
  });

  const timeoutHandle = setupWorkflowTimeout(runId, definition, abortController);

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
        safeEmitEvent(events, logger, {
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

          safeEmitEvent(events, logger, {
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

      // Track completed step
      completedSteps.push(step.key);

      // Save checkpoint (accumulated results + completed steps)
      await saveCheckpoint(storage, runId, context.results, completedSteps);
    }

    timeoutHandle.clear();

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
    await markRunSucceeded(storage, runId, context.results);

    safeEmitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType: 'run.completed',
      timestamp: new Date(),
      payload: { results: context.results, duration },
    });

    return runResult;

  } catch (error) {
    timeoutHandle.clear();

    const duration = Date.now() - startTime;

    const actualError = timeoutHandle.getTimeoutError() ?? error;
    const workflowError = WorkflowEngineError.fromError(actualError);

    // Determine final status + event type from the surfaced error.
    const { status, eventType } = decideRunFinalState(actualError);

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
        logger.error('afterRun hook failed for run ' + runId + ':', hookError);
      }
    }

    // Update run status
    await markRunFinal(storage, runId, status, context.results, workflowError);

    safeEmitEvent(events, logger, {
      runId,
      kind: definition.kind,
      eventType,
      timestamp: new Date(),
      payload: { error: workflowError.message, duration },
    });

    return runResult;
  }
}

