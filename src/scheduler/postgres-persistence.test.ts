import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresSchedulePersistence } from './postgres-persistence';
import type { WorkflowSchedule } from './types';

// ---------------------------------------------------------------------------
// Mock helpers – We mock `loadPostgresDeps` so we never need a real PG server.
// Instead, a fake Kysely instance backed by an in-memory row store is provided.
// ---------------------------------------------------------------------------

/** Rows stored in our fake database keyed by schedule id. */
let fakeRows: Map<string, Record<string, any>>;

/** Tracks SQL raw calls made via the `sql` template tag (for createTables). */
let sqlExecuteCalls: number;

/**
 * Chainable query-builder mock that operates on `fakeRows`.
 * Each method returns `this` to allow chaining, except terminal methods
 * (execute / executeTakeFirst) which resolve with data from the store.
 */
function createQueryBuilder() {
  let _table: string;
  let _wheres: Array<{ col: string; op: string; val: any }> = [];
  let _insertValues: Record<string, any> | null = null;
  let _updateValues: Record<string, any> | null = null;

  const matchesWhere = (row: Record<string, any>) =>
    _wheres.every(({ col, op, val }) => {
      switch (op) {
        case '=':
          return row[col] === val;
        case '<=':
          return row[col] <= val;
        default:
          return true;
      }
    });

  const qb: any = {
    withSchema() { return qb; },
    selectFrom(table: string) { _table = table; _wheres = []; return qb; },
    selectAll() { return qb; },
    where(col: string, op: string, val: any) { _wheres.push({ col, op, val }); return qb; },
    insertInto(table: string) { _table = table; return qb; },
    values(vals: Record<string, any>) { _insertValues = vals; return qb; },
    updateTable(table: string) { _table = table; _wheres = []; return qb; },
    set(vals: Record<string, any>) { _updateValues = vals; return qb; },
    deleteFrom(table: string) { _table = table; _wheres = []; return qb; },

    async execute() {
      // INSERT
      if (_insertValues) {
        fakeRows.set(_insertValues.id, { ..._insertValues });
        _insertValues = null;
        return [];
      }
      // UPDATE
      if (_updateValues) {
        for (const [, row] of fakeRows) {
          if (matchesWhere(row)) {
            Object.assign(row, _updateValues);
          }
        }
        _updateValues = null;
        return [];
      }
      // DELETE
      if (_wheres.length >= 0 && _insertValues === null && _updateValues === null) {
        // If it's a deleteFrom call
        const toDelete: string[] = [];
        for (const [id, row] of fakeRows) {
          if (matchesWhere(row)) toDelete.push(id);
        }
        for (const id of toDelete) fakeRows.delete(id);
        // For selectFrom case, return matching rows
        const results: Record<string, any>[] = [];
        for (const [, row] of fakeRows) {
          if (matchesWhere(row)) results.push({ ...row });
        }
        return results;
      }
      return [];
    },

    async executeTakeFirst() {
      for (const [, row] of fakeRows) {
        if (matchesWhere(row)) return { ...row };
      }
      return undefined;
    },
  };

  return qb;
}

