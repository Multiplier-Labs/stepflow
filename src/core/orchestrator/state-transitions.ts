/**
 * Pure state-transition decisions for the orchestrator.
 *
 * Every function in here is deterministic and side-effect-free: given
 * the current shape of an event, error, or step config they return what
 * the next state should be. The orchestrator and step-runner read these
 * decisions and apply them via persistence helpers.
 *
 * State-transition rules captured here:
 *
 *   Run terminal status:
 *     - WorkflowTimeoutError       → status='failed',   eventType='run.timeout'
 *     - WorkflowCanceledError      → status='canceled', eventType='run.canceled'
 *     - any other error            → status='failed',   eventType='run.failed'
 *
 *   Step error policy resolution (precedence):
 *     - step.onError                        > definition.defaultOnError > 'fail'
 *     - step.maxRetries                     > 3
 *     - step.retryDelay (ms)                > 1000
 *     - step.retryBackoff (multiplier)      > 2
 *
 *   Step retry decision (after a non-cancellation failure):
 *     - onError === 'skip'                            → 'skip'
 *     - onError === 'retry' && attempt <= maxRetries  → 'retry'
 *     - otherwise (incl. retries exhausted, 'fail')   → 'fail'
 */
import type { WorkflowDefinition, WorkflowStep } from '../types';
import { WorkflowCanceledError, WorkflowTimeoutError } from '../../utils/errors';

/**
 * Storage-level statuses the orchestrator may persist for a non-success run.
 */
export type RunFinalStatus = 'failed' | 'canceled';

/**
 * Event types emitted on a non-success run completion.
 */
export type RunFinalEventType = 'run.timeout' | 'run.canceled' | 'run.failed';

/**
 * Result of mapping an error to a terminal run state.
 */
export interface RunFinalDecision {
  status: RunFinalStatus;
  eventType: RunFinalEventType;
}

/**
 * Map a thrown workflow error to the final run status + event type.
 * Note: a workflow timeout is persisted as `failed` for storage compatibility,
 * but the emitted event distinguishes it via `run.timeout`.
 */
export function decideRunFinalState(error: unknown): RunFinalDecision {
  if (error instanceof WorkflowTimeoutError) {
    return { status: 'failed', eventType: 'run.timeout' };
  }
  if (error instanceof WorkflowCanceledError) {
    return { status: 'canceled', eventType: 'run.canceled' };
  }
  return { status: 'failed', eventType: 'run.failed' };
}

/**
 * Step-level error policy resolved from a step + workflow definition.
 */
export interface StepErrorPolicy {
  onError: 'fail' | 'skip' | 'retry';
  maxRetries: number;
  retryDelay: number;
  retryBackoff: number;
}

/**
 * Resolve the effective error policy for a step.
 * Step-level config overrides workflow defaults; workflow defaults override
 * the engine defaults (`fail` / 3 / 1000ms / 2x).
 */
export function resolveStepErrorPolicy<TInput>(
  step: WorkflowStep<TInput>,
  definition: WorkflowDefinition<TInput>
): StepErrorPolicy {
  return {
    onError: step.onError ?? definition.defaultOnError ?? 'fail',
    maxRetries: step.maxRetries ?? 3,
    retryDelay: step.retryDelay ?? 1000,
    retryBackoff: step.retryBackoff ?? 2,
  };
}

/**
 * Decision returned after a step attempt fails.
 *
 *  - 'skip'  : swallow the error and treat the step as a no-op (returns undefined)
 *  - 'retry' : back off and try again
 *  - 'fail'  : escalate (StepError) and abort the workflow
 */
export type StepFailureAction = 'skip' | 'retry' | 'fail';

/**
 * Decide what to do after a step attempt has failed (and was not canceled).
 */
export function decideStepFailureAction(
  policy: StepErrorPolicy,
  attempt: number
): StepFailureAction {
  if (policy.onError === 'skip') return 'skip';
  if (policy.onError === 'retry' && attempt <= policy.maxRetries) return 'retry';
  return 'fail';
}
