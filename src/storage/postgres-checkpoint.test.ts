import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStorageAdapter } from './postgres';
import { WorkflowEngine } from '../core/engine';
import { SilentLogger } from '../utils/logger';
import { PostgresSchedulePersistence } from '../scheduler/postgres-persistence';

// CI provides an isolated PostgreSQL service. Local runs opt in with this URL.
describe.skipIf(!process.env.STEPFLOW_TEST_DATABASE_URL)('PostgreSQL checkpoint integration', () => {
  const schema = `checkpoint_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let storage: PostgresStorageAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.STEPFLOW_TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // Emulate an existing deployment before completed_steps_json was added.
    await pool.query(`CREATE TABLE "${schema}".runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      parent_run_id TEXT, input_json JSONB NOT NULL DEFAULT '{}',
      metadata_json JSONB NOT NULL DEFAULT '{}', context_json JSONB NOT NULL DEFAULT '{}',
      output_json JSONB, error_json JSONB, priority INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
    )`);
    storage = new PostgresStorageAdapter({ pool, schema });
    await storage.initialize();
  });

  afterAll(async () => {
    await storage?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it('migrates an existing table and round-trips checkpoints on create/update/list', async () => {
    const run = await storage.createRun({ kind: 'checkpoint', status: 'running', input: {}, context: { charge: 'tx' }, completedSteps: ['charge'] });
    expect(run.completedSteps).toEqual(['charge']);
    expect((await storage.getRun(run.id))?.completedSteps).toEqual(['charge']);
    await storage.updateRun(run.id, { context: { charge: 'tx', receipt: 'sent' }, completedSteps: ['charge', 'receipt'] });
    expect((await storage.listRuns({ kind: 'checkpoint' })).items[0].completedSteps).toEqual(['charge', 'receipt']);
    await storage.updateRun(run.id, { completedSteps: [] });
    expect((await storage.getRun(run.id))?.completedSteps).toEqual([]);
  });

  it('persists checkpoint updates inside transactions and rolls them back atomically', async () => {
    const run = await storage.createRun({ kind: 'transaction', status: 'running', input: {}, completedSteps: [] });
    await expect(storage.transaction(async tx => {
      await tx.updateRun(run.id, { completedSteps: ['charge'], context: { charge: 'tx' } });
      expect((await tx.getRun(run.id))?.completedSteps).toEqual(['charge']);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await storage.getRun(run.id))?.completedSteps).toEqual([]);
    await storage.transaction(async tx => {
      await tx.updateRun(run.id, { completedSteps: ['charge'], context: { charge: 'tx' } });
    });
    expect((await storage.getRun(run.id))?.completedSteps).toEqual(['charge']);
  });

  it('resumes from a persisted checkpoint without repeating completed side effects', async () => {
    const run = await storage.createRun({ kind: 'resume', status: 'running', input: {}, completedSteps: ['charge'], context: { charge: 'tx' } });
    const charge = vi.fn(async () => 'duplicate');
    const engine = new WorkflowEngine({ storage, logger: new SilentLogger() });
    engine.registerWorkflow({ kind: 'resume', name: 'Resume', steps: [
      { key: 'charge', name: 'Charge', handler: charge },
      { key: 'receipt', name: 'Receipt', handler: async ctx => ctx.results.charge },
    ] });
    try {
      await engine.resumeRun(run.id);
      const result = await engine.waitForRun(run.id);
      expect(result.status).toBe('succeeded');
      expect(result.context.receipt).toBe('tx');
      expect(result.completedSteps).toEqual(['charge', 'receipt']);
      expect(charge).not.toHaveBeenCalled();
    } finally {
      await engine.shutdown();
    }
  });

  it('leaves a borrowed pool usable and closes owned pools only once', async () => {
    const borrowed = new PostgresSchedulePersistence({ pool, schema });
    await borrowed.initialize();
    await borrowed.close();
    expect((await pool.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);

    for (const Adapter of [PostgresStorageAdapter, PostgresSchedulePersistence]) {
      const owned = new Adapter({ connectionString: process.env.STEPFLOW_TEST_DATABASE_URL, schema });
      await owned.initialize();
      await owned.close();
      await owned.close();
    }
  });
});
