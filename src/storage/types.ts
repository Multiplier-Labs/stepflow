/**
 * Storage interface types for the workflow engine.
 * Implement StorageAdapter to use your preferred database.
 */

import type { Generated } from 'kysely';
import type { WorkflowKind, RunStatus, StepStatus, WorkflowError } from '../core/types';

// ============================================================================
// Extended Status Types (New)
// ============================================================================

/**
 * Extended status of a workflow run.
 * Adds 'pending' and 'timeout' to the core statuses.
 */
export type ExtendedRunStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timeout';

/**
 * Extended status of a workflow step.
 * Uses 'completed' instead of 'succeeded' for consistency.
 */
export type ExtendedStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

// ============================================================================
// Legacy Record Types (Backward Compatible)
// ============================================================================

/**
 * Stored representation of a workflow run.
 */
export interface WorkflowRunRecord {
  id: string;
  kind: string;
  status: RunStatus;
  parentRunId?: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  metadata?: Record<string, unknown>;
  priority?: number;
  timeoutMs?: number;
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
// New Extended Record Types
// ============================================================================

/**
 * Extended workflow run record with additional fields.
 * Used by new WorkflowStorage implementations.
 */
export interface ExtendedWorkflowRunRecord {
  id: string;
  kind: string;
  status: ExtendedRunStatus;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  metadata?: Record<string, unknown>;
  priority: number;
  timeoutMs?: number;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

/**
 * Step result representation.
 */
export interface StepResult {
  id: string;
  runId: string;
  stepName: string;
  status: ExtendedStepStatus;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  attempt: number;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Step record for workflow steps.
 */
export interface StepRecord {
  stepKey: string;
  stepName: string;
  status: ExtendedStepStatus;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  attempt: number;
  startedAt?: Date;
  finishedAt?: Date;
}

// ============================================================================
// Input Types (New)
// ============================================================================

/**
 * Input for creating a new workflow run.
 */
export interface CreateRunInput {
  id?: string;
  kind: string;
  status: ExtendedRunStatus;
  input: Record<string, unknown>;
  context?: Record<string, unknown>; // Optional with default {}
  metadata?: Record<string, unknown>;
  priority?: number;
  timeoutMs?: number;
}

/**
 * Input for updating a workflow run.
 */
export interface UpdateRunInput {
  status?: ExtendedRunStatus;
  context?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  startedAt?: Date;
  finishedAt?: Date;
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
 * Extended options for listing runs.
 */
export interface ExtendedListRunsOptions {
  kind?: string;
  status?: ExtendedRunStatus | ExtendedRunStatus[];
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'startedAt' | 'finishedAt';
  orderDir?: 'asc' | 'desc';
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
  limit?: number;
  offset?: number;
}

// ============================================================================
// WorkflowStorage Interface (New)
// ============================================================================

/**
 * New storage interface for workflow persistence.
 * Implement this interface for new implementations.
 */
export interface WorkflowStorage {
  // Run operations
  createRun(run: CreateRunInput): Promise<ExtendedWorkflowRunRecord>;
  getRun(id: string): Promise<ExtendedWorkflowRunRecord | null>;
  updateRun(id: string, updates: UpdateRunInput): Promise<void>;
  listRuns(options?: ExtendedListRunsOptions): Promise<PaginatedResult<ExtendedWorkflowRunRecord>>;
  deleteRun(id: string): Promise<void>;

  // Atomic dequeue for concurrency control
  dequeueRun(workflowKinds: string[]): Promise<ExtendedWorkflowRunRecord | null>;

  // Stale workflow cleanup
  cleanupStaleRuns(defaultTimeoutMs?: number): Promise<number>;
  markRunsAsFailed(runIds: string[], reason: string): Promise<void>;

  // Step operations
  getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
  getStepResults(runId: string): Promise<StepResult[]>;
  getStepsForRun(runId: string): Promise<StepRecord[]>;
  saveStepResult(result: Omit<StepResult, 'id'> & { id?: string }): Promise<void>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}

// ============================================================================
// Legacy Storage Adapter Interface
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

// ============================================================================
// Database Schema Types (Kysely)
// ============================================================================

/**
 * Database table schema for workflow runs.
 */
export interface StepflowRunsTable {
  id: Generated<string>;
  kind: string;
  status: ExtendedRunStatus;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  metadata: Record<string, unknown> | null;
  priority: number;
  timeout_ms: number | null;
  created_at: Generated<Date>;
  started_at: Date | null;
  finished_at: Date | null;
}

/**
 * Database table schema for step results.
 */
export interface StepflowStepResultsTable {
  id: Generated<string>;
  run_id: string;
  step_name: string;
  status: ExtendedStepStatus;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  attempt: number;
  started_at: Date | null;
  completed_at: Date | null;
}

/**
 * Combined database schema for Stepflow.
 */
export interface StepflowDatabase {
  'stepflow.runs': StepflowRunsTable;
  'stepflow.step_results': StepflowStepResultsTable;
}
