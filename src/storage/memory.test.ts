import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageAdapter } from './memory';
import type { WorkflowRunRecord, WorkflowRunStepRecord } from './types';

describe('MemoryStorageAdapter', () => {
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
  });

  describe('createRun / getRun', () => {
    it('should create and retrieve a run', async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'queued',
        input: { x: 1 },
        metadata: { userId: 'u1' },
        context: {},
      });

      expect(run.id).toBeDefined();
      expect(run.kind).toBe('test.workflow');
      expect(run.createdAt).toBeInstanceOf(Date);

      const fetched = await storage.getRun(run.id);
      expect(fetched).toEqual(run);
    });

    it('should return null for non-existent run', async () => {
      const run = await storage.getRun('nonexistent');
      expect(run).toBeNull();
    });
  });

  describe('updateRun', () => {
    it('should update run fields', async () => {
      const run = await storage.createRun({
        kind: 'test',
        status: 'queued',
        input: {},
        metadata: {},
        context: {},
      });

      await storage.updateRun(run.id, {
        status: 'running',
        startedAt: new Date(),
      });

      const updated = await storage.getRun(run.id);
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeInstanceOf(Date);
    });

    it('should do nothing for non-existent run', async () => {
      await expect(
        storage.updateRun('nonexistent', { status: 'failed' })
      ).resolves.not.toThrow();
    });
  });

  describe('listRuns', () => {
    beforeEach(async () => {
      await storage.createRun({ kind: 'a', status: 'queued', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'a', status: 'running', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'b', status: 'succeeded', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'a', status: 'failed', input: {}, metadata: {}, context: {}, parentRunId: 'parent-1' });
    });

    it('should list all runs with default pagination', async () => {
      const result = await storage.listRuns();
      expect(result.items).toHaveLength(4);
      expect(result.total).toBe(4);
    });

    it('should filter by kind', async () => {
      const result = await storage.listRuns({ kind: 'a' });
      expect(result.items).toHaveLength(3);
      expect(result.items.every(r => r.kind === 'a')).toBe(true);
    });

    it('should filter by single status', async () => {
      const result = await storage.listRuns({ status: 'queued' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe('queued');
    });

    it('should filter by multiple statuses', async () => {
      const result = await storage.listRuns({ status: ['queued', 'running'] });
      expect(result.items).toHaveLength(2);
    });

    it('should filter by parentRunId', async () => {
      const result = await storage.listRuns({ parentRunId: 'parent-1' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].parentRunId).toBe('parent-1');
    });

    it('should apply limit and offset', async () => {
      const result = await storage.listRuns({ limit: 2, offset: 1 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(4);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(1);
    });

    it('should sort by createdAt ascending', async () => {
      const result = await storage.listRuns({ orderBy: 'createdAt', orderDirection: 'asc' });
      const times = result.items.map(r => r.createdAt.getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
    });
  });

  describe('createStep / getStep / updateStep', () => {
    it('should create and retrieve a step', async () => {
      const step = await storage.createStep({
        runId: 'run-1',
        stepKey: 'step1',
        stepName: 'Step 1',
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
      });

      expect(step.id).toBeDefined();
      expect(step.stepKey).toBe('step1');

      const fetched = await storage.getStep(step.id);
      expect(fetched).toEqual(step);
    });

    it('should return null for non-existent step', async () => {
      const step = await storage.getStep('nonexistent');
      expect(step).toBeNull();
    });

    it('should update step fields', async () => {
      const step = await storage.createStep({
        runId: 'run-1',
        stepKey: 'step1',
        stepName: 'Step 1',
        status: 'running',
        attempt: 1,
      });

      await storage.updateStep(step.id, {
        status: 'succeeded',
        result: { output: 'done' },
        finishedAt: new Date(),
      });

      const updated = await storage.getStep(step.id);
      expect(updated?.status).toBe('succeeded');
      expect(updated?.result).toEqual({ output: 'done' });
    });

    it('should do nothing when updating non-existent step', async () => {
      await expect(
        storage.updateStep('nonexistent', { status: 'failed' })
      ).resolves.not.toThrow();
    });
  });

  describe('getStepsForRun', () => {
    it('should return steps for a specific run sorted by startedAt', async () => {
      const now = Date.now();
      await storage.createStep({
        runId: 'run-1',
        stepKey: 'b',
        stepName: 'B',
        status: 'succeeded',
        attempt: 1,
        startedAt: new Date(now + 100),
      });
      await storage.createStep({
        runId: 'run-1',
        stepKey: 'a',
        stepName: 'A',
        status: 'succeeded',
        attempt: 1,
        startedAt: new Date(now),
      });
      await storage.createStep({
        runId: 'run-2',
        stepKey: 'c',
        stepName: 'C',
        status: 'running',
        attempt: 1,
      });

      const steps = await storage.getStepsForRun('run-1');
      expect(steps).toHaveLength(2);
      expect(steps[0].stepKey).toBe('a');
      expect(steps[1].stepKey).toBe('b');
    });
  });

  describe('saveEvent / getEventsForRun', () => {
    it('should save and retrieve events', async () => {
      await storage.saveEvent({
        runId: 'run-1',
        eventType: 'step.started',
        level: 'info',
        timestamp: new Date(),
      });
      await storage.saveEvent({
        runId: 'run-1',
        stepKey: 'step1',
        eventType: 'step.completed',
        level: 'info',
        timestamp: new Date(),
      });
      await storage.saveEvent({
        runId: 'run-2',
        eventType: 'run.started',
        level: 'info',
        timestamp: new Date(),
      });

      const events = await storage.getEventsForRun('run-1');
      expect(events).toHaveLength(2);
    });

    it('should filter events by stepKey', async () => {
      await storage.saveEvent({
        runId: 'run-1',
        eventType: 'run.started',
        level: 'info',
        timestamp: new Date(),
      });
      await storage.saveEvent({
        runId: 'run-1',
        stepKey: 'step1',
        eventType: 'step.started',
        level: 'info',
        timestamp: new Date(),
      });

      const events = await storage.getEventsForRun('run-1', { stepKey: 'step1' });
      expect(events).toHaveLength(1);
      expect(events[0].stepKey).toBe('step1');
    });

    it('should filter events by level', async () => {
      await storage.saveEvent({
        runId: 'run-1',
        eventType: 'info-event',
        level: 'info',
        timestamp: new Date(),
      });
      await storage.saveEvent({
        runId: 'run-1',
        eventType: 'error-event',
        level: 'error',
        timestamp: new Date(),
      });

      const events = await storage.getEventsForRun('run-1', { level: 'error' });
      expect(events).toHaveLength(1);
      expect(events[0].level).toBe('error');
    });

    it('should paginate events', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.saveEvent({
          runId: 'run-1',
          eventType: `event-${i}`,
          level: 'info',
          timestamp: new Date(Date.now() + i),
        });
      }

      const events = await storage.getEventsForRun('run-1', { limit: 2, offset: 1 });
      expect(events).toHaveLength(2);
    });
  });

  describe('deleteOldRuns', () => {
    it('should delete runs older than the cutoff date', async () => {
      const oldDate = new Date('2020-01-01');
      const newDate = new Date('2025-01-01');

      // Create an old run with steps and events
      const oldRun = await storage.createRun({
        kind: 'test',
        status: 'succeeded',
        input: {},
        metadata: {},
        context: {},
      });
      // Manually set createdAt to old date
      (await storage.getRun(oldRun.id))!.createdAt = oldDate;

      await storage.createStep({
        runId: oldRun.id,
        stepKey: 's1',
        stepName: 'S1',
        status: 'succeeded',
        attempt: 1,
      });
      await storage.saveEvent({
        runId: oldRun.id,
        eventType: 'run.completed',
        level: 'info',
        timestamp: new Date(),
      });

      // Create a recent run
      const newRun = await storage.createRun({
        kind: 'test',
        status: 'succeeded',
        input: {},
        metadata: {},
        context: {},
      });

      const deleted = await storage.deleteOldRuns(new Date('2024-01-01'));

      expect(deleted).toBe(1);
      expect(await storage.getRun(oldRun.id)).toBeNull();
      expect(await storage.getRun(newRun.id)).not.toBeNull();

      // Steps and events should also be cleaned up
      const steps = await storage.getStepsForRun(oldRun.id);
      expect(steps).toHaveLength(0);
      const events = await storage.getEventsForRun(oldRun.id);
      expect(events).toHaveLength(0);
    });
  });

  describe('clear / getStats', () => {
    it('should clear all data', async () => {
      await storage.createRun({ kind: 'a', status: 'queued', input: {}, metadata: {}, context: {} });
      await storage.createStep({ runId: 'r', stepKey: 's', stepName: 'S', status: 'running', attempt: 1 });
      await storage.saveEvent({ runId: 'r', eventType: 'e', level: 'info', timestamp: new Date() });

      expect(storage.getStats().runs).toBe(1);
      expect(storage.getStats().steps).toBe(1);
      expect(storage.getStats().events).toBe(1);

      storage.clear();

      expect(storage.getStats()).toEqual({ runs: 0, steps: 0, events: 0 });
    });
  });
});
