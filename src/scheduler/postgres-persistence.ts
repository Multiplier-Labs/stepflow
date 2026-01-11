/**
 * PostgreSQL persistence adapter for schedules.
 *
 * Stores workflow schedules in a PostgreSQL database table using Kysely.
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Pool, PoolConfig } from 'pg';
import type { WorkflowSchedule } from './types.js';
import type { SchedulePersistence } from './cron.js';

// ============================================================================
// Database Types (Kysely schema)
// ============================================================================

interface WorkflowSchedulesTable {
  id: string;
  workflow_kind: string;
  trigger_type: string;
  cron_expression: string | null;
  timezone: string | null;
  trigger_on_workflow_kind: string | null;
  trigger_on_status: string | null;
  input_json: string | null;
  metadata_json: string | null;
  enabled: boolean;
  last_run_at: Date | null;
  last_run_id: string | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SchedulesDatabase {
  workflow_schedules: WorkflowSchedulesTable;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for PostgresSchedulePersistence.
 */
export interface PostgresSchedulePersistenceConfig {
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
   * Schema name for the schedules table.
   * @default 'public'
   */
  schema?: string;

  /**
   * Table name for schedules.
   * @default 'workflow_schedules'
   */
  tableName?: string;

  /**
   * Automatically create tables on initialization.
   * @default true
   */
  autoMigrate?: boolean;
}

// ============================================================================
// PostgresSchedulePersistence Class
// ============================================================================

/**
 * PostgreSQL-based persistence for workflow schedules.
 *
 * @example
 * ```typescript
 * const persistence = new PostgresSchedulePersistence({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * await persistence.initialize();
 *
 * const scheduler = new CronScheduler({
 *   engine,
 *   persistence,
 * });
 * ```
 *
 * @example Sharing connection pool
 * ```typescript
 * import pg from 'pg';
 *
 * const pool = new pg.Pool({
 *   connectionString: process.env.DATABASE_URL,
 * });
 *
 * const persistence = new PostgresSchedulePersistence({ pool });
 * await persistence.initialize();
 * ```
 */
export class PostgresSchedulePersistence implements SchedulePersistence {
  private db: Kysely<SchedulesDatabase>;
  private pool: Pool;
  private ownsPool: boolean;
  private schema: string;
  private tableName: string;
  private autoMigrate: boolean;
  private initialized = false;

  constructor(config: PostgresSchedulePersistenceConfig) {
    this.schema = config.schema ?? 'public';
    this.tableName = config.tableName ?? 'workflow_schedules';
    this.autoMigrate = config.autoMigrate !== false;

    // Dynamically import pg to keep it optional
    let pg: typeof import('pg');
    try {
      pg = require('pg');
    } catch {
      throw new Error(
        'PostgresSchedulePersistence requires the "pg" package. Install it with: npm install pg'
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
        'PostgresSchedulePersistenceConfig must include either pool, connectionString, or poolConfig'
      );
    }

    this.db = new Kysely<SchedulesDatabase>({
      dialect: new PostgresDialect({
        pool: this.pool,
      }),
    });
  }

