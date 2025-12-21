/**
 * Scheduler types for the workflow engine.
 * Note: The full scheduler implementation is in Phase 3.
 * This file defines the interfaces for future implementation.
 */

import type { WorkflowKind, RunStatus } from '../core/types';

/**
 * Schedule trigger types.
 */
export type TriggerType = 'cron' | 'workflow_completed' | 'manual';

/**
 * Schedule definition.
 */
export interface WorkflowSchedule {
  id: string;
  workflowKind: WorkflowKind;
  triggerType: TriggerType;

  // For cron triggers
  cronExpression?: string;
  timezone?: string;

  // For workflow completion triggers
  triggerOnWorkflowKind?: WorkflowKind;
  triggerOnStatus?: RunStatus[];

  // Input to pass to the workflow
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;

  // State
  enabled: boolean;
  lastRunAt?: Date;
  lastRunId?: string;
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
  addSchedule(schedule: Omit<WorkflowSchedule, 'id'>): Promise<WorkflowSchedule>;

  /** Remove a schedule */
  removeSchedule(scheduleId: string): Promise<void>;

  /** Update a schedule */
  updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;

  /** Get all schedules */
  getSchedules(): Promise<WorkflowSchedule[]>;

  /** Manually trigger a scheduled workflow */
  triggerNow(scheduleId: string): Promise<string>;
}
