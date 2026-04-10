/**
 * Scheduler types for the workflow engine.
 * Defines the type contracts for the cron and workflow-completion trigger
 * scheduler, implemented by {@link CronScheduler}, {@link SQLiteSchedulePersistence},
 * and {@link PostgresSchedulePersistence}.
 */

import type { WorkflowKind, RunStatus } from "../core/types";

/**
 * Schedule trigger types.
 */
export type TriggerType = "cron" | "workflow_completed" | "manual";

/**
 * Schedule definition.
 */
export interface WorkflowSchedule {
  id: string;
  workflowKind: WorkflowKind;
  triggerType: TriggerType;

  /** Cron expression for time-based triggers (e.g. `0 0 * * *` for daily). Only used when triggerType is 'cron'. */
  cronExpression?: string;
  /** IANA timezone for cron evaluation (e.g. 'America/New_York'). Defaults to 'UTC'. */
  timezone?: string;

  /** Workflow kind that triggers this schedule on completion. Only used when triggerType is 'workflow_completed'. */
  triggerOnWorkflowKind?: WorkflowKind;
  /** Run statuses that activate the completion trigger. If empty, any terminal status triggers. */
  triggerOnStatus?: RunStatus[];

  /** Input payload passed to the spawned workflow run. */
  input?: Record<string, unknown>;
  /** Arbitrary metadata attached to the spawned workflow run. */
  metadata?: Record<string, unknown>;

  /** Whether this schedule is active. Disabled schedules are not evaluated. */
  enabled: boolean;
  /** Timestamp of the most recent run spawned by this schedule. */
  lastRunAt?: Date;
  /** Run ID of the most recent run spawned by this schedule. */
  lastRunId?: string;
  /** Next scheduled execution time, computed from the cron expression and timezone. */
  nextRunAt?: Date;
}

/**
 * Scheduler interface.
 * Implement this to create custom schedulers.
 */
export interface Scheduler {
  /** Start the scheduler */
  start(): Promise<void>;

  /** Stop the scheduler */
  stop(): Promise<void>;

  /** Add a schedule */
  addSchedule(
    schedule: Omit<WorkflowSchedule, "id">,
  ): Promise<WorkflowSchedule>;

  /** Remove a schedule */
  removeSchedule(scheduleId: string): Promise<void>;

  /** Update a schedule */
  updateSchedule(
    scheduleId: string,
    updates: Partial<WorkflowSchedule>,
  ): Promise<void>;

  /** Get all schedules */
  getSchedules(): Promise<WorkflowSchedule[]>;

  /** Manually trigger a scheduled workflow */
  triggerNow(scheduleId: string): Promise<string>;
}
