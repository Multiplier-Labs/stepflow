import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteStorageAdapter } from './sqlite';
import type { WorkflowRunRecord, WorkflowRunStepRecord } from './types';

describe('SQLiteStorageAdapter', () => {
  let db: Database.Database;
  let storage: SQLiteStorageAdapter;

  beforeEach(() => {
    // Use in-memory database for testing
    db = new Database(':memory:');
    storage = new SQLiteStorageAdapter({ db });
  });

  afterEach(() => {
    storage.close();
  });

  describe('createRun', () => {
    it('should create a run and return it with generated id and createdAt', async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'queued',
        input: { foo: 'bar' },
        metadata: { userId: 'user1' },
        context: {},
      });

      expect(run.id).toBeDefined();
      expect(run.kind).toBe('test.workflow');
      expect(run.status).toBe('queued');
      expect(run.input).toEqual({ foo: 'bar' });
      expect(run.metadata).toEqual({ userId: 'user1' });
      expect(run.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('getRun', () => {
    it('should return null for non-existent run', async () => {
      const run = await storage.getRun('nonexistent');
      expect(run).toBeNull();
    });

    it('should retrieve a created run', async () => {
      const created = await storage.createRun({
        kind: 'test.workflow',
        status: 'queued',
        input: { value: 123 },
        metadata: {},
        context: {},
      });

      const retrieved = await storage.getRun(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.input).toEqual({ value: 123 });
    });
  });

  describe('updateRun', () => {
    it('should update run status', async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'queued',
        input: {},
        metadata: {},
        context: {},
      });

      await storage.updateRun(run.id, { status: 'running' });

      const updated = await storage.getRun(run.id);
      expect(updated!.status).toBe('running');
    });

    it('should update run context', async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: { step1: 'result1' },
      });

      await storage.updateRun(run.id, {
        context: { step1: 'result1', step2: 'result2' },
      });

      const updated = await storage.getRun(run.id);
      expect(updated!.context).toEqual({ step1: 'result1', step2: 'result2' });
    });

    it('should update run error', async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });

      await storage.updateRun(run.id, {
        status: 'failed',
        error: { code: 'TEST_ERROR', message: 'Something went wrong' },
      });

      const updated = await storage.getRun(run.id);
      expect(updated!.status).toBe('failed');
      expect(updated!.error).toEqual({ code: 'TEST_ERROR', message: 'Something went wrong' });
    });
  });

  describe('listRuns', () => {
    beforeEach(async () => {
      // Create some test runs
      await storage.createRun({ kind: 'workflow.a', status: 'succeeded', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'workflow.a', status: 'failed', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'workflow.b', status: 'running', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'workflow.b', status: 'queued', input: {}, metadata: {}, context: {} });
    });

    it('should list all runs', async () => {
      const result = await storage.listRuns();
      expect(result.items).toHaveLength(4);
      expect(result.total).toBe(4);
    });

    it('should filter by kind', async () => {
      const result = await storage.listRuns({ kind: 'workflow.a' });
      expect(result.items).toHaveLength(2);
      expect(result.items.every(r => r.kind === 'workflow.a')).toBe(true);
    });

    it('should filter by single status', async () => {
      const result = await storage.listRuns({ status: 'running' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe('running');
    });

    it('should filter by multiple statuses', async () => {
      const result = await storage.listRuns({ status: ['queued', 'running'] });
      expect(result.items).toHaveLength(2);
    });

    it('should support pagination', async () => {
      const page1 = await storage.listRuns({ limit: 2, offset: 0 });
      const page2 = await storage.listRuns({ limit: 2, offset: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
    });
  });

  describe('step operations', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });
      runId = run.id;
    });

    it('should create and retrieve a step', async () => {
      const step = await storage.createStep({
        runId,
        stepKey: 'step1',
        stepName: 'First Step',
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
      });

      expect(step.id).toBeDefined();
      expect(step.stepKey).toBe('step1');

      const retrieved = await storage.getStep(step.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.stepKey).toBe('step1');
    });

    it('should update step status and result', async () => {
      const step = await storage.createStep({
        runId,
        stepKey: 'step1',
        stepName: 'First Step',
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
      });

      await storage.updateStep(step.id, {
        status: 'succeeded',
        result: { data: [1, 2, 3] },
        finishedAt: new Date(),
      });

      const updated = await storage.getStep(step.id);
      expect(updated!.status).toBe('succeeded');
      expect(updated!.result).toEqual({ data: [1, 2, 3] });
    });

    it('should get all steps for a run', async () => {
      await storage.createStep({ runId, stepKey: 'step1', stepName: 'Step 1', status: 'succeeded', attempt: 1, startedAt: new Date() });
      await storage.createStep({ runId, stepKey: 'step2', stepName: 'Step 2', status: 'succeeded', attempt: 1, startedAt: new Date() });
      await storage.createStep({ runId, stepKey: 'step3', stepName: 'Step 3', status: 'running', attempt: 1, startedAt: new Date() });

      const steps = await storage.getStepsForRun(runId);
      expect(steps).toHaveLength(3);
    });
  });

  describe('event operations', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });
      runId = run.id;
    });

    it('should save and retrieve events', async () => {
      await storage.saveEvent({
        runId,
        eventType: 'run.started',
        level: 'info',
        timestamp: new Date(),
      });

      await storage.saveEvent({
        runId,
        stepKey: 'step1',
        eventType: 'step.completed',
        level: 'info',
        payload: { result: 'success' },
        timestamp: new Date(),
      });

      const events = await storage.getEventsForRun(runId);
      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('run.started');
      expect(events[1].eventType).toBe('step.completed');
    });

    it('should filter events by step', async () => {
      await storage.saveEvent({ runId, eventType: 'run.started', level: 'info', timestamp: new Date() });
      await storage.saveEvent({ runId, stepKey: 'step1', eventType: 'step.started', level: 'info', timestamp: new Date() });
      await storage.saveEvent({ runId, stepKey: 'step1', eventType: 'step.completed', level: 'info', timestamp: new Date() });
      await storage.saveEvent({ runId, stepKey: 'step2', eventType: 'step.started', level: 'info', timestamp: new Date() });

      const step1Events = await storage.getEventsForRun(runId, { stepKey: 'step1' });
      expect(step1Events).toHaveLength(2);
    });

    it('should filter events by level', async () => {
      await storage.saveEvent({ runId, eventType: 'run.started', level: 'info', timestamp: new Date() });
      await storage.saveEvent({ runId, eventType: 'step.failed', level: 'error', timestamp: new Date() });
      await storage.saveEvent({ runId, eventType: 'step.retry', level: 'warn', timestamp: new Date() });

      const errorEvents = await storage.getEventsForRun(runId, { level: 'error' });
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].eventType).toBe('step.failed');
    });
  });

  describe('transaction', () => {
    it('should execute operations within a synchronous transaction', () => {
      // Use the synchronous transaction method for better-sqlite3
      const result = storage.transactionSync(() => {
        // Note: We access the underlying sync methods via the statements
        const id = 'test-tx-run';
        storage['stmts']!.insertRun.run(
          id,
          'test.workflow',
          'queued',
          null,
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify({}),
          null,
          null,
          new Date().toISOString(),
          null,
          null
        );
        storage['stmts']!.updateRun.run('running', null, null, null, null, null, id);
        return id;
      });

      expect(result).toBe('test-tx-run');
    });

    it('should rollback on error', async () => {
      const initialStats = storage.getStats();

      try {
        storage.transactionSync(() => {
          storage['stmts']!.insertRun.run(
            'rollback-test',
            'test.workflow',
            'queued',
            null,
            JSON.stringify({}),
            JSON.stringify({}),
            JSON.stringify({}),
            null,
            new Date().toISOString(),
            null,
            null
          );
          throw new Error('Simulated error');
        });
      } catch {
        // Expected
      }

      const finalStats = storage.getStats();
      expect(finalStats.runs).toBe(initialStats.runs);
    });
  });

  describe('deleteOldRuns', () => {
    it('should delete runs older than the specified date', async () => {
      // Create a run
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'succeeded',
        input: {},
        metadata: {},
        context: {},
      });

      // Create a step for the run
      await storage.createStep({
        runId: run.id,
        stepKey: 'step1',
        stepName: 'Step 1',
        status: 'succeeded',
        attempt: 1,
      });

      // Create an event for the run
      await storage.saveEvent({
        runId: run.id,
        eventType: 'run.completed',
        level: 'info',
        timestamp: new Date(),
      });

      // Delete runs older than tomorrow
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const deleted = await storage.deleteOldRuns(tomorrow);

      expect(deleted).toBe(1);

      // Verify run is deleted
      const retrieved = await storage.getRun(run.id);
      expect(retrieved).toBeNull();

      // Verify steps are deleted
      const steps = await storage.getStepsForRun(run.id);
      expect(steps).toHaveLength(0);

      // Verify events are deleted
      const events = await storage.getEventsForRun(run.id);
      expect(events).toHaveLength(0);
    });
  });

  describe('resume support', () => {
    it('should get interrupted runs', async () => {
      await storage.createRun({ kind: 'workflow.a', status: 'succeeded', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'workflow.a', status: 'running', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'workflow.b', status: 'queued', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'workflow.b', status: 'failed', input: {}, metadata: {}, context: {} });

      const interrupted = await storage.getInterruptedRuns();
      expect(interrupted).toHaveLength(2);
      expect(interrupted.every(r => ['queued', 'running'].includes(r.status))).toBe(true);
    });

    it('should get last completed step', async () => {
      const run = await storage.createRun({
        kind: 'test.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });

      const now = new Date();
      await storage.createStep({
        runId: run.id,
        stepKey: 'step1',
        stepName: 'Step 1',
        status: 'succeeded',
        attempt: 1,
        startedAt: now,
        finishedAt: new Date(now.getTime() + 100),
      });

      await storage.createStep({
        runId: run.id,
        stepKey: 'step2',
        stepName: 'Step 2',
        status: 'succeeded',
        attempt: 1,
        startedAt: new Date(now.getTime() + 200),
        finishedAt: new Date(now.getTime() + 300),
      });

      await storage.createStep({
        runId: run.id,
        stepKey: 'step3',
        stepName: 'Step 3',
        status: 'running',
        attempt: 1,
        startedAt: new Date(now.getTime() + 400),
      });

      const lastCompleted = await storage.getLastCompletedStep(run.id);
      expect(lastCompleted).not.toBeNull();
      expect(lastCompleted!.stepKey).toBe('step2');
    });
  });

  describe('deprecated transaction() returns callback result', () => {
    it('should return the callback result for sync operations', async () => {
      const result = await storage.transaction(async () => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it('should return the callback result when awaiting resolved promises', async () => {
      const result = await storage.transaction(async () => {
        await Promise.resolve();
        return 'hello';
      });
      expect(result).toBe('hello');
    });
  });

  describe('getStats', () => {
    it('should return database statistics', async () => {
      await storage.createRun({ kind: 'test', status: 'queued', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'test', status: 'queued', input: {}, metadata: {}, context: {} });

      const stats = storage.getStats();
      expect(stats.runs).toBe(2);
      expect(stats.steps).toBe(0);
      expect(stats.events).toBe(0);
    });
  });
});
