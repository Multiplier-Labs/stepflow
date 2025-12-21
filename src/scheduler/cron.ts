/**
 * CronScheduler - Scheduler implementation using cron expressions.
 *
 * Provides time-based and workflow-completion-based triggers for workflows.
 */

import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import type { WorkflowKind, RunStatus, Logger } from '../core/types';
import type { WorkflowEngine } from '../core/engine';
import type { Scheduler, WorkflowSchedule, TriggerType } from './types';
import type { WorkflowEvent } from '../events/types';
import { generateId } from '../utils/id';
import { ConsoleLogger } from '../utils/logger';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the CronScheduler.
 */
export interface CronSchedulerConfig {
  /** The workflow engine instance */
  engine: WorkflowEngine;

  /** Logger instance */
  logger?: Logger;

  /** Poll interval for checking schedules (ms, default: 1000) */
  pollInterval?: number;

  /** Optional persistence adapter for schedules */
  persistence?: SchedulePersistence;
}

/**
 * Interface for schedule persistence.
 * Implement this to persist schedules to a database.
 */
export interface SchedulePersistence {
  /** Load all schedules from storage */
  loadSchedules(): Promise<WorkflowSchedule[]>;

  /** Save a schedule */
  saveSchedule(schedule: WorkflowSchedule): Promise<void>;

  /** Update a schedule */
  updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;

  /** Delete a schedule */
  deleteSchedule(scheduleId: string): Promise<void>;
}

// ============================================================================
// CronScheduler Class
// ============================================================================

/**
 * Scheduler implementation that supports cron expressions and workflow completion triggers.
 *
 * @example
 * ```typescript
 * const scheduler = new CronScheduler({
 *   engine,
 *   pollInterval: 1000,
 * });
 *
 * // Add a cron schedule (every day at midnight)
 * await scheduler.addSchedule({
 *   workflowKind: 'cleanup.daily',
 *   triggerType: 'cron',
 *   cronExpression: '0 0 * * *',
 *   enabled: true,
 * });
 *
 * // Add a workflow completion trigger
 * await scheduler.addSchedule({
 *   workflowKind: 'notification.send',
 *   triggerType: 'workflow_completed',
 *   triggerOnWorkflowKind: 'order.process',
 *   triggerOnStatus: ['succeeded'],
 *   enabled: true,
 * });
 *
 * await scheduler.start();
 * ```
 */
export class CronScheduler implements Scheduler {
  private engine: WorkflowEngine;
  private logger: Logger;
  private pollInterval: number;
  private persistence?: SchedulePersistence;

  private schedules = new Map<string, WorkflowSchedule>();
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private eventUnsubscribe: (() => void) | null = null;

  constructor(config: CronSchedulerConfig) {
    this.engine = config.engine;
    this.logger = config.logger ?? new ConsoleLogger();
    this.pollInterval = config.pollInterval ?? 1000;
    this.persistence = config.persistence;
  }

  // ============================================================================
  // Scheduler Interface Implementation
  // ============================================================================

  /**
   * Start the scheduler.
   * Begins polling for cron schedules and subscribes to workflow completion events.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Scheduler is already running');
      return;
    }

    this.logger.info('Starting scheduler...');

    // Load schedules from persistence if available
    if (this.persistence) {
      const loaded = await this.persistence.loadSchedules();
      for (const schedule of loaded) {
        this.schedules.set(schedule.id, schedule);
      }
      this.logger.info(`Loaded ${loaded.length} schedules from persistence`);
    }

    // Calculate next run times for cron schedules
    for (const schedule of this.schedules.values()) {
      if (schedule.triggerType === 'cron' && schedule.cronExpression) {
        this.updateNextRunTime(schedule);
      }
    }

    // Start polling for cron schedules
    this.pollTimer = setInterval(() => this.checkSchedules(), this.pollInterval);

    // Subscribe to workflow completion events
    this.eventUnsubscribe = this.engine.subscribeToAll((event) => {
      this.handleWorkflowEvent(event);
    });

    this.running = true;
    this.logger.info('Scheduler started');
  }

  /**
   * Stop the scheduler.
   * Stops polling and unsubscribes from events.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping scheduler...');

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }

    this.running = false;
    this.logger.info('Scheduler stopped');
  }

  /**
   * Add a new schedule.
   */
  async addSchedule(scheduleData: Omit<WorkflowSchedule, 'id'>): Promise<WorkflowSchedule> {
    const schedule: WorkflowSchedule = {
      ...scheduleData,
      id: generateId(),
    };

    // Validate cron expression if provided
    if (schedule.triggerType === 'cron' && schedule.cronExpression) {
      try {
        parseExpression(schedule.cronExpression, {
          tz: schedule.timezone,
        });
      } catch (error) {
        throw new Error(`Invalid cron expression: ${schedule.cronExpression}`);
      }

      // Calculate next run time
      this.updateNextRunTime(schedule);
    }

    // Validate workflow completion trigger
    if (schedule.triggerType === 'workflow_completed') {
      if (!schedule.triggerOnWorkflowKind) {
        throw new Error('triggerOnWorkflowKind is required for workflow_completed triggers');
      }
    }

    this.schedules.set(schedule.id, schedule);

    // Persist if available
    if (this.persistence) {
      await this.persistence.saveSchedule(schedule);
    }

    this.logger.info(`Added schedule: ${schedule.id} (${schedule.workflowKind})`);

    return schedule;
  }

