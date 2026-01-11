/**
 * PostgreSQL storage adapter using Kysely.
 *
 * Provides durable persistence for workflow runs, steps, and events
 * with support for distributed deployments and connection pooling.
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Pool, PoolConfig } from 'pg';
import { generateId } from '../utils/id.js';
import type {
  StorageAdapter,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  WorkflowEventRecord,
  ListRunsOptions,
  ListEventsOptions,
  PaginatedResult,
} from './types.js';
import type { RunStatus, StepStatus, WorkflowError } from '../core/types.js';

// ============================================================================
// Database Types (Kysely schema)
// ============================================================================

interface WorkflowRunsTable {
  id: string;
  kind: string;
  status: string;
  parent_run_id: string | null;
  input_json: string;
  metadata_json: string;
  context_json: string;
  error_json: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface WorkflowRunStepsTable {
  id: string;
  run_id: string;
  step_key: string;
  step_name: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

interface WorkflowEventsTable {
  id: string;
  run_id: string;
  step_key: string | null;
  event_type: string;
  level: string;
  payload_json: string | null;
  timestamp: Date;
}

interface StepflowDatabase {
  workflow_runs: WorkflowRunsTable;
  workflow_run_steps: WorkflowRunStepsTable;
  workflow_events: WorkflowEventsTable;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration options for the PostgreSQL storage adapter.
 */
export interface PostgresStorageConfig {
  /**
   * PostgreSQL connection string.
   * Example: "postgresql://user:pass@localhost:5432/dbname"
   */
  connectionString?: string;

  /**
   * Existing pg.Pool instance for connection sharing with application.
   * If provided, the adapter will not close this pool on close().
   */
  pool?: Pool;

  /**
   * Pool configuration options (if not providing pool or connectionString).
   */
  poolConfig?: PoolConfig;

  /**
   * Schema name for Stepflow tables.
   * @default 'public'
   */
  schema?: string;

  /**
   * Automatically create tables on initialize().
   * @default true
   */
  autoMigrate?: boolean;
}

// ============================================================================
// PostgreSQL Storage Adapter
// ============================================================================

/**
 * PostgreSQL implementation of StorageAdapter using Kysely.
 *
 * Features:
 * - Connection pooling (shared or dedicated)
 * - Automatic table creation
 * - Transaction support
 * - Atomic dequeue operations for distributed workers
 * - JSONB storage for flexible data
 *
 * @example
 * ```typescript
 * import { PostgresStorageAdapter } from 'stepflow/storage';
 *
 * const storage = new PostgresStorageAdapter({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * await storage.initialize();
 *
 * const engine = new WorkflowEngine({ storage });
 * ```
 *
 * @example Sharing connection pool
 * ```typescript
 * import pg from 'pg';
 * import { PostgresStorageAdapter } from 'stepflow/storage';
 *
 * // Application's existing pool
 * const pool = new pg.Pool({
 *   connectionString: process.env.DATABASE_URL,
 *   max: 20,
 * });
 *
 * // Share with Stepflow
 * const storage = new PostgresStorageAdapter({ pool });
 * ```
 */
export class PostgresStorageAdapter implements StorageAdapter {
  private db: Kysely<StepflowDatabase>;
  private pool: Pool;
  private ownsPool: boolean;
  private schema: string;
  private autoMigrate: boolean;
  private initialized = false;

  constructor(config: PostgresStorageConfig) {
    this.schema = config.schema ?? 'public';
    this.autoMigrate = config.autoMigrate !== false;

    // Dynamically import pg to keep it optional
    let pg: typeof import('pg');
    try {
      pg = require('pg');
    } catch {
      throw new Error(
        'PostgreSQL adapter requires the "pg" package. Install it with: npm install pg'
      );
    }

    if (config.pool) {
      this.pool = config.pool;
      this.ownsPool = false;
    } else if (config.connectionString) {
      this.pool = new pg.Pool({ connectionString: config.connectionString });
      this.ownsPool = true;
    } else if (config.poolConfig) {
      this.pool = new pg.Pool(config.poolConfig);
      this.ownsPool = true;
    } else {
      throw new Error(
        'PostgresStorageConfig must include either pool, connectionString, or poolConfig'
      );
    }

    this.db = new Kysely<StepflowDatabase>({
      dialect: new PostgresDialect({
        pool: this.pool,
      }),
    });
  }

