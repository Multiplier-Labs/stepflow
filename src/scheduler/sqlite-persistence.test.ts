import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteSchedulePersistence } from './sqlite-persistence';
import type { WorkflowSchedule } from './types';

describe('SQLiteSchedulePersistence', () => {
  let db: Database.Database;
  let persistence: SQLiteSchedulePersistence;

  beforeEach(() => {
    // Use in-memory database for testing
    db = new Database(':memory:');
    persistence = new SQLiteSchedulePersistence({ db });
  });

  afterEach(() => {
    db.close();
  });

  describe('saveSchedule', () => {
    it('should save a cron schedule', async () => {
      const schedule: WorkflowSchedule = {
        id: 'test-1',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        enabled: true,
        input: { foo: 'bar' },
        metadata: { user: 'test' },
      };

      await persistence.saveSchedule(schedule);

      const loaded = await persistence.loadSchedules();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('test-1');
      expect(loaded[0].cronExpression).toBe('0 * * * *');
      expect(loaded[0].input).toEqual({ foo: 'bar' });
    });

    it('should save a workflow completion trigger', async () => {
      const schedule: WorkflowSchedule = {
        id: 'test-2',
        workflowKind: 'notification.send',
        triggerType: 'workflow_completed',
        triggerOnWorkflowKind: 'order.process',
        triggerOnStatus: ['succeeded', 'failed'],
        enabled: true,
      };

      await persistence.saveSchedule(schedule);

      const loaded = await persistence.loadSchedules();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].triggerType).toBe('workflow_completed');
      expect(loaded[0].triggerOnWorkflowKind).toBe('order.process');
      expect(loaded[0].triggerOnStatus).toEqual(['succeeded', 'failed']);
    });

    it('should save schedule with dates', async () => {
      const lastRunAt = new Date('2024-01-01T12:00:00Z');
      const nextRunAt = new Date('2024-01-01T13:00:00Z');

      const schedule: WorkflowSchedule = {
        id: 'test-3',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
        lastRunAt,
        lastRunId: 'run-123',
        nextRunAt,
      };

      await persistence.saveSchedule(schedule);

      const loaded = await persistence.loadSchedules();
      expect(loaded[0].lastRunAt).toEqual(lastRunAt);
      expect(loaded[0].lastRunId).toBe('run-123');
      expect(loaded[0].nextRunAt).toEqual(nextRunAt);
    });
  });

  describe('loadSchedules', () => {
    it('should return empty array when no schedules', async () => {
      const schedules = await persistence.loadSchedules();
      expect(schedules).toHaveLength(0);
    });

    it('should load multiple schedules', async () => {
      await persistence.saveSchedule({
        id: 'schedule-1',
        workflowKind: 'workflow.a',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      await persistence.saveSchedule({
        id: 'schedule-2',
        workflowKind: 'workflow.b',
        triggerType: 'manual',
        enabled: false,
      });

      const schedules = await persistence.loadSchedules();
      expect(schedules).toHaveLength(2);
    });
  });

  describe('updateSchedule', () => {
    it('should update enabled status', async () => {
      await persistence.saveSchedule({
        id: 'update-1',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      await persistence.updateSchedule('update-1', { enabled: false });

      const loaded = await persistence.loadSchedules();
      expect(loaded[0].enabled).toBe(false);
    });

    it('should update cron expression', async () => {
      await persistence.saveSchedule({
        id: 'update-2',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      await persistence.updateSchedule('update-2', {
        cronExpression: '30 * * * *',
      });

      const loaded = await persistence.loadSchedules();
      expect(loaded[0].cronExpression).toBe('30 * * * *');
    });

    it('should update lastRunAt and lastRunId', async () => {
      await persistence.saveSchedule({
        id: 'update-3',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      const now = new Date();
      await persistence.updateSchedule('update-3', {
        lastRunAt: now,
        lastRunId: 'run-456',
      });

      const loaded = await persistence.loadSchedules();
      expect(loaded[0].lastRunAt).toEqual(now);
      expect(loaded[0].lastRunId).toBe('run-456');
    });

    it('should throw for non-existent schedule', async () => {
      await expect(
        persistence.updateSchedule('nonexistent', { enabled: false })
      ).rejects.toThrow('Schedule not found');
    });
  });

  describe('deleteSchedule', () => {
    it('should delete a schedule', async () => {
      await persistence.saveSchedule({
        id: 'delete-1',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      await persistence.deleteSchedule('delete-1');

      const loaded = await persistence.loadSchedules();
      expect(loaded).toHaveLength(0);
    });

    it('should handle deleting non-existent schedule gracefully', async () => {
      // This should not throw
      await persistence.deleteSchedule('nonexistent');
    });
  });

  describe('data integrity', () => {
    it('should preserve all fields through save/load cycle', async () => {
      const schedule: WorkflowSchedule = {
        id: 'integrity-1',
        workflowKind: 'complex.workflow',
        triggerType: 'workflow_completed',
        triggerOnWorkflowKind: 'parent.workflow',
        triggerOnStatus: ['succeeded'],
        input: { nested: { value: 123 } },
        metadata: { tags: ['a', 'b'] },
        enabled: true,
        lastRunAt: new Date('2024-06-15T10:30:00Z'),
        lastRunId: 'run-789',
        nextRunAt: new Date('2024-06-15T11:00:00Z'),
      };

      await persistence.saveSchedule(schedule);

      const loaded = await persistence.loadSchedules();
      expect(loaded[0]).toEqual(schedule);
    });

    it('should handle null/undefined values correctly', async () => {
      const schedule: WorkflowSchedule = {
        id: 'nullable-1',
        workflowKind: 'test.workflow',
        triggerType: 'manual',
        enabled: false,
        // All other optional fields are undefined
      };

      await persistence.saveSchedule(schedule);

      const loaded = await persistence.loadSchedules();
      expect(loaded[0].cronExpression).toBeUndefined();
      expect(loaded[0].timezone).toBeUndefined();
      expect(loaded[0].input).toBeUndefined();
      expect(loaded[0].metadata).toBeUndefined();
      expect(loaded[0].lastRunAt).toBeUndefined();
    });
  });
});
