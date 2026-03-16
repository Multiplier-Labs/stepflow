/**
 * PostgreSQL persistence adapter for schedules.
 *
 * Stores workflow schedules in a PostgreSQL database table using Kysely.
 */

import type { Kysely as KyselyType } from 'kysely';
import type { Pool, PoolConfig } from 'pg';
import { loadPostgresDeps } from '../utils/postgres-deps.js';

// Lazy-loaded dependencies - populated by loadPostgresDeps() during initialize()
let Kysely: any;
let PostgresDialect: any;
let sql: any;
let pgModule: any;
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
  private db!: KyselyType<SchedulesDatabase>;
  private pool!: Pool;
  private ownsPool = false;
  private schema: string;
  private tableName: string;
  private autoMigrate: boolean;
  private initialized = false;
  private config: PostgresSchedulePersistenceConfig;

  constructor(config: PostgresSchedulePersistenceConfig) {
    this.schema = config.schema ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.schema)) {
      throw new Error(
        `Invalid schema name "${this.schema}". Schema must start with a letter or underscore, ` +
        `contain only alphanumeric characters and underscores, and be at most 63 characters.`
      );
    }
    this.tableName = config.tableName ?? 'workflow_schedules';
    this.autoMigrate = config.autoMigrate !== false;
    this.config = config;
  }

  /**
   * Get a schema-scoped query builder.
   * All queries MUST use this instead of this.db directly to respect config.schema.
   */
  private get qb() {
    return this.db.withSchema(this.schema);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'PostgresSchedulePersistence is not initialized. Call initialize() before using the adapter.'
      );
    }
  }

  /**
   * Initialize the persistence layer.
   * Creates the schedules table if autoMigrate is enabled.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const deps = await loadPostgresDeps();
    Kysely = deps.Kysely;
    PostgresDialect = deps.PostgresDialect;
    sql = deps.sql;
    pgModule = deps.pgModule;

    if (this.config.pool) {
      this.pool = this.config.pool;
      this.ownsPool = false;
    } else if (this.config.connectionString) {
      this.pool = new pgModule.Pool({ connectionString: this.config.connectionString });
      this.ownsPool = true;
    } else if (this.config.poolConfig) {
      this.pool = new pgModule.Pool(this.config.poolConfig);
      this.ownsPool = true;
    } else {
      throw new Error(
        'PostgresSchedulePersistenceConfig must include either pool, connectionString, or poolConfig'
      );
    }

    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: this.pool,
      }),
    });

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
    this.ensureInitialized();
    const rows = await this.qb
      .selectFrom(this.tableName as any)
      .selectAll()
      .execute() as WorkflowSchedulesTable[];

    return rows.map(row => this.rowToSchedule(row));
  }

  async saveSchedule(schedule: WorkflowSchedule): Promise<void> {
    this.ensureInitialized();
    await this.qb
      .insertInto(this.tableName as any)
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
    this.ensureInitialized();
    // Partial update pattern: fetch the existing row, merge with incoming updates,
    // then build a column-level update object. Each field is only included if it was
    // explicitly provided in `updates` (or affected by the merge), so unchanged
    // columns are left untouched in the database.
    const existing = await this.qb
      .selectFrom(this.tableName as any)
      .selectAll()
      .where('id', '=', scheduleId)
      .executeTakeFirst() as WorkflowSchedulesTable | undefined;

    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const merged = {
      ...this.rowToSchedule(existing),
      ...updates,
    };

    // Field mapping: { domainKey, dbKey, serialize? }
    // Each entry maps a WorkflowSchedule field to its DB column, with optional serialization.
    const fieldMappings: Array<{
      domainKey: keyof WorkflowSchedule;
      dbKey: keyof WorkflowSchedulesTable;
      serialize?: (value: any) => any;
    }> = [
      { domainKey: 'workflowKind', dbKey: 'workflow_kind' },
      { domainKey: 'triggerType', dbKey: 'trigger_type' },
      { domainKey: 'cronExpression', dbKey: 'cron_expression' },
      { domainKey: 'timezone', dbKey: 'timezone' },
      { domainKey: 'triggerOnWorkflowKind', dbKey: 'trigger_on_workflow_kind' },
      { domainKey: 'triggerOnStatus', dbKey: 'trigger_on_status', serialize: v => v ? JSON.stringify(v) : null },
      { domainKey: 'input', dbKey: 'input_json', serialize: v => v ? JSON.stringify(v) : null },
      { domainKey: 'metadata', dbKey: 'metadata_json', serialize: v => v ? JSON.stringify(v) : null },
      { domainKey: 'enabled', dbKey: 'enabled' },
      { domainKey: 'lastRunAt', dbKey: 'last_run_at' },
      { domainKey: 'lastRunId', dbKey: 'last_run_id' },
      { domainKey: 'nextRunAt', dbKey: 'next_run_at' },
    ];

    const updateData: Partial<WorkflowSchedulesTable> = {
      updated_at: new Date(),
    };

    for (const { domainKey, dbKey, serialize } of fieldMappings) {
      if (updates[domainKey] !== undefined || merged[domainKey] !== undefined) {
        const value = serialize
          ? serialize(merged[domainKey])
          : (merged[domainKey] ?? null);
        (updateData as any)[dbKey] = value;
      }
    }

    await this.qb
      .updateTable(this.tableName as any)
      .set(updateData)
      .where('id', '=', scheduleId)
      .execute();
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    this.ensureInitialized();
    await this.qb
      .deleteFrom(this.tableName as any)
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
    this.ensureInitialized();
    const row = await this.qb
      .selectFrom(this.tableName as any)
      .selectAll()
      .where('id', '=', scheduleId)
      .executeTakeFirst() as WorkflowSchedulesTable | undefined;

    return row ? this.rowToSchedule(row) : null;
  }

  /**
   * Get all enabled schedules that are due to run.
   */
  async getDueSchedules(): Promise<WorkflowSchedule[]> {
    this.ensureInitialized();
    const now = new Date();

    const rows = await this.qb
      .selectFrom(this.tableName as any)
      .selectAll()
      .where('enabled', '=', true)
      .where('trigger_type', '=', 'cron')
      .where('next_run_at', '<=', now)
      .execute() as WorkflowSchedulesTable[];

    return rows.map(row => this.rowToSchedule(row));
  }

  /**
   * Get schedules by workflow kind.
   */
  async getSchedulesByWorkflowKind(workflowKind: string): Promise<WorkflowSchedule[]> {
    this.ensureInitialized();
    const rows = await this.qb
      .selectFrom(this.tableName as any)
      .selectAll()
      .where('workflow_kind', '=', workflowKind)
      .execute() as WorkflowSchedulesTable[];

    return rows.map(row => this.rowToSchedule(row));
  }

  /**
   * Get workflow completion triggers for a specific workflow kind.
   */
  async getCompletionTriggers(triggerOnWorkflowKind: string): Promise<WorkflowSchedule[]> {
    this.ensureInitialized();
    const rows = await this.qb
      .selectFrom(this.tableName as any)
      .selectAll()
      .where('enabled', '=', true)
      .where('trigger_type', '=', 'workflow_completed')
      .where('trigger_on_workflow_kind', '=', triggerOnWorkflowKind)
      .execute() as WorkflowSchedulesTable[];

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

// Convenience alias for shorter naming
export type { PostgresSchedulePersistenceConfig as PostgresSchedulePersistenceOptions };
