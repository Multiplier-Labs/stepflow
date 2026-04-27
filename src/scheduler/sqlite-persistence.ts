/**
 * SQLite persistence adapter for schedules.
 *
 * Stores workflow schedules in a SQLite database table.
 */

import type { Database, Statement } from 'better-sqlite3';
import type { WorkflowSchedule } from './types';
import type { SchedulePersistence } from './cron';
import type { Logger, RunStatus } from '../core/types';
import { generateId } from '../utils/id';
import { safeJsonParse as safeJsonParseShared } from '../utils/safe-json';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for SQLiteSchedulePersistence.
 */
export interface SQLiteSchedulePersistenceConfig {
  /** SQLite database instance */
  db: Database;

  /** Table name for schedules (default: workflow_schedules) */
  tableName?: string;

  /**
   * Optional structured logger used to surface JSON corruption events.
   * Without one, parse failures still increment the corruption counter
   * exposed via `getJsonParseCorruptionCount()` but produce no log output.
   */
  logger?: Logger;
}

// ============================================================================
// SQLiteSchedulePersistence Class
// ============================================================================

/**
 * SQLite-based persistence for workflow schedules.
 *
 * @example
 * ```typescript
 * import Database from 'better-sqlite3';
 *
 * const db = new Database('workflow.db');
 * const persistence = new SQLiteSchedulePersistence({ db });
 *
 * const scheduler = new CronScheduler({
 *   engine,
 *   persistence,
 * });
 * ```
 */
export class SQLiteSchedulePersistence implements SchedulePersistence {
  private db: Database;
  private tableName: string;
  private logger: Logger | undefined;
  private stmts: {
    insert: Statement;
    update: Statement;
    delete: Statement;
    getAll: Statement;
    getById: Statement;
  } | null = null;

