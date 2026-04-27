/**
 * Plan resolution — turns ExecuteOptions into the runtime artefacts
 * the orchestrator needs to start running steps.
 *
 * Today the engine has no separate planner module: the "plan" is just the
 * declarative WorkflowDefinition combined with the optional resume
 * checkpoint and the supplied input/metadata. This module is the seam
 * where, in the future, recipe/plan resolution and input validation can
 * grow without bloating execute-workflow.ts.
 *
 * Responsibilities:
 *   1. Build the WorkflowContext from the run options + checkpoint, with a
 *      `context.emit` helper that routes through safeEmitEvent.
 *   2. Set up the workflow-level timeout: returns a handle the caller
 *      clears in both the success and failure paths, and a getter for
 *      the WorkflowTimeoutError that fired (so the catch block can
 *      surface it instead of the abort-derived error).
 *   3. Compute the initial set of completed-step keys (used by the loop
 *      to skip steps already done in a previous run).
 */
import type {
  WorkflowDefinition,
  WorkflowContext,
  Logger,
  SpawnChildOptions,
} from '../types';
import type { EventTransport } from '../../events/types';
import { WorkflowTimeoutError } from '../../utils/errors';
import { createScopedLogger } from '../../utils/logger';
import { safeEmitEvent } from './persistence';

/**
 * Inputs needed to resolve a workflow plan + build its execution context.
 */
export interface BuildContextOptions {
  runId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  events: EventTransport;
  logger: Logger;
  abortController: AbortController;
  spawnChild: (options: SpawnChildOptions) => Promise<string>;
  /** Existing checkpoint results to preload into context.results. */
  checkpointResults?: Record<string, unknown>;
}

/**
 * Build the WorkflowContext that will be threaded through every step
 * handler. On resume, preload `context.results` from the checkpoint.
 */
export function buildContext(options: BuildContextOptions): WorkflowContext {
  const {
    runId,
    definition,
    input,
    metadata,
    events,
    logger,
    abortController,
    spawnChild,
    checkpointResults,
  } = options;

  return {
    runId,
    stepId: '', // set per-step by the step-runner before each handler call
    kind: definition.kind,
    input,
    results: checkpointResults ? { ...checkpointResults } : {},
    metadata,
    logger: createScopedLogger(logger, runId),
    signal: abortController.signal,
    spawnChild,
    emit: (eventType: string, payload?: unknown) => {
      safeEmitEvent(events, logger, {
        runId,
        kind: definition.kind,
        eventType,
        timestamp: new Date(),
        payload,
      });
    },
  };
}

/**
 * Handle returned by setupWorkflowTimeout. The orchestrator must call
 * `clear()` on both success and failure paths to release the timer, and
 * may read `getTimeoutError()` in the catch path: if non-null, the abort
 * was triggered by our timeout (not user cancellation), and the caller
 * should surface that error instead of the generic abort-derived one.
 */
export interface WorkflowTimeoutHandle {
  clear: () => void;
  getTimeoutError: () => WorkflowTimeoutError | undefined;
}

/**
 * Arm a workflow-level timeout if the definition specifies one.
 *
 * On fire: constructs a WorkflowTimeoutError (recoverable via
 * `getTimeoutError`) and aborts the controller, which causes any
 * in-flight step handler racing the abort signal to reject.
 *
 * If the definition has no timeout, returns no-op handles.
 */
export function setupWorkflowTimeout(
  runId: string,
  definition: WorkflowDefinition,
  abortController: AbortController
): WorkflowTimeoutHandle {
  if (!definition.timeout) {
    return {
      clear: () => {},
      getTimeoutError: () => undefined,
    };
  }

  let timeoutError: WorkflowTimeoutError | undefined;
  const timeoutId = setTimeout(() => {
    timeoutError = new WorkflowTimeoutError(runId, definition.timeout!);
    abortController.abort();
  }, definition.timeout);

  return {
    clear: () => clearTimeout(timeoutId),
    getTimeoutError: () => timeoutError,
  };
}

/**
 * Initial list of step keys to consider already complete — empty for a
 * fresh run, the checkpoint's set for a resume.
 */
export function initialCompletedSteps(
  checkpoint?: { completedStepKeys: Set<string> }
): string[] {
  return checkpoint ? Array.from(checkpoint.completedStepKeys) : [];
}
