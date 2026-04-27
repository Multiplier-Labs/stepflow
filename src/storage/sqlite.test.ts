import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    it('warns when the callback awaits real async I/O (post-COMMIT work is not transactional)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await storage.transaction(async () => {
          // setTimeout is a macrotask — by the time it fires, COMMIT is long done.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 'late';
        });
        expect(result).toBe('late');
        expect(warnSpy).toHaveBeenCalled();
        const message = warnSpy.mock.calls[0]?.[0] ?? '';
        expect(message).toContain('did not settle synchronously');
        expect(message).toContain('transactionSync');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does not warn when the callback completes synchronously', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await storage.transaction(async () => 1);
        await storage.transaction(async () => {
          await Promise.resolve();
          return 2;
        });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
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

  describe('schema migrations', () => {
    /**
     * The pre-`completed_steps_json` schema. Reproduces the state of a database
     * created by an older version of the adapter, before the column was added.
     * Includes the unchanged sibling tables so prepared statements that touch
     * `workflow_run_steps` / `workflow_events` find them on construction.
     */
    const LEGACY_SCHEMA_SQL = `
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        input_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        error_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE workflow_run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        step_name TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        result_json TEXT,
        error_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE workflow_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_key TEXT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
    `;

    function columnNames(database: Database.Database, table: string): string[] {
      const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    }

    it('adds completed_steps_json to a legacy workflow_runs table on startup', () => {
      // Regression: this is the exact column that broke dev-benchmark when an
      // older deploy's `workflow_runs` survived an upgrade. Renaming the column
      // requires updating this assertion AND `SCHEMA_MIGRATIONS` in sqlite.ts.
      const legacyDb = new Database(':memory:');
      legacyDb.exec(LEGACY_SCHEMA_SQL);
      expect(columnNames(legacyDb, 'workflow_runs')).not.toContain('completed_steps_json');

      const adapter = new SQLiteStorageAdapter({ db: legacyDb });
      try {
        expect(columnNames(legacyDb, 'workflow_runs')).toContain('completed_steps_json');
      } finally {
        adapter.close();
      }
    });

    it('persists completedSteps after migrating a legacy table', async () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(LEGACY_SCHEMA_SQL);

      const adapter = new SQLiteStorageAdapter({ db: legacyDb });
      try {
        const run = await adapter.createRun({
          kind: 'test.workflow',
          status: 'running',
          input: {},
          metadata: {},
          context: {},
          completedSteps: ['step1', 'step2'],
        });

        const retrieved = await adapter.getRun(run.id);
        expect(retrieved!.completedSteps).toEqual(['step1', 'step2']);
      } finally {
        adapter.close();
      }
    });

    it('is a no-op on a fresh database', () => {
      // Pure additive: the second adapter on the same DB must not error or
      // change anything when every column is already present.
      const freshDb = new Database(':memory:');
      const adapter1 = new SQLiteStorageAdapter({ db: freshDb });
      const before = columnNames(freshDb, 'workflow_runs');

      // Simulate a second startup against a fully-migrated DB.
      const adapter2 = new SQLiteStorageAdapter({ db: freshDb });
      const after = columnNames(freshDb, 'workflow_runs');

      try {
        expect(after).toEqual(before);
        expect(after).toContain('completed_steps_json');
      } finally {
        adapter1.close();
        adapter2.close();
      }
    });

    it('still applies migrations when autoCreateTables is false', () => {
      // The prepared statements always reference the latest schema, so we have
      // to reconcile columns even when the caller manages CREATE TABLE.
      const legacyDb = new Database(':memory:');
      legacyDb.exec(LEGACY_SCHEMA_SQL);

      const adapter = new SQLiteStorageAdapter({ db: legacyDb, autoCreateTables: false });
      try {
        expect(columnNames(legacyDb, 'workflow_runs')).toContain('completed_steps_json');
      } finally {
        adapter.close();
      }
    });

    it('is idempotent across multiple instantiations', () => {
      // Migrating a DB twice must not error or duplicate columns — exercises
      // the existence-check skip path for an already-migrated column.
      const legacyDb = new Database(':memory:');
      legacyDb.exec(LEGACY_SCHEMA_SQL);

      // First adapter migrates the legacy table.
      new SQLiteStorageAdapter({ db: legacyDb });
      const after1 = columnNames(legacyDb, 'workflow_runs');
      expect(after1).toContain('completed_steps_json');

      // Second adapter on the same DB must be a no-op.
      const second = new SQLiteStorageAdapter({ db: legacyDb });
      try {
        expect(columnNames(legacyDb, 'workflow_runs')).toEqual(after1);
      } finally {
        second.close();
      }
    });
  });
});