  /**
   * Initialize the storage adapter.
   * Creates tables if autoMigrate is enabled.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.autoMigrate) {
      await this.createTables();
    }

    this.initialized = true;
  }

  /**
   * Close the database connection.
   * Only closes the pool if it was created by this adapter.
   */
  async close(): Promise<void> {
    await this.db.destroy();
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  // ============================================================================
  // Schema Creation
  // ============================================================================

  /**
   * Create the workflow tables if they don't exist.
   */
  private async createTables(): Promise<void> {
    // Create schema if not public
    if (this.schema !== 'public') {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);
    }

    // Create workflow_runs table
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_runs`)} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        input_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        context_json JSONB NOT NULL DEFAULT '{}',
        error_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT workflow_runs_status_check CHECK (
          status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')
        )
      )
    `.execute(this.db);

    // Create indexes for workflow_runs
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_kind_status
      ON ${sql.table(`${this.schema}.workflow_runs`)} (kind, status)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent
      ON ${sql.table(`${this.schema}.workflow_runs`)} (parent_run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_created
      ON ${sql.table(`${this.schema}.workflow_runs`)} (created_at DESC)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
      ON ${sql.table(`${this.schema}.workflow_runs`)} (status)
    `.execute(this.db);

    // Create workflow_run_steps table
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_run_steps`)} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.workflow_runs`)} (id) ON DELETE CASCADE,
        step_key TEXT NOT NULL,
        step_name TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        result_json JSONB,
        error_json JSONB,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT workflow_run_steps_status_check CHECK (
          status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
        )
      )
    `.execute(this.db);

