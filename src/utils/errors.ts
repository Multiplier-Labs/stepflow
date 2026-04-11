/**
 * Custom error classes for the workflow engine.
 */

import type { WorkflowError } from '../core/types';

/**
 * Base error class for workflow-related errors.
 */
export class WorkflowEngineError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkflowEngineError';
    this.code = code;
    this.details = details;
  }

  /**
   * Convert to a WorkflowError record for storage.
   */
  toRecord(): WorkflowError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  /**
   * Create a WorkflowError record from any error.
   */
  static fromError(error: unknown, defaultCode = 'UNKNOWN_ERROR'): WorkflowError {
    if (error instanceof WorkflowEngineError) {
      return error.toRecord();
    }

    if (error instanceof Error) {
      return {
        code: defaultCode,
        message: error.message,
      };
    }

    return {
      code: defaultCode,
      message: String(error),
    };
  }
}

/**
 * Error thrown when a workflow is not found in the registry.
 */
export class WorkflowNotFoundError extends WorkflowEngineError {
  constructor(kind: string) {
    super('WORKFLOW_NOT_FOUND', `Workflow "${kind}" is not registered`, { kind });
    this.name = 'WorkflowNotFoundError';
  }
}

/**
 * Error thrown when a workflow is already registered.
 */
export class WorkflowAlreadyRegisteredError extends WorkflowEngineError {
  constructor(kind: string) {
    super('WORKFLOW_ALREADY_REGISTERED', `Workflow "${kind}" is already registered`, { kind });
    this.name = 'WorkflowAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a run is not found.
 */
export class RunNotFoundError extends WorkflowEngineError {
  constructor(runId: string) {
    super('RUN_NOT_FOUND', `Run "${runId}" not found`, { runId });
    this.name = 'RunNotFoundError';
  }
}

/**
 * Error thrown when a step fails.
 */
export class StepError extends WorkflowEngineError {
  readonly stepKey: string;
  readonly attempt: number;
  readonly cause?: Error;

  constructor(stepKey: string, message: string, attempt: number, cause?: Error) {
    super('STEP_ERROR', message, { stepKey, attempt });
    this.name = 'StepError';
    this.stepKey = stepKey;
    this.attempt = attempt;
    this.cause = cause;
  }
}

/**
 * Error thrown when a step times out.
 */
export class StepTimeoutError extends WorkflowEngineError {
  readonly stepKey: string;
  readonly timeoutMs: number;

  constructor(stepKey: string, timeoutMs: number) {
    super('STEP_TIMEOUT', `Step "${stepKey}" timed out after ${timeoutMs}ms`, {
      stepKey,
      timeoutMs,
    });
    this.name = 'StepTimeoutError';
    this.stepKey = stepKey;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when a workflow is canceled.
 */
export class WorkflowCanceledError extends WorkflowEngineError {
  constructor(runId: string) {
    super('WORKFLOW_CANCELED', `Workflow run "${runId}" was canceled`, { runId });
    this.name = 'WorkflowCanceledError';
  }
}

/**
 * Error thrown when waitForRun times out polling for a terminal status.
 */
export class WaitForRunTimeoutError extends WorkflowEngineError {
  readonly runId: string;
  readonly timeoutMs: number;

  constructor(runId: string, timeoutMs: number) {
    super('WAIT_FOR_RUN_TIMEOUT', `Timeout waiting for run ${runId} after ${timeoutMs}ms`, {
      runId,
      timeoutMs,
    });
    this.name = 'WaitForRunTimeoutError';
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when a workflow times out.
 */
export class WorkflowTimeoutError extends WorkflowEngineError {
  readonly timeoutMs: number;

  constructor(runId: string, timeoutMs: number) {
    super('WORKFLOW_TIMEOUT', `Workflow run "${runId}" timed out after ${timeoutMs}ms`, {
      runId,
      timeoutMs,
    });
    this.name = 'WorkflowTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