  constructor(config: SQLiteSchedulePersistenceConfig) {
    this.db = config.db;
    this.tableName = config.tableName ?? 'workflow_schedules';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.tableName)) {
      throw new Error(`Invalid table name: ${this.tableName}`);
    }
    this.logger = config.logger;
    this.initializeDatabase();
  }

  // ============================================================================
  // Database Initialization
  // ============================================================================

  private initializeDatabase(): void {
    // Create schedules table.
    // Schema layout:
    //   id               — unique schedule identifier (TEXT PK)
    //   workflow_kind     — target workflow type to spawn
    //   trigger_type      — 'cron', 'workflow_completed', or 'manual'
    //   cron_expression   — cron expression for time-based triggers (nullable)
    //   timezone          — IANA timezone for cron evaluation (nullable)
    //   trigger_on_*      — fields for workflow-completion triggers
    //   input / metadata  — JSON-serialized payloads for spawned runs
    //   enabled           — whether this schedule is active (0/1)
    //   last_run_at/id    — most recent execution tracking
    //   next_run_at       — next scheduled execution time
    //   created_at/updated_at — audit timestamps
    // No migration strategy is currently implemented; table is created idempotently.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        workflow_kind TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        cron_expression TEXT,
        timezone TEXT,
        trigger_on_workflow_kind TEXT,
        trigger_on_status TEXT,
        input TEXT,
        metadata TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_run_id TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_workflow_kind
      ON ${this.tableName}(workflow_kind);

      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_enabled
      ON ${this.tableName}(enabled);

      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_trigger_type
      ON ${this.tableName}(trigger_type);
    `);

    // Prepare statements
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO ${this.tableName} (
          id, workflow_kind, trigger_type, cron_expression, timezone,
          trigger_on_workflow_kind, trigger_on_status, input, metadata,
          enabled, last_run_at, last_run_id, next_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      update: this.db.prepare(`
        UPDATE ${this.tableName}
        SET workflow_kind = COALESCE(?, workflow_kind),
            trigger_type = COALESCE(?, trigger_type),
            cron_expression = ?,
            timezone = ?,
            trigger_on_workflow_kind = ?,
            trigger_on_status = ?,
            input = ?,
            metadata = ?,
            enabled = COALESCE(?, enabled),
            last_run_at = ?,
            last_run_id = ?,
            next_run_at = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `),
      delete: this.db.prepare(`
        DELETE FROM ${this.tableName} WHERE id = ?
      `),
      getAll: this.db.prepare(`
        SELECT * FROM ${this.tableName}
      `),
      getById: this.db.prepare(`
        SELECT * FROM ${this.tableName} WHERE id = ?
      `),
    };
  }

  // ============================================================================
  // SchedulePersistence Interface Implementation
  // ============================================================================

  async loadSchedules(): Promise<WorkflowSchedule[]> {
    const rows = this.stmts!.getAll.all() as ScheduleRow[];
    return rows.map(row => this.rowToSchedule(row));
  }

  async saveSchedule(schedule: WorkflowSchedule): Promise<void> {
    this.stmts!.insert.run(
      schedule.id,
      schedule.workflowKind,
      schedule.triggerType,
      schedule.cronExpression ?? null,
      schedule.timezone ?? null,
      schedule.triggerOnWorkflowKind ?? null,
      schedule.triggerOnStatus ? JSON.stringify(schedule.triggerOnStatus) : null,
      schedule.input ? JSON.stringify(schedule.input) : null,
      schedule.metadata ? JSON.stringify(schedule.metadata) : null,
      schedule.enabled ? 1 : 0,
      schedule.lastRunAt?.toISOString() ?? null,
      schedule.lastRunId ?? null,
      schedule.nextRunAt?.toISOString() ?? null
    );
  }

  async updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void> {
    // Get existing schedule to merge with updates
    const existing = this.stmts!.getById.get(scheduleId) as ScheduleRow | undefined;
    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const merged = {
      ...this.rowToSchedule(existing),
      ...updates,
    };

    this.stmts!.update.run(
      updates.workflowKind ?? null,
      updates.triggerType ?? null,
      merged.cronExpression ?? null,
      merged.timezone ?? null,
      merged.triggerOnWorkflowKind ?? null,
      merged.triggerOnStatus ? JSON.stringify(merged.triggerOnStatus) : null,
      merged.input ? JSON.stringify(merged.input) : null,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : null,
      merged.lastRunAt?.toISOString() ?? null,
      merged.lastRunId ?? null,
      merged.nextRunAt?.toISOString() ?? null,
      scheduleId
    );
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    this.stmts!.delete.run(scheduleId);
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private safeJsonParse(json: string, fallback: unknown, rowId?: string, column?: string): unknown {
    return safeJsonParseShared(json, fallback, {
      component: 'SQLiteSchedulePersistence',
      rowId,
      column,
      logger: this.logger,
    });
  }

  private rowToSchedule(row: ScheduleRow): WorkflowSchedule {
    return {
      id: row.id,
      workflowKind: row.workflow_kind,
      triggerType: row.trigger_type as WorkflowSchedule['triggerType'],
      cronExpression: row.cron_expression ?? undefined,
      timezone: row.timezone ?? undefined,
      triggerOnWorkflowKind: row.trigger_on_workflow_kind ?? undefined,
      triggerOnStatus: row.trigger_on_status
        ? this.safeJsonParse(row.trigger_on_status, undefined, row.id, 'trigger_on_status') as RunStatus[] | undefined
        : undefined,
      input: row.input ? this.safeJsonParse(row.input, undefined, row.id, 'input') as Record<string, unknown> | undefined : undefined,
      metadata: row.metadata ? this.safeJsonParse(row.metadata, undefined, row.id, 'metadata') as Record<string, unknown> | undefined : undefined,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : undefined,
      lastRunId: row.last_run_id ?? undefined,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : undefined,
    };
  }
}

// ============================================================================
// Types
// ============================================================================

interface ScheduleRow {
  id: string;
  workflow_kind: string;
  trigger_type: string;
  cron_expression: string | null;
  timezone: string | null;
  trigger_on_workflow_kind: string | null;
  trigger_on_status: string | null;
  input: string | null;
  metadata: string | null;
  enabled: number;
  last_run_at: string | null;
  last_run_id: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}