    // Create indexes for workflow_run_steps
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run
      ON ${sql.table(`${this.schema}.workflow_run_steps`)} (run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_key
      ON ${sql.table(`${this.schema}.workflow_run_steps`)} (run_id, step_key)
    `.execute(this.db);

    // Create workflow_events table
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_events`)} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.workflow_runs`)} (id) ON DELETE CASCADE,
        step_key TEXT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json JSONB,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workflow_events_level_check CHECK (
          level IN ('info', 'warn', 'error')
        )
      )
    `.execute(this.db);

    // Create indexes for workflow_events
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run
      ON ${sql.table(`${this.schema}.workflow_events`)} (run_id)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run_ts
      ON ${sql.table(`${this.schema}.workflow_events`)} (run_id, timestamp)
    `.execute(this.db);
  }

  // ============================================================================
  // Run Operations
  // ============================================================================

  async createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord> {
    const id = generateId();
    const createdAt = new Date();

    await this.db
      .insertInto('workflow_runs')
      .values({
        id,
        kind: run.kind,
        status: run.status,
        parent_run_id: run.parentRunId ?? null,
        input_json: JSON.stringify(run.input),
        metadata_json: JSON.stringify(run.metadata),
        context_json: JSON.stringify(run.context),
        error_json: run.error ? JSON.stringify(run.error) : null,
        created_at: createdAt,
        started_at: run.startedAt ?? null,
        finished_at: run.finishedAt ?? null,
      })
      .execute();

    return {
      ...run,
      id,
      createdAt,
    };
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    const row = await this.db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    return row ? this.mapRunRow(row) : null;
  }

  async updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void> {
    const updateData: Partial<WorkflowRunsTable> = {};

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.context !== undefined) {
      updateData.context_json = JSON.stringify(updates.context);
    }
    if (updates.error !== undefined) {
      updateData.error_json = JSON.stringify(updates.error);
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt;
    }
    if (updates.finishedAt !== undefined) {
      updateData.finished_at = updates.finishedAt;
    }

    if (Object.keys(updateData).length > 0) {
      await this.db
        .updateTable('workflow_runs')
        .set(updateData)
        .where('id', '=', runId)
        .execute();
    }
  }

  async listRuns(options: ListRunsOptions = {}): Promise<PaginatedResult<WorkflowRunRecord>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    let query = this.db.selectFrom('workflow_runs').selectAll();

    // Filter by kind
    if (options.kind) {
      query = query.where('kind', '=', options.kind);
    }

    // Filter by status
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      query = query.where('status', 'in', statuses);
    }

    // Filter by parentRunId
    if (options.parentRunId !== undefined) {
      query = query.where('parent_run_id', '=', options.parentRunId);
    }

    // Get total count
    let countQuery = this.db
      .selectFrom('workflow_runs')
      .select(sql<number>`count(*)`.as('count'));

    if (options.kind) {
      countQuery = countQuery.where('kind', '=', options.kind);
    }
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      countQuery = countQuery.where('status', 'in', statuses);
    }
    if (options.parentRunId !== undefined) {
      countQuery = countQuery.where('parent_run_id', '=', options.parentRunId);
    }

    const countResult = await countQuery.executeTakeFirst();
    const total = Number(countResult?.count ?? 0);

    // Order
    const orderBy = options.orderBy ?? 'createdAt';
    const orderDirection = options.orderDirection ?? 'desc';
    const orderColumn = orderBy === 'createdAt' ? 'created_at' :
                       orderBy === 'startedAt' ? 'started_at' : 'finished_at';

    query = query.orderBy(orderColumn, orderDirection);

    // Apply pagination
    query = query.limit(limit).offset(offset);

    const rows = await query.execute();

    return {
      items: rows.map(row => this.mapRunRow(row)),
      total,
      limit,
      offset,
    };
  }

  // ============================================================================
  // Step Operations
  // ============================================================================

  async createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord> {
    const id = generateId();

    await this.db
      .insertInto('workflow_run_steps')
      .values({
        id,
        run_id: step.runId,
        step_key: step.stepKey,
        step_name: step.stepName,
        status: step.status,
        attempt: step.attempt,
        result_json: step.result !== undefined ? JSON.stringify(step.result) : null,
        error_json: step.error ? JSON.stringify(step.error) : null,
        started_at: step.startedAt ?? null,
        finished_at: step.finishedAt ?? null,
      })
      .execute();

    return { ...step, id };
  }

  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    const row = await this.db
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('id', '=', stepId)
      .executeTakeFirst();

    return row ? this.mapStepRow(row) : null;
  }

  async updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void> {
    const updateData: Partial<WorkflowRunStepsTable> = {};

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.attempt !== undefined) {
      updateData.attempt = updates.attempt;
    }
    if (updates.result !== undefined) {
      updateData.result_json = JSON.stringify(updates.result);
    }
    if (updates.error !== undefined) {
      updateData.error_json = JSON.stringify(updates.error);
    }
    if (updates.finishedAt !== undefined) {
      updateData.finished_at = updates.finishedAt;
    }

    if (Object.keys(updateData).length > 0) {
      await this.db
        .updateTable('workflow_run_steps')
        .set(updateData)
        .where('id', '=', stepId)
        .execute();
    }
  }

  async getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]> {
    const rows = await this.db
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc')
      .execute();

    return rows.map(row => this.mapStepRow(row));
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  async saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void> {
    const id = generateId();

    await this.db
      .insertInto('workflow_events')
      .values({
        id,
        run_id: event.runId,
        step_key: event.stepKey ?? null,
        event_type: event.eventType,
        level: event.level,
        payload_json: event.payload !== undefined ? JSON.stringify(event.payload) : null,
        timestamp: event.timestamp,
      })
      .execute();
  }

  async getEventsForRun(runId: string, options: ListEventsOptions = {}): Promise<WorkflowEventRecord[]> {
    const limit = options.limit ?? 1000;
    const offset = options.offset ?? 0;

    let query = this.db
      .selectFrom('workflow_events')
      .selectAll()
      .where('run_id', '=', runId);

    if (options.stepKey) {
      query = query.where('step_key', '=', options.stepKey);
    }

    if (options.level) {
      query = query.where('level', '=', options.level);
    }

    query = query.orderBy('timestamp', 'asc').limit(limit).offset(offset);

    const rows = await query.execute();

    return rows.map(row => this.mapEventRow(row));
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  /**
   * Execute a function within a database transaction.
   */
  async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    return await this.db.transaction().execute(async (trx) => {
      // Create a transactional adapter wrapper
      const txAdapter = new PostgresTransactionAdapter(trx, this.schema);
      return await fn(txAdapter);
    });
  }

  // ============================================================================
  // Cleanup Operations
  // ============================================================================

  /**
   * Delete runs older than the specified date.
   * Also deletes associated steps and events (via CASCADE).
   */
  async deleteOldRuns(olderThan: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('workflow_runs')
      .where('created_at', '<', olderThan)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  // ============================================================================
  // Resume Support
  // ============================================================================

  /**
   * Get all runs that were interrupted (status is 'running' or 'queued').
   * These runs can potentially be resumed.
   */
  async getInterruptedRuns(): Promise<WorkflowRunRecord[]> {
    const rows = await this.db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('status', 'in', ['queued', 'running'])
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map(row => this.mapRunRow(row));
  }

  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId: string): Promise<WorkflowRunStepRecord | null> {
    const row = await this.db
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .where('status', '=', 'succeeded')
      .orderBy('finished_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row ? this.mapStepRow(row) : null;
  }

  // ============================================================================
  // Atomic Dequeue (for distributed workers)
  // ============================================================================

  /**
   * Atomically dequeue a run for processing.
   * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
   *
   * @param workflowKinds - Optional list of workflow kinds to filter by
   * @returns The dequeued run, or null if no runs are available
   */
  async dequeueRun(workflowKinds?: string[]): Promise<WorkflowRunRecord | null> {
    // Use raw SQL for FOR UPDATE SKIP LOCKED
    const kindFilter = workflowKinds && workflowKinds.length > 0
      ? sql`AND kind = ANY(${sql.lit(workflowKinds)})`
      : sql``;

    const result = await sql<WorkflowRunsTable>`
      UPDATE ${sql.table(`${this.schema}.workflow_runs`)}
      SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM ${sql.table(`${this.schema}.workflow_runs`)}
        WHERE status = 'queued' ${kindFilter}
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `.execute(this.db);

    const row = result.rows[0];
    return row ? this.mapRunRow(row) : null;
  }

  // ============================================================================
  // Row Mapping
  // ============================================================================

  private mapRunRow(row: WorkflowRunsTable): WorkflowRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      parentRunId: row.parent_run_id ?? undefined,
      input: typeof row.input_json === 'string' ? JSON.parse(row.input_json) : row.input_json,
      metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
      context: typeof row.context_json === 'string' ? JSON.parse(row.context_json) : row.context_json,
      error: row.error_json ? (typeof row.error_json === 'string' ? JSON.parse(row.error_json) : row.error_json) : undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapStepRow(row: WorkflowRunStepsTable): WorkflowRunStepRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status as StepStatus,
      attempt: row.attempt,
      result: row.result_json ? (typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json) : undefined,
      error: row.error_json ? (typeof row.error_json === 'string' ? JSON.parse(row.error_json) : row.error_json) : undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapEventRow(row: WorkflowEventsTable): WorkflowEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? undefined,
      eventType: row.event_type,
      level: row.level as 'info' | 'warn' | 'error',
      payload: row.payload_json ? (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) : undefined,
      timestamp: new Date(row.timestamp),
    };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get database statistics.
   */
  async getStats(): Promise<{ runs: number; steps: number; events: number }> {
    const [runsCount, stepsCount, eventsCount] = await Promise.all([
      this.db.selectFrom('workflow_runs').select(sql<number>`count(*)`.as('count')).executeTakeFirst(),
      this.db.selectFrom('workflow_run_steps').select(sql<number>`count(*)`.as('count')).executeTakeFirst(),
      this.db.selectFrom('workflow_events').select(sql<number>`count(*)`.as('count')).executeTakeFirst(),
    ]);

    return {
      runs: Number(runsCount?.count ?? 0),
      steps: Number(stepsCount?.count ?? 0),
      events: Number(eventsCount?.count ?? 0),
    };
  }
}

// ============================================================================
// Transaction Adapter (wraps Kysely transaction)
// ============================================================================

/**
 * A StorageAdapter wrapper for use within transactions.
 * This is used internally by PostgresStorageAdapter.transaction().
 */
class PostgresTransactionAdapter implements StorageAdapter {
  constructor(
    private trx: Kysely<StepflowDatabase>,
    private schema: string
  ) {}

  async createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord> {
    const id = generateId();
    const createdAt = new Date();

    await this.trx
      .insertInto('workflow_runs')
      .values({
        id,
        kind: run.kind,
        status: run.status,
        parent_run_id: run.parentRunId ?? null,
        input_json: JSON.stringify(run.input),
        metadata_json: JSON.stringify(run.metadata),
        context_json: JSON.stringify(run.context),
        error_json: run.error ? JSON.stringify(run.error) : null,
        created_at: createdAt,
        started_at: run.startedAt ?? null,
        finished_at: run.finishedAt ?? null,
      })
      .execute();

    return { ...run, id, createdAt };
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    const row = await this.trx
      .selectFrom('workflow_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    return row ? this.mapRunRow(row) : null;
  }

  async updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void> {
    const updateData: Partial<WorkflowRunsTable> = {};

    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.context !== undefined) updateData.context_json = JSON.stringify(updates.context);
    if (updates.error !== undefined) updateData.error_json = JSON.stringify(updates.error);
    if (updates.startedAt !== undefined) updateData.started_at = updates.startedAt;
    if (updates.finishedAt !== undefined) updateData.finished_at = updates.finishedAt;

    if (Object.keys(updateData).length > 0) {
      await this.trx.updateTable('workflow_runs').set(updateData).where('id', '=', runId).execute();
    }
  }

  async listRuns(options: ListRunsOptions = {}): Promise<PaginatedResult<WorkflowRunRecord>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    let query = this.trx.selectFrom('workflow_runs').selectAll();

    if (options.kind) query = query.where('kind', '=', options.kind);
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      query = query.where('status', 'in', statuses);
    }
    if (options.parentRunId !== undefined) {
      query = query.where('parent_run_id', '=', options.parentRunId);
    }

    const orderColumn = (options.orderBy ?? 'createdAt') === 'createdAt' ? 'created_at' :
                        options.orderBy === 'startedAt' ? 'started_at' : 'finished_at';

    query = query.orderBy(orderColumn, options.orderDirection ?? 'desc').limit(limit).offset(offset);

    const rows = await query.execute();

    return {
      items: rows.map(row => this.mapRunRow(row)),
      total: rows.length, // Simplified for transaction context
      limit,
      offset,
    };
  }

  async createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord> {
    const id = generateId();

    await this.trx
      .insertInto('workflow_run_steps')
      .values({
        id,
        run_id: step.runId,
        step_key: step.stepKey,
        step_name: step.stepName,
        status: step.status,
        attempt: step.attempt,
        result_json: step.result !== undefined ? JSON.stringify(step.result) : null,
        error_json: step.error ? JSON.stringify(step.error) : null,
        started_at: step.startedAt ?? null,
        finished_at: step.finishedAt ?? null,
      })
      .execute();

    return { ...step, id };
  }

  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    const row = await this.trx
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('id', '=', stepId)
      .executeTakeFirst();

    return row ? this.mapStepRow(row) : null;
  }

  async updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void> {
    const updateData: Partial<WorkflowRunStepsTable> = {};

    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.attempt !== undefined) updateData.attempt = updates.attempt;
    if (updates.result !== undefined) updateData.result_json = JSON.stringify(updates.result);
    if (updates.error !== undefined) updateData.error_json = JSON.stringify(updates.error);
    if (updates.finishedAt !== undefined) updateData.finished_at = updates.finishedAt;

    if (Object.keys(updateData).length > 0) {
      await this.trx.updateTable('workflow_run_steps').set(updateData).where('id', '=', stepId).execute();
    }
  }

  async getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]> {
    const rows = await this.trx
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc')
      .execute();

    return rows.map(row => this.mapStepRow(row));
  }

  async saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void> {
    const id = generateId();

    await this.trx
      .insertInto('workflow_events')
      .values({
        id,
        run_id: event.runId,
        step_key: event.stepKey ?? null,
        event_type: event.eventType,
        level: event.level,
        payload_json: event.payload !== undefined ? JSON.stringify(event.payload) : null,
        timestamp: event.timestamp,
      })
      .execute();
  }

  async getEventsForRun(runId: string, options: ListEventsOptions = {}): Promise<WorkflowEventRecord[]> {
    let query = this.trx
      .selectFrom('workflow_events')
      .selectAll()
      .where('run_id', '=', runId);

    if (options.stepKey) query = query.where('step_key', '=', options.stepKey);
    if (options.level) query = query.where('level', '=', options.level);

    const rows = await query
      .orderBy('timestamp', 'asc')
      .limit(options.limit ?? 1000)
      .offset(options.offset ?? 0)
      .execute();

    return rows.map(row => this.mapEventRow(row));
  }

  private mapRunRow(row: WorkflowRunsTable): WorkflowRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      parentRunId: row.parent_run_id ?? undefined,
      input: typeof row.input_json === 'string' ? JSON.parse(row.input_json) : row.input_json,
      metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
      context: typeof row.context_json === 'string' ? JSON.parse(row.context_json) : row.context_json,
      error: row.error_json ? (typeof row.error_json === 'string' ? JSON.parse(row.error_json) : row.error_json) : undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapStepRow(row: WorkflowRunStepsTable): WorkflowRunStepRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status as StepStatus,
      attempt: row.attempt,
      result: row.result_json ? (typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json) : undefined,
      error: row.error_json ? (typeof row.error_json === 'string' ? JSON.parse(row.error_json) : row.error_json) : undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapEventRow(row: WorkflowEventsTable): WorkflowEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? undefined,
      eventType: row.event_type,
      level: row.level as 'info' | 'warn' | 'error',
      payload: row.payload_json ? (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) : undefined,
      timestamp: new Date(row.timestamp),
    };
  }
}

// Convenience aliases for shorter naming
export { PostgresStorageAdapter as PostgresStorage };
export type { PostgresStorageConfig as PostgresStorageOptions };