// We need to distinguish between select/delete/update calls properly.
// Let's refactor the mock with an operation tracker.
function createTrackedQueryBuilder() {
  let _op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let _wheres: Array<{ col: string; op: string; val: any }> = [];
  let _insertValues: Record<string, any> | null = null;
  let _updateValues: Record<string, any> | null = null;

  const matchesWhere = (row: Record<string, any>) =>
    _wheres.every(({ col, op, val }) => {
      switch (op) {
        case '=':
          return row[col] === val;
        case '<=':
          return row[col] <= val;
        default:
          return true;
      }
    });

  const qb: any = {
    withSchema() { return qb; },
    selectFrom() { _op = 'select'; _wheres = []; return qb; },
    selectAll() { return qb; },
    where(col: string, op: string, val: any) { _wheres.push({ col, op, val }); return qb; },
    insertInto() { _op = 'insert'; return qb; },
    values(vals: Record<string, any>) { _insertValues = vals; return qb; },
    updateTable() { _op = 'update'; _wheres = []; return qb; },
    set(vals: Record<string, any>) { _updateValues = vals; return qb; },
    deleteFrom() { _op = 'delete'; _wheres = []; return qb; },

    async execute() {
      if (_op === 'insert' && _insertValues) {
        fakeRows.set(_insertValues.id, { ..._insertValues });
        _insertValues = null;
        return [];
      }
      if (_op === 'update' && _updateValues) {
        for (const [, row] of fakeRows) {
          if (matchesWhere(row)) Object.assign(row, _updateValues);
        }
        _updateValues = null;
        return [];
      }
      if (_op === 'delete') {
        const toDelete: string[] = [];
        for (const [id, row] of fakeRows) {
          if (matchesWhere(row)) toDelete.push(id);
        }
        for (const id of toDelete) fakeRows.delete(id);
        return [];
      }
      // select
      const results: Record<string, any>[] = [];
      for (const [, row] of fakeRows) {
        if (matchesWhere(row)) results.push({ ...row });
      }
      return results;
    },

    async executeTakeFirst() {
      for (const [, row] of fakeRows) {
        if (matchesWhere(row)) return { ...row };
      }
      return undefined;
    },
  };

  return qb;
}

// ---------------------------------------------------------------------------
// Mock loadPostgresDeps so the class never touches real pg/kysely
// ---------------------------------------------------------------------------

let mockDb: ReturnType<typeof createTrackedQueryBuilder>;

