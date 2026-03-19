/**
 * SQLite storage adapter using better-sqlite3.
 *
 * Provides durable persistence for workflow runs, steps, and events.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../utils/id';
import type {
  StorageAdapter,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  WorkflowEventRecord,
  ListRunsOptions,
  ListEventsOptions,
  PaginatedResult,
} from './types';
import type { RunStatus, StepStatus, WorkflowError } from '../core/types';
import { sanitizeErrorForStorage } from '../utils/logger';

// ============================================================================
// Schema SQL
// ============================================================================

/**
 * SQL statements to create the workflow tables.
 * These create the workflow tables in your database.
 */
const CREATE_TABLES_SQL = `
-- Workflow runs table
CREATE TABLE IF NOT EXISTS workflow_runs (
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

CREATE INDEX IF NOT EXISTS idx_workflow_runs_kind_status ON workflow_runs(kind, status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent ON workflow_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created ON workflow_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

-- Workflow run steps table
CREATE TABLE IF NOT EXISTS workflow_run_steps (
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

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_key ON workflow_run_steps(run_id, step_key);

-- Workflow events table
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_key TEXT,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,
  payload_json TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_run_ts ON workflow_events(run_id, timestamp);
`;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration options for the SQLite storage adapter.
 */
export interface SQLiteStorageConfig {
  /**
   * The better-sqlite3 database instance.
   * Can be an in-memory database (`:memory:`) or a file path.
   */
  db: Database.Database;

  /**
   * Whether to automatically create tables on initialization.
   * Default: true
   */
  autoCreateTables?: boolean;

  /**
   * @deprecated This option is not currently supported and will be ignored.
   * Table names are always prefixed with 'workflow_'.
   */
  tablePrefix?: string;
}

// ============================================================================
// SQLite Storage Adapter
// ============================================================================

/**
 * SQLite implementation of StorageAdapter using better-sqlite3.
 *
 * Features:
 * - Synchronous operations (better-sqlite3 is sync by design)
 * - Automatic table creation
 * - Transaction support
 * - Customizable table prefix
 *
 * @example
 * ```typescript
 * import Database from 'better-sqlite3';
 * import { SQLiteStorageAdapter } from 'stepflow/storage';
 *
 * const db = new Database('./workflows.db');
 * const storage = new SQLiteStorageAdapter({ db });
 *
 * const engine = new WorkflowEngine({ storage });
 * ```
 */
export class SQLiteStorageAdapter implements StorageAdapter {
  private db: Database.Database;
  private prefix: string;

  // Prepared statements (cached for performance)
  private stmts: {
    insertRun: Database.Statement;
    getRun: Database.Statement;
    updateRun: Database.Statement;
    listRuns: Database.Statement;
    countRuns: Database.Statement;
    insertStep: Database.Statement;
    getStep: Database.Statement;
    updateStep: Database.Statement;
    getStepsForRun: Database.Statement;
    insertEvent: Database.Statement;
    getEventsForRun: Database.Statement;
    deleteOldRuns: Database.Statement;
    deleteStepsForRuns: Database.Statement;
    deleteEventsForRuns: Database.Statement;
    getInterruptedRuns: Database.Statement;
    getLastCompletedStep: Database.Statement;
  } | null = null;

  constructor(config: SQLiteStorageConfig) {
    this.db = config.db;
    this.prefix = config.tablePrefix ?? 'workflow';

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Create tables if needed
    if (config.autoCreateTables !== false) {
      this.createTables();
    }

    // Prepare statements
    this.prepareStatements();
  }

  /**
   * Create the workflow tables if they don't exist.
   */
  private createTables(): void {
    this.db.exec(CREATE_TABLES_SQL);
  }

