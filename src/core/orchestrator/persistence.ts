/**
 * Orchestrator persistence layer.
 *
 * Wraps the storage adapter and event transport with intent-named helpers
 * so the orchestrator and step-runner can stay focused on control flow
 * instead of repeating field shapes for every status transition.
 *
 * All side-effect calls the orchestrator makes against storage or the event
 * transport flow through this module — keeping the rest of the pipeline
 * pure(-ish) and easy to read.
 */
import type { StorageAdapter, WorkflowRunStepRecord } from '../../storage/types';
import type { EventTransport, WorkflowEvent } from '../../events/types';
import type { Logger, WorkflowError } from '../types';
import { WorkflowEngineError } from '../../utils/errors';

/**
 * Mark the run as running. On a fresh start, also stamp `startedAt`;
 * on resume, leave the original `startedAt` alone.
 */
export async function markRunRunning(
  storage: StorageAdapter,
  runId: string,
  isResume: boolean
): Promise<void> {
  await storage.updateRun(runId, {
    status: 'running',
    ...(isResume ? {} : { startedAt: new Date() }),
  });
}

/**
 * Persist the workflow checkpoint after a step completes:
 * the accumulated step results plus the list of completed step keys.
 */
export async function saveCheckpoint(
  storage: StorageAdapter,
  runId: string,
  results: Record<string, unknown>,
  completedSteps: string[]
): Promise<void> {
  await storage.updateRun(runId, {
    context: { ...results },
    completedSteps: [...completedSteps],
  });
}

/**
 * Mark the run as succeeded, persisting results and finishedAt.
 */
export async function markRunSucceeded(
  storage: StorageAdapter,
  runId: string,
  results: Record<string, unknown>
): Promise<void> {
  await storage.updateRun(runId, {
    status: 'succeeded',
    context: results,
    finishedAt: new Date(),
  });
}

/**
 * Persist a non-success terminal state for the run (failed / canceled / timeout).
 * `status` is the storage-level status — the orchestrator decides this from the
 * raised error using `state-transitions.ts`.
 */
export async function markRunFinal(
  storage: StorageAdapter,
  runId: string,
  status: 'failed' | 'canceled',
  results: Record<string, unknown>,
  error: WorkflowError
): Promise<void> {
  await storage.updateRun(runId, {
    status,
    context: results,
    error,
    finishedAt: new Date(),
  });
}

/**
 * Create a fresh step record in 'running' state for the given attempt.
 * Returns the persisted record so the caller can read its generated id.
 */
export async function createStepRecord(
  storage: StorageAdapter,
  runId: string,
  stepKey: string,
  stepName: string,
  attempt: number
): Promise<WorkflowRunStepRecord> {
  return storage.createStep({
    runId,
    stepKey,
    stepName,
    status: 'running',
    attempt,
    startedAt: new Date(),
  });
}

/**
 * Mark a step as succeeded, recording its result and finishedAt.
 */
export async function markStepSucceeded(
  storage: StorageAdapter,
  stepId: string,
  result: unknown
): Promise<void> {
  await storage.updateStep(stepId, {
    status: 'succeeded',
    result,
    finishedAt: new Date(),
  });
}

/**
 * Mark a step as failed (or canceled, if the abort signal already fired)
 * with the normalized engine error attached.
 */
export async function markStepFailed(
  storage: StorageAdapter,
  stepId: string,
  error: unknown,
  isCanceled: boolean
): Promise<void> {
  await storage.updateStep(stepId, {
    status: isCanceled ? 'canceled' : 'failed',
    error: WorkflowEngineError.fromError(error),
    finishedAt: new Date(),
  });
}

/**
 * Mark a step as canceled without an error payload — used when an in-flight
 * retry sleep is interrupted by an abort signal.
 */
export async function markStepCanceled(
  storage: StorageAdapter,
  stepId: string
): Promise<void> {
  await storage.updateStep(stepId, {
    status: 'canceled',
    finishedAt: new Date(),
  });
}

/**
 * Emit a workflow event without ever throwing back into the caller.
 * Event emission failures are logged but never abort the workflow,
 * so a flaky transport can't take down a run.
 */
export function safeEmitEvent(
  events: EventTransport,
  logger: Logger,
  event: WorkflowEvent
): void {
  try {
    events.emit(event);
  } catch (error) {
    logger.error('Failed to emit event:', error);
  }
}
