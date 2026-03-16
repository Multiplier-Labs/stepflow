import { R as RunStatus, W as WorkflowKind, S as StepStatus, a as WorkflowError } from './types-CYTuMmf-.js';

/**
 * Storage interface types for the workflow engine.
 * Implement StorageAdapter to use your preferred database.
 */

/**
 * Extended status of a workflow run.
 * Adds 'pending' and 'timeout' to the core statuses.
 */
type ExtendedRunStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout';
/**
 * Extended status of a workflow step.
 * Uses 'completed' instead of 'succeeded' for consistency.
 */
type ExtendedStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
/**
 * Stored representation of a workflow run.
 */
interface WorkflowRunRecord {
    id: string;
    kind: string;
    status: RunStatus;
    parentRunId?: string;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
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
interface WorkflowRunStepRecord {
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
interface WorkflowEventRecord {
    id: string;
    runId: string;
    stepKey?: string;
    eventType: string;
    level: 'info' | 'warn' | 'error';
    payload?: unknown;
    timestamp: Date;
}
/**
 * Extended workflow run record with additional fields.
 * Used by new WorkflowStorage implementations.
 */
interface ExtendedWorkflowRunRecord {
    id: string;
    kind: string;
    status: ExtendedRunStatus;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
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
interface StepResult {
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
interface StepRecord {
    stepKey: string;
    stepName: string;
    status: ExtendedStepStatus;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    attempt: number;
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Input for creating a new workflow run.
 */
interface CreateRunInput {
    id?: string;
    kind: string;
    status: ExtendedRunStatus;
    parentRunId?: string;
    input: Record<string, unknown>;
    context?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    priority?: number;
    timeoutMs?: number;
}
/**
 * Input for updating a workflow run.
 */
interface UpdateRunInput {
    status?: ExtendedRunStatus;
    context?: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
    startedAt?: Date;
    finishedAt?: Date;
}
/**
 * Options for listing runs.
 */
interface ListRunsOptions {
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
interface ExtendedListRunsOptions {
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
interface ListEventsOptions {
    stepKey?: string;
    level?: 'info' | 'warn' | 'error';
    limit?: number;
    offset?: number;
}
/**
 * Paginated result wrapper.
 */
interface PaginatedResult<T> {
    items: T[];
    total: number;
    limit?: number;
    offset?: number;
}
/**
 * New storage interface for workflow persistence.
 * Implement this interface for new implementations.
 */
interface WorkflowStorage {
    createRun(run: CreateRunInput): Promise<ExtendedWorkflowRunRecord>;
    getRun(id: string): Promise<ExtendedWorkflowRunRecord | null>;
    updateRun(id: string, updates: UpdateRunInput): Promise<void>;
    listRuns(options?: ExtendedListRunsOptions): Promise<PaginatedResult<ExtendedWorkflowRunRecord>>;
    deleteRun(id: string): Promise<void>;
    dequeueRun(workflowKinds: string[]): Promise<ExtendedWorkflowRunRecord | null>;
    cleanupStaleRuns(defaultTimeoutMs?: number): Promise<number>;
    markRunsAsFailed(runIds: string[], reason: string): Promise<void>;
    getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
    getStepResults(runId: string): Promise<StepResult[]>;
    getStepsForRun(runId: string): Promise<StepRecord[]>;
    saveStepResult(result: Omit<StepResult, 'id'> & {
        id?: string;
    }): Promise<void>;
    initialize(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Abstract storage adapter interface.
 * Implement this interface to use your preferred database.
 */
interface StorageAdapter {
    createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
    getRun(runId: string): Promise<WorkflowRunRecord | null>;
    updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void>;
    listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
    createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
    getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
    updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
    getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;
    saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
    getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;
    transaction?<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
    deleteOldRuns?(olderThan: Date): Promise<number>;
    initialize?(): Promise<void>;
    close?(): void | Promise<void>;
}
/**
 * Database table schema for workflow runs.
 * Note: When used with Kysely, wrap auto-generated fields with Generated<T>.
 */
interface StepflowRunsTable {
    id: string;
    kind: string;
    status: ExtendedRunStatus;
    input: Record<string, unknown>;
    context: Record<string, unknown>;
    output: Record<string, unknown> | null;
    error: {
        code: string;
        message: string;
    } | null;
    metadata: Record<string, unknown> | null;
    priority: number;
    timeout_ms: number | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}
/**
 * Database table schema for step results.
 * Note: When used with Kysely, wrap auto-generated fields with Generated<T>.
 */
interface StepflowStepResultsTable {
    id: string;
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
interface StepflowDatabase {
    'stepflow.runs': StepflowRunsTable;
    'stepflow.step_results': StepflowStepResultsTable;
}

export type { CreateRunInput as C, ExtendedListRunsOptions as E, ListEventsOptions as L, PaginatedResult as P, StepRecord as S, UpdateRunInput as U, WorkflowEventRecord as W, ExtendedRunStatus as a, ExtendedStepStatus as b, ExtendedWorkflowRunRecord as c, ListRunsOptions as d, StepResult as e, StepflowDatabase as f, StepflowRunsTable as g, StepflowStepResultsTable as h, StorageAdapter as i, WorkflowRunRecord as j, WorkflowRunStepRecord as k, WorkflowStorage as l };