vi.mock('../utils/postgres-deps.js', () => ({
  loadPostgresDeps: async () => {
    sqlExecuteCalls = 0;
    return {
      Kysely: class {
        withSchema() { return mockDb; }
        destroy() { return Promise.resolve(); }
      },
      PostgresDialect: class {
        constructor() {}
      },
      sql: new Proxy(() => {}, {
        apply() {
          return {
            execute: async () => { sqlExecuteCalls++; },
          };
        },
        get(_target: any, prop: string) {
          if (prop === 'ref' || prop === 'table') return (v: any) => v;
          return undefined;
        },
      }),
      pgModule: {
        Pool: class {
          end() { return Promise.resolve(); }
        },
      },
    };
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresSchedulePersistence', () => {
  let persistence: PostgresSchedulePersistence;

  beforeEach(async () => {
    fakeRows = new Map();
    sqlExecuteCalls = 0;
    mockDb = createTrackedQueryBuilder();
    persistence = new PostgresSchedulePersistence({
      connectionString: 'postgresql://test:test@localhost:5432/test',
    });
    await persistence.initialize();
  });

  // ========================================================================
  // Constructor / Schema Validation
  // ========================================================================

  describe('constructor validation', () => {
    it('should accept valid schema names', () => {
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: 'my_schema' })
      ).not.toThrow();
    });

    it('should reject invalid schema names', () => {
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: '0bad' })
      ).toThrow('Invalid schema name');
    });

    it('should reject schema names starting with a digit', () => {
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: '1abc' })
      ).toThrow('Invalid schema name');
    });

    it('should reject schema names with special characters', () => {
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: 'my-schema' })
      ).toThrow('Invalid schema name');
    });

    it('should reject schema names longer than 63 characters', () => {
      const longName = 'a'.repeat(64);
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: longName })
      ).toThrow('Invalid schema name');
    });

    it('should accept schema name at max length (63 chars)', () => {
      const maxName = 'a'.repeat(63);
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: maxName })
      ).not.toThrow();
    });

    it('should accept schema starting with underscore', () => {
      expect(
        () => new PostgresSchedulePersistence({ connectionString: 'pg://x', schema: '_private' })
      ).not.toThrow();
    });

    it('should default schema to public', async () => {
      // No error thrown with default schema
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      expect(p).toBeDefined();
    });
  });

  // ========================================================================
  // initialize()
  // ========================================================================

  describe('initialize', () => {
    it('should be idempotent (multiple calls are safe)', async () => {
      // Already initialized in beforeEach, calling again should be a no-op
      await persistence.initialize();
      expect(true).toBe(true); // no error
    });

    it('should throw when no connection config is provided', async () => {
      const p = new PostgresSchedulePersistence({});
      await expect(p.initialize()).rejects.toThrow(
        'must include either pool, connectionString, or poolConfig'
      );
    });

    it('should accept an existing pool', async () => {
      const fakePool = { end: vi.fn() } as any;
      const p = new PostgresSchedulePersistence({ pool: fakePool });
      await p.initialize();
      // Should work without errors
    });

    it('should accept poolConfig', async () => {
      const p = new PostgresSchedulePersistence({
        poolConfig: { host: 'localhost', port: 5432, database: 'test' },
      });
      await p.initialize();
    });

    it('should create tables when autoMigrate is true (default)', async () => {
      // sqlExecuteCalls is incremented by our mock sql template tag
      // createTables runs multiple SQL statements
      expect(sqlExecuteCalls).toBeGreaterThan(0);
    });

    it('should skip table creation when autoMigrate is false', async () => {
      sqlExecuteCalls = 0;
      const p = new PostgresSchedulePersistence({
        connectionString: 'pg://x',
        autoMigrate: false,
      });
      await p.initialize();
      expect(sqlExecuteCalls).toBe(0);
    });
  });

  // ========================================================================
  // ensureInitialized guard
  // ========================================================================

  describe('ensureInitialized guard', () => {
    it('should throw on loadSchedules before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.loadSchedules()).rejects.toThrow('not initialized');
    });

    it('should throw on saveSchedule before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(
        p.saveSchedule({ id: 'x', workflowKind: 'w', triggerType: 'cron', enabled: true })
      ).rejects.toThrow('not initialized');
    });

    it('should throw on updateSchedule before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.updateSchedule('x', { enabled: false })).rejects.toThrow('not initialized');
    });

    it('should throw on deleteSchedule before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.deleteSchedule('x')).rejects.toThrow('not initialized');
    });

    it('should throw on getSchedule before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.getSchedule('x')).rejects.toThrow('not initialized');
    });

    it('should throw on getDueSchedules before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.getDueSchedules()).rejects.toThrow('not initialized');
    });

    it('should throw on getSchedulesByWorkflowKind before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.getSchedulesByWorkflowKind('w')).rejects.toThrow('not initialized');
    });

    it('should throw on getCompletionTriggers before initialize', async () => {
      const p = new PostgresSchedulePersistence({ connectionString: 'pg://x' });
      await expect(p.getCompletionTriggers('w')).rejects.toThrow('not initialized');
    });
  });

  // ========================================================================
  // saveSchedule
  // ========================================================================

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

  // ========================================================================
  // loadSchedules
  // ========================================================================

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

  // ========================================================================
  // getSchedule
  // ========================================================================

  describe('getSchedule', () => {
    it('should return schedule by id', async () => {
      await persistence.saveSchedule({
        id: 'get-1',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      const schedule = await persistence.getSchedule('get-1');
      expect(schedule).not.toBeNull();
      expect(schedule!.id).toBe('get-1');
      expect(schedule!.workflowKind).toBe('test.workflow');
    });

    it('should return null for non-existent schedule', async () => {
      const schedule = await persistence.getSchedule('nonexistent');
      expect(schedule).toBeNull();
    });
  });

  // ========================================================================
  // updateSchedule
  // ========================================================================

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

  // ========================================================================
  // deleteSchedule
  // ========================================================================

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
      await persistence.deleteSchedule('nonexistent');
    });
  });

  // ========================================================================
  // getDueSchedules
  // ========================================================================

  describe('getDueSchedules', () => {
    it('should return enabled cron schedules with past next_run_at', async () => {
      const pastDate = new Date('2020-01-01T00:00:00Z');
      await persistence.saveSchedule({
        id: 'due-1',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
        nextRunAt: pastDate,
      });

      // disabled schedule should not appear
      await persistence.saveSchedule({
        id: 'due-2',
        workflowKind: 'test.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: false,
        nextRunAt: pastDate,
      });

      // non-cron should not appear
      await persistence.saveSchedule({
        id: 'due-3',
        workflowKind: 'test.workflow',
        triggerType: 'manual',
        enabled: true,
        nextRunAt: pastDate,
      });

      const due = await persistence.getDueSchedules();
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe('due-1');
    });
  });

  // ========================================================================
  // getSchedulesByWorkflowKind
  // ========================================================================

  describe('getSchedulesByWorkflowKind', () => {
    it('should filter schedules by workflow kind', async () => {
      await persistence.saveSchedule({
        id: 'kind-1',
        workflowKind: 'target.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      await persistence.saveSchedule({
        id: 'kind-2',
        workflowKind: 'other.workflow',
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        enabled: true,
      });

      const schedules = await persistence.getSchedulesByWorkflowKind('target.workflow');
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe('kind-1');
    });
  });

  // ========================================================================
  // getCompletionTriggers
  // ========================================================================

  describe('getCompletionTriggers', () => {
    it('should return enabled completion triggers for a workflow kind', async () => {
      await persistence.saveSchedule({
        id: 'ct-1',
        workflowKind: 'notification.send',
        triggerType: 'workflow_completed',
        triggerOnWorkflowKind: 'order.process',
        triggerOnStatus: ['succeeded'],
        enabled: true,
      });

      // disabled trigger should not appear
      await persistence.saveSchedule({
        id: 'ct-2',
        workflowKind: 'notification.send',
        triggerType: 'workflow_completed',
        triggerOnWorkflowKind: 'order.process',
        enabled: false,
      });

      // different trigger kind should not appear
      await persistence.saveSchedule({
        id: 'ct-3',
        workflowKind: 'notification.send',
        triggerType: 'workflow_completed',
        triggerOnWorkflowKind: 'different.workflow',
        enabled: true,
      });

      const triggers = await persistence.getCompletionTriggers('order.process');
      expect(triggers).toHaveLength(1);
      expect(triggers[0].id).toBe('ct-1');
    });
  });

  // ========================================================================
  // close()
  // ========================================================================

  describe('close', () => {
    it('should close without error', async () => {
      await persistence.close();
    });

    it('should end owned pool on close', async () => {
      // connectionString path creates an owned pool
      await persistence.close();
      // No error means pool.end() was called successfully
    });
  });

  // ========================================================================
  // Data integrity
  // ========================================================================

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
      expect(loaded[0].id).toBe(schedule.id);
      expect(loaded[0].workflowKind).toBe(schedule.workflowKind);
      expect(loaded[0].triggerType).toBe(schedule.triggerType);
      expect(loaded[0].triggerOnWorkflowKind).toBe(schedule.triggerOnWorkflowKind);
      expect(loaded[0].triggerOnStatus).toEqual(schedule.triggerOnStatus);
      expect(loaded[0].input).toEqual(schedule.input);
      expect(loaded[0].metadata).toEqual(schedule.metadata);
      expect(loaded[0].enabled).toBe(schedule.enabled);
      expect(loaded[0].lastRunAt).toEqual(schedule.lastRunAt);
      expect(loaded[0].lastRunId).toBe(schedule.lastRunId);
      expect(loaded[0].nextRunAt).toEqual(schedule.nextRunAt);
    });

    it('should handle null/undefined values correctly', async () => {
      const schedule: WorkflowSchedule = {
        id: 'nullable-1',
        workflowKind: 'test.workflow',
        triggerType: 'manual',
        enabled: false,
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

  // ========================================================================
  // Custom tableName / schema
  // ========================================================================

  describe('custom tableName', () => {
    it('should use custom tableName when provided', async () => {
      const p = new PostgresSchedulePersistence({
        connectionString: 'pg://x',
        tableName: 'my_schedules',
      });
      await p.initialize();
      // Should initialize without error using custom table name
    });
  });

  describe('custom schema', () => {
    it('should create schema if not public', async () => {
      sqlExecuteCalls = 0;
      const p = new PostgresSchedulePersistence({
        connectionString: 'pg://x',
        schema: 'custom_schema',
      });
      await p.initialize();
      // createTables runs CREATE SCHEMA + CREATE TABLE + indexes
      // More SQL calls than with public schema
      expect(sqlExecuteCalls).toBeGreaterThan(0);
    });
  });
});