  /**
   * Remove a schedule.
   */
  async removeSchedule(scheduleId: string): Promise<void> {
    if (!this.schedules.has(scheduleId)) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    this.schedules.delete(scheduleId);

    if (this.persistence) {
      await this.persistence.deleteSchedule(scheduleId);
    }

    this.logger.info(`Removed schedule: ${scheduleId}`);
  }

  /**
   * Update a schedule.
   */
  async updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    // Don't allow changing the ID
    delete updates.id;

    // Update the schedule
    Object.assign(schedule, updates);

    // Revalidate and update next run time if cron expression changed
    if (updates.cronExpression !== undefined || updates.timezone !== undefined) {
      if (schedule.cronExpression) {
        try {
          parseExpression(schedule.cronExpression, {
            tz: schedule.timezone,
          });
          this.updateNextRunTime(schedule);
        } catch (error) {
          throw new Error(`Invalid cron expression: ${schedule.cronExpression}`);
        }
      }
    }

    if (this.persistence) {
      await this.persistence.updateSchedule(scheduleId, updates);
    }

    this.logger.debug(`Updated schedule: ${scheduleId}`);
  }

  /**
   * Get all schedules.
   */
  async getSchedules(): Promise<WorkflowSchedule[]> {
    return Array.from(this.schedules.values());
  }

  /**
   * Get a schedule by ID.
   */
  getSchedule(scheduleId: string): WorkflowSchedule | undefined {
    return this.schedules.get(scheduleId);
  }

  /**
   * Manually trigger a scheduled workflow.
   */
  async triggerNow(scheduleId: string): Promise<string> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    return this.executeSchedule(schedule);
  }

  // ============================================================================
  // Internal Methods
  // ============================================================================

  /**
   * Check all cron schedules and execute those that are due.
   */
  private checkSchedules(): void {
    const now = new Date();

    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (schedule.triggerType !== 'cron') continue;
      if (!schedule.nextRunAt) continue;

      if (schedule.nextRunAt <= now) {
        // Execute the schedule
        this.executeSchedule(schedule).catch((error) => {
          this.logger.error(`Failed to execute schedule ${schedule.id}:`, error);
        });

        // Update next run time
        this.updateNextRunTime(schedule);
      }
    }
  }

  /**
   * Handle workflow events for completion triggers.
   */
  private handleWorkflowEvent(event: WorkflowEvent): void {
    // Only handle run completion events
    // Note: orchestrator emits 'run.completed' for success, 'run.failed' for failure
    if (event.eventType !== 'run.completed' && event.eventType !== 'run.failed') {
      return;
    }

    const completedStatus: RunStatus = event.eventType === 'run.completed' ? 'succeeded' : 'failed';
    const completedKind = event.kind;

    // Find schedules triggered by this workflow completion
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (schedule.triggerType !== 'workflow_completed') continue;
      if (schedule.triggerOnWorkflowKind !== completedKind) continue;

      // Check if the status matches
      if (schedule.triggerOnStatus && !schedule.triggerOnStatus.includes(completedStatus)) {
        continue;
      }

      // Execute the schedule
      this.executeSchedule(schedule, {
        triggerRunId: event.runId,
        triggerStatus: completedStatus,
      }).catch((error) => {
        this.logger.error(`Failed to execute schedule ${schedule.id}:`, error);
      });
    }
  }

  /**
   * Execute a schedule by starting the workflow.
   */
  private async executeSchedule(
    schedule: WorkflowSchedule,
    triggerContext?: { triggerRunId?: string; triggerStatus?: RunStatus }
  ): Promise<string> {
    this.logger.info(`Executing schedule: ${schedule.id} (${schedule.workflowKind})`);

    // Build metadata with trigger info
    const metadata = {
      ...schedule.metadata,
      scheduleId: schedule.id,
      triggerType: schedule.triggerType,
      ...(triggerContext ?? {}),
    };

    // Start the workflow
    const runId = await this.engine.startRun({
      kind: schedule.workflowKind,
      input: schedule.input,
      metadata,
    });

    // Update schedule state
    schedule.lastRunAt = new Date();
    schedule.lastRunId = runId;

    if (this.persistence) {
      await this.persistence.updateSchedule(schedule.id, {
        lastRunAt: schedule.lastRunAt,
        lastRunId: schedule.lastRunId,
        nextRunAt: schedule.nextRunAt,
      });
    }

    return runId;
  }

  /**
   * Update the next run time for a cron schedule.
   */
  private updateNextRunTime(schedule: WorkflowSchedule): void {
    if (!schedule.cronExpression) return;

    try {
      const interval = parseExpression(schedule.cronExpression, {
        currentDate: new Date(),
        tz: schedule.timezone,
      });

      schedule.nextRunAt = interval.next().toDate();
    } catch (error) {
      this.logger.error(`Failed to parse cron expression for schedule ${schedule.id}:`, error);
      schedule.nextRunAt = undefined;
    }
  }
}