  /**
   * Initialize the persistence layer.
   * Creates the schedules table if autoMigrate is enabled.
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
  // Database Initialization
  // ============================================================================

  private async createTables(): Promise<void> {
    const fullTableName = this.schema === 'public'
      ? this.tableName
      : `${this.schema}.${this.tableName}`;

    // Create schema if not public
    if (this.schema !== 'public') {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);
    }

    // Create schedules table
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(fullTableName)} (
        id TEXT PRIMARY KEY,
        workflow_kind TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        cron_expression TEXT,
        timezone TEXT DEFAULT 'UTC',
        trigger_on_workflow_kind TEXT,
        trigger_on_status JSONB,
        input_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        last_run_at TIMESTAMPTZ,
        last_run_id TEXT,
        next_run_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ${sql.ref(`${this.tableName}_trigger_type_check`)} CHECK (
          trigger_type IN ('cron', 'workflow_completed', 'manual')
        )
      )
    `.execute(this.db);

    // Create indexes
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_workflow_kind`)}
      ON ${sql.table(fullTableName)} (workflow_kind)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_enabled`)}
      ON ${sql.table(fullTableName)} (enabled)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_trigger_type`)}
      ON ${sql.table(fullTableName)} (trigger_type)
    `.execute(this.db);

    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${this.tableName}_next_run`)}
      ON ${sql.table(fullTableName)} (next_run_at)
      WHERE enabled = true
    `.execute(this.db);
  }

  // ============================================================================
  // SchedulePersistence Interface Implementation
  // ============================================================================

  async loadSchedules(): Promise<WorkflowSchedule[]> {
    const rows = await this.db
      .selectFrom('workflow_schedules')
      .selectAll()
      .execute();

    return rows.map(row => this.rowToSchedule(row));
  }

  async saveSchedule(schedule: WorkflowSchedule): Promise<void> {
    await this.db
      .insertInto('workflow_schedules')
      .values({
        id: schedule.id,
        workflow_kind: schedule.workflowKind,
        trigger_type: schedule.triggerType,
        cron_expression: schedule.cronExpression ?? null,
        timezone: schedule.timezone ?? null,
        trigger_on_workflow_kind: schedule.triggerOnWorkflowKind ?? null,
        trigger_on_status: schedule.triggerOnStatus ? JSON.stringify(schedule.triggerOnStatus) : null,
        input_json: schedule.input ? JSON.stringify(schedule.input) : null,
        metadata_json: schedule.metadata ? JSON.stringify(schedule.metadata) : null,
        enabled: schedule.enabled,
        last_run_at: schedule.lastRunAt ?? null,
        last_run_id: schedule.lastRunId ?? null,
        next_run_at: schedule.nextRunAt ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  }

  async updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void> {
    // Get existing schedule to merge with updates
    const existing = await this.db
      .selectFrom('workflow_schedules')
      .selectAll()
      .where('id', '=', scheduleId)
      .executeTakeFirst();

    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const merged = {
      ...this.rowToSchedule(existing),
      ...updates,
    };

    const updateData: Partial<WorkflowSchedulesTable> = {
      updated_at: new Date(),
    };

    if (updates.workflowKind !== undefined) {
      updateData.workflow_kind = updates.workflowKind;
    }
    if (updates.triggerType !== undefined) {
      updateData.trigger_type = updates.triggerType;
    }
    if (updates.cronExpression !== undefined || merged.cronExpression !== undefined) {
      updateData.cron_expression = merged.cronExpression ?? null;
    }
    if (updates.timezone !== undefined || merged.timezone !== undefined) {
      updateData.timezone = merged.timezone ?? null;
    }
    if (updates.triggerOnWorkflowKind !== undefined || merged.triggerOnWorkflowKind !== undefined) {
      updateData.trigger_on_workflow_kind = merged.triggerOnWorkflowKind ?? null;
    }
    if (updates.triggerOnStatus !== undefined || merged.triggerOnStatus !== undefined) {
      updateData.trigger_on_status = merged.triggerOnStatus ? JSON.stringify(merged.triggerOnStatus) : null;
    }
    if (updates.input !== undefined || merged.input !== undefined) {
      updateData.input_json = merged.input ? JSON.stringify(merged.input) : null;
    }
    if (updates.metadata !== undefined || merged.metadata !== undefined) {
      updateData.metadata_json = merged.metadata ? JSON.stringify(merged.metadata) : null;
    }
    if (updates.enabled !== undefined) {
      updateData.enabled = updates.enabled;
    }
    if (updates.lastRunAt !== undefined || merged.lastRunAt !== undefined) {
      updateData.last_run_at = merged.lastRunAt ?? null;
    }
    if (updates.lastRunId !== undefined || merged.lastRunId !== undefined) {
      updateData.last_run_id = merged.lastRunId ?? null;
    }
    if (updates.nextRunAt !== undefined || merged.nextRunAt !== undefined) {
      updateData.next_run_at = merged.nextRunAt ?? null;
    }

    await this.db
      .updateTable('workflow_schedules')
      .set(updateData)
      .where('id', '=', scheduleId)
      .execute();
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.db
      .deleteFrom('workflow_schedules')
      .where('id', '=', scheduleId)
      .execute();
  }

  // ============================================================================
  // Additional Methods
  // ============================================================================

  /**
   * Get a schedule by ID.
   */
  async getSchedule(scheduleId: string): Promise<WorkflowSchedule | null> {
    const row = await this.db
      .selectFrom('workflow_schedules')
      .selectAll()
      .where('id', '=', scheduleId)
      .executeTakeFirst();

    return row ? this.rowToSchedule(row) : null;
  }

  /**
   * Get all enabled schedules that are due to run.
   */
  async getDueSchedules(): Promise<WorkflowSchedule[]> {
    const now = new Date();

    const rows = await this.db
      .selectFrom('workflow_schedules')
      .selectAll()
      .where('enabled', '=', true)
      .where('trigger_type', '=', 'cron')
      .where('next_run_at', '<=', now)
      .execute();

    return rows.map(row => this.rowToSchedule(row));
  }

  /**
   * Get schedules by workflow kind.
   */
  async getSchedulesByWorkflowKind(workflowKind: string): Promise<WorkflowSchedule[]> {
    const rows = await this.db
      .selectFrom('workflow_schedules')
      .selectAll()
      .where('workflow_kind', '=', workflowKind)
      .execute();

    return rows.map(row => this.rowToSchedule(row));
  }

  /**
   * Get workflow completion triggers for a specific workflow kind.
   */
  async getCompletionTriggers(triggerOnWorkflowKind: string): Promise<WorkflowSchedule[]> {
    const rows = await this.db
      .selectFrom('workflow_schedules')
      .selectAll()
      .where('enabled', '=', true)
      .where('trigger_type', '=', 'workflow_completed')
      .where('trigger_on_workflow_kind', '=', triggerOnWorkflowKind)
      .execute();

    return rows.map(row => this.rowToSchedule(row));
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private rowToSchedule(row: WorkflowSchedulesTable): WorkflowSchedule {
    return {
      id: row.id,
      workflowKind: row.workflow_kind,
      triggerType: row.trigger_type as WorkflowSchedule['triggerType'],
      cronExpression: row.cron_expression ?? undefined,
      timezone: row.timezone ?? undefined,
      triggerOnWorkflowKind: row.trigger_on_workflow_kind ?? undefined,
      triggerOnStatus: row.trigger_on_status
        ? (typeof row.trigger_on_status === 'string'
            ? JSON.parse(row.trigger_on_status)
            : row.trigger_on_status)
        : undefined,
      input: row.input_json
        ? (typeof row.input_json === 'string'
            ? JSON.parse(row.input_json)
            : row.input_json)
        : undefined,
      metadata: row.metadata_json
        ? (typeof row.metadata_json === 'string'
            ? JSON.parse(row.metadata_json)
            : row.metadata_json)
        : undefined,
      enabled: row.enabled,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : undefined,
      lastRunId: row.last_run_id ?? undefined,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : undefined,
    };
  }
}
