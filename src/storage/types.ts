/**
 * Storage interface types for the workflow engine.
 * Implement StorageAdapter to use your preferred database.
 */

import type { WorkflowKind, RunStatus, StepStatus, WorkflowError } from '../core/types';

// ============================================================================
// Record Types
// ============================================================================

/**
 * Stored representation of a workflow run.
 */
export interface WorkflowRunRecord {
  id: string;
  kind: WorkflowKind;
  status: RunStatus;
  parentRunId?: string;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /** Accumulated results from completed steps (checkpoint) */
  context: Record<string, unknown>;
  error?: WorkflowError;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

/**
 * Stored representation of a workflow step execution.
 */
export interface WorkflowRunStepRecord {
  id: string;
  runId: string;
  stepKey: string;
  stepName: string;
  status: StepStatus;
  attempt: number;
  result?: unknown;
  error?: WorkflowError;
  startedAt?: Date;
  finishedAt?: Date;
}

/**
 * Stored workflow event.
 */
export interface WorkflowEventRecord {
  id: string;
  runId: string;
  stepKey?: string;
  eventType: string;
  level: 'info' | 'warn' | 'error';
  payload?: unknown;
  timestamp: Date;
}

// ============================================================================
// Query Options
// ============================================================================

/**
 * Options for listing runs.
 */
export interface ListRunsOptions {
  kind?: WorkflowKind;
  status?: RunStatus | RunStatus[];
  parentRunId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'startedAt' | 'finishedAt';
  orderDirection?: 'asc' | 'desc';
}

/**
 * Options for listing events.
 */
export interface ListEventsOptions {
  stepKey?: string;
  level?: 'info' | 'warn' | 'error';
  limit?: number;
  offset?: number;
}

/**
 * Paginated result wrapper.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================================
// Storage Adapter Interface
// ============================================================================

/**
 * Abstract storage adapter interface.
 * Implement this interface to use your preferred database.
 */
export interface StorageAdapter {
  // Run operations
  createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
  getRun(runId: string): Promise<WorkflowRunRecord | null>;
  updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void>;
  listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;

  // Step operations
  createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
  getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
  updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
  getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;

  // Event operations
  saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
  getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;

  // Optional: Transaction support
  transaction?<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;

  // Optional: Cleanup
  deleteOldRuns?(olderThan: Date): Promise<number>;
}