  /**
   * Prepare all SQL statements for better performance.
   */
  private prepareStatements(): void {
    this.stmts = {
      insertRun: this.db.prepare(`
        INSERT INTO workflow_runs (id, kind, status, parent_run_id, input_json, metadata_json, context_json, error_json, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getRun: this.db.prepare(`
        SELECT * FROM workflow_runs WHERE id = ?
      `),
      updateRun: this.db.prepare(`
        UPDATE workflow_runs
        SET status = COALESCE(?, status),
            context_json = COALESCE(?, context_json),
            error_json = COALESCE(?, error_json),
            started_at = COALESCE(?, started_at),
            finished_at = COALESCE(?, finished_at)
        WHERE id = ?
      `),
      // json_each() is a SQLite table-valued function that expands a JSON array into rows.
      // We use it here to support filtering by multiple statuses in a single prepared statement:
      // the caller passes a JSON array like '["running","failed"]', and json_each unpacks it
      // so the IN clause can match against each value. When status is NULL, the entire
      // condition is bypassed via the (? IS NULL OR ...) guard.
      listRuns: this.db.prepare(`
        SELECT * FROM workflow_runs
        WHERE (? IS NULL OR kind = ?)
          AND (? IS NULL OR status IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR parent_run_id = ?)
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `),
      countRuns: this.db.prepare(`
        SELECT COUNT(*) as count FROM workflow_runs
        WHERE (? IS NULL OR kind = ?)
          AND (? IS NULL OR status IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR parent_run_id = ?)
      `),
      insertStep: this.db.prepare(`
        INSERT INTO workflow_run_steps (id, run_id, step_key, step_name, status, attempt, result_json, error_json, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getStep: this.db.prepare(`
        SELECT * FROM workflow_run_steps WHERE id = ?
      `),
      updateStep: this.db.prepare(`
        UPDATE workflow_run_steps
        SET status = COALESCE(?, status),
            attempt = COALESCE(?, attempt),
            result_json = COALESCE(?, result_json),
            error_json = COALESCE(?, error_json),
            finished_at = COALESCE(?, finished_at)
        WHERE id = ?
      `),
      getStepsForRun: this.db.prepare(`
        SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY started_at ASC
      `),
      insertEvent: this.db.prepare(`
        INSERT INTO workflow_events (id, run_id, step_key, event_type, level, payload_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getEventsForRun: this.db.prepare(`
        SELECT * FROM workflow_events
        WHERE run_id = ?
          AND (? IS NULL OR step_key = ?)
          AND (? IS NULL OR level = ?)
        ORDER BY timestamp ASC
        LIMIT ? OFFSET ?
      `),
      deleteOldRuns: this.db.prepare(`
        DELETE FROM workflow_runs WHERE created_at < ?
      `),
      deleteStepsForRuns: this.db.prepare(`
        DELETE FROM workflow_run_steps WHERE run_id IN (SELECT id FROM workflow_runs WHERE created_at < ?)
      `),
      deleteEventsForRuns: this.db.prepare(`
        DELETE FROM workflow_events WHERE run_id IN (SELECT id FROM workflow_runs WHERE created_at < ?)
      `),
      getInterruptedRuns: this.db.prepare(`
        SELECT * FROM workflow_runs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at ASC
      `),
      getLastCompletedStep: this.db.prepare(`
        SELECT * FROM workflow_run_steps
        WHERE run_id = ? AND status = 'succeeded'
        ORDER BY finished_at DESC
        LIMIT 1
      `),
    };
  }

  // ============================================================================
  // Run Operations
  // ============================================================================

  async createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord> {
    const id = generateId();
    const createdAt = new Date();

    this.stmts!.insertRun.run(
      id,
      run.kind,
      run.status,
      run.parentRunId ?? null,
      JSON.stringify(run.input),
      JSON.stringify(run.metadata),
      JSON.stringify(run.context),
      run.error ? JSON.stringify(sanitizeErrorForStorage(run.error)) : null,
      createdAt.toISOString(),
      run.startedAt?.toISOString() ?? null,
      run.finishedAt?.toISOString() ?? null
    );

    return {
      ...run,
      id,
      createdAt,
    };
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    const row = this.stmts!.getRun.get(runId) as SQLiteRunRow | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  async updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void> {
    this.stmts!.updateRun.run(
      updates.status ?? null,
      updates.context ? JSON.stringify(updates.context) : null,
      updates.error ? JSON.stringify(sanitizeErrorForStorage(updates.error)) : null,
      updates.startedAt?.toISOString() ?? null,
      updates.finishedAt?.toISOString() ?? null,
      runId
    );
  }

  async listRuns(options: ListRunsOptions = {}): Promise<PaginatedResult<WorkflowRunRecord>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const kind = options.kind ?? null;
    const status = options.status ?? null;
    const statusJson = status ? JSON.stringify(Array.isArray(status) ? status : [status]) : null;
    const parentRunId = options.parentRunId ?? null;

    const rows = this.stmts!.listRuns.all(
      kind, kind,
      statusJson, statusJson,
      parentRunId, parentRunId,
      limit, offset
    ) as SQLiteRunRow[];

    const countResult = this.stmts!.countRuns.get(
      kind, kind,
      statusJson, statusJson,
      parentRunId, parentRunId
    ) as { count: number };

    return {
      items: rows.map(row => this.mapRunRow(row)),
      total: countResult.count,
      limit,
      offset,
    };
  }

  // ============================================================================
  // Step Operations
  // ============================================================================

  async createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord> {
    const id = generateId();

    this.stmts!.insertStep.run(
      id,
      step.runId,
      step.stepKey,
      step.stepName,
      step.status,
      step.attempt,
      step.result !== undefined ? JSON.stringify(step.result) : null,
      step.error ? JSON.stringify(sanitizeErrorForStorage(step.error)) : null,
      step.startedAt?.toISOString() ?? null,
      step.finishedAt?.toISOString() ?? null
    );

    return { ...step, id };
  }

  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    const row = this.stmts!.getStep.get(stepId) as SQLiteStepRow | undefined;
    return row ? this.mapStepRow(row) : null;
  }

  async updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void> {
    this.stmts!.updateStep.run(
      updates.status ?? null,
      updates.attempt ?? null,
      updates.result !== undefined ? JSON.stringify(updates.result) : null,
      updates.error ? JSON.stringify(sanitizeErrorForStorage(updates.error)) : null,
      updates.finishedAt?.toISOString() ?? null,
      stepId
    );
  }

  async getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]> {
    const rows = this.stmts!.getStepsForRun.all(runId) as SQLiteStepRow[];
    return rows.map(row => this.mapStepRow(row));
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  async saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void> {
    const id = generateId();

    this.stmts!.insertEvent.run(
      id,
      event.runId,
      event.stepKey ?? null,
      event.eventType,
      event.level,
      event.payload !== undefined ? JSON.stringify(event.payload) : null,
      event.timestamp.toISOString()
    );
  }

  async getEventsForRun(runId: string, options: ListEventsOptions = {}): Promise<WorkflowEventRecord[]> {
    const limit = options.limit ?? 1000;
    const offset = options.offset ?? 0;
    const stepKey = options.stepKey ?? null;
    const level = options.level ?? null;

    const rows = this.stmts!.getEventsForRun.all(
      runId,
      stepKey, stepKey,
      level, level,
      limit, offset
    ) as SQLiteEventRow[];

    return rows.map(row => this.mapEventRow(row));
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  /**
   * Execute a function within a database transaction (async interface).
   *
   * @deprecated Use `transactionSync()` instead. This method only works when
   * the callback performs purely synchronous operations wrapped in async/await.
   * If the callback awaits real async I/O (network, timers, etc.), it will
   * throw an error. `transactionSync()` makes the synchronous requirement explicit.
   */
  async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    let resultPromise!: Promise<T>;
    this.transactionSync(() => {
      resultPromise = fn(this);
    });
    return resultPromise;
  }

  /**
   * Execute a synchronous transaction (preferred for better-sqlite3).
   * Use this when you need transaction guarantees.
   *
   * @example
   * ```typescript
   * storage.transactionSync(() => {
   *   // Multiple operations in a single transaction
   *   const run = storage.createRunSync(...);
   *   storage.updateRunSync(run.id, ...);
   * });
   * ```
   */
  transactionSync<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ============================================================================
  // Cleanup Operations
  // ============================================================================

  /**
   * Delete runs older than the specified date.
   * Also deletes associated steps and events (via CASCADE).
   */
  async deleteOldRuns(olderThan: Date): Promise<number> {
    const isoDate = olderThan.toISOString();

    // Due to CASCADE, steps and events are deleted automatically
    // But we do it explicitly for databases without CASCADE support
    return this.db.transaction(() => {
      this.stmts!.deleteEventsForRuns.run(isoDate);
      this.stmts!.deleteStepsForRuns.run(isoDate);
      const result = this.stmts!.deleteOldRuns.run(isoDate);
      return result.changes;
    })();
  }

  // ============================================================================
  // Resume Support
  // ============================================================================

  /**
   * Get all runs that were interrupted (status is 'running' or 'queued').
   * These runs can potentially be resumed.
   */
  async getInterruptedRuns(): Promise<WorkflowRunRecord[]> {
    const rows = this.stmts!.getInterruptedRuns.all() as SQLiteRunRow[];
    return rows.map(row => this.mapRunRow(row));
  }

  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId: string): Promise<WorkflowRunStepRecord | null> {
    const row = this.stmts!.getLastCompletedStep.get(runId) as SQLiteStepRow | undefined;
    return row ? this.mapStepRow(row) : null;
  }

  // ============================================================================
  // Row Mapping
  // ============================================================================

  private mapRunRow(row: SQLiteRunRow): WorkflowRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      parentRunId: row.parent_run_id ?? undefined,
      input: JSON.parse(row.input_json),
      metadata: JSON.parse(row.metadata_json),
      context: JSON.parse(row.context_json),
      error: row.error_json ? JSON.parse(row.error_json) : undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapStepRow(row: SQLiteStepRow): WorkflowRunStepRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status as StepStatus,
      attempt: row.attempt,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error_json ? JSON.parse(row.error_json) : undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    };
  }

  private mapEventRow(row: SQLiteEventRow): WorkflowEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? undefined,
      eventType: row.event_type,
      level: row.level as 'info' | 'warn' | 'error',
      payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
      timestamp: new Date(row.timestamp),
    };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database statistics.
   */
  getStats(): { runs: number; steps: number; events: number } {
    const runsCount = this.db.prepare('SELECT COUNT(*) as count FROM workflow_runs').get() as { count: number };
    const stepsCount = this.db.prepare('SELECT COUNT(*) as count FROM workflow_run_steps').get() as { count: number };
    const eventsCount = this.db.prepare('SELECT COUNT(*) as count FROM workflow_events').get() as { count: number };

    return {
      runs: runsCount.count,
      steps: stepsCount.count,
      events: eventsCount.count,
    };
  }
}

// ============================================================================
// SQLite Row Types
// ============================================================================

interface SQLiteRunRow {
  id: string;
  kind: string;
  status: string;
  parent_run_id: string | null;
  input_json: string;
  metadata_json: string;
  context_json: string;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface SQLiteStepRow {
  id: string;
  run_id: string;
  step_key: string;
  step_name: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface SQLiteEventRow {
  id: string;
  run_id: string;
  step_key: string | null;
  event_type: string;
  level: string;
  payload_json: string | null;
  timestamp: string;
}
