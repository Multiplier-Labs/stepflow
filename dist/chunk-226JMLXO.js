import {
  ConsoleLogger,
  generateId,
  loadPostgresDeps
} from "./chunk-UFSYMSAG.js";

// src/scheduler/cron.ts
import { CronExpressionParser } from "cron-parser";
var CronScheduler = class {
  engine;
  logger;
  pollInterval;
  persistence;
  schedules = /* @__PURE__ */ new Map();
  running = false;
  pollTimer = null;
  eventUnsubscribe = null;
  constructor(config) {
    this.engine = config.engine;
    this.logger = config.logger ?? new ConsoleLogger();
    this.pollInterval = config.pollInterval ?? 1e3;
    this.persistence = config.persistence;
  }
  // ============================================================================
  // Scheduler Interface Implementation
  // ============================================================================
  /**
   * Start the scheduler.
   * Begins polling for cron schedules and subscribes to workflow completion events.
   */
  async start() {
    if (this.running) {
      this.logger.warn("Scheduler is already running");
      return;
    }
    this.logger.info("Starting scheduler...");
    if (this.persistence) {
      const loaded = await this.persistence.loadSchedules();
      for (const schedule of loaded) {
        this.schedules.set(schedule.id, schedule);
      }
      this.logger.info(`Loaded ${loaded.length} schedules from persistence`);
    }
    for (const schedule of this.schedules.values()) {
      if (schedule.triggerType === "cron" && schedule.cronExpression) {
        this.updateNextRunTime(schedule);
      }
    }
    this.pollTimer = setInterval(() => this.checkSchedules(), this.pollInterval);
    this.eventUnsubscribe = this.engine.subscribeToAll((event) => {
      this.handleWorkflowEvent(event);
    });
    this.running = true;
    this.logger.info("Scheduler started");
  }
  /**
   * Stop the scheduler.
   * Stops polling and unsubscribes from events.
   */
  async stop() {
    if (!this.running) {
      return;
    }
    this.logger.info("Stopping scheduler...");
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
    this.running = false;
    this.logger.info("Scheduler stopped");
  }
  /**
   * Add a new schedule.
   */
  async addSchedule(scheduleData) {
    const schedule = {
      ...scheduleData,
      id: generateId()
    };
    if (schedule.triggerType === "cron" && schedule.cronExpression) {
      try {
        CronExpressionParser.parse(schedule.cronExpression, {
          tz: schedule.timezone
        });
      } catch (error) {
        throw new Error(`Invalid cron expression: ${schedule.cronExpression}`);
      }
      this.updateNextRunTime(schedule);
    }
    if (schedule.triggerType === "workflow_completed") {
      if (!schedule.triggerOnWorkflowKind) {
        throw new Error("triggerOnWorkflowKind is required for workflow_completed triggers");
      }
    }
    this.schedules.set(schedule.id, schedule);
    if (this.persistence) {
      await this.persistence.saveSchedule(schedule);
    }
    this.logger.info(`Added schedule: ${schedule.id} (${schedule.workflowKind})`);
    return schedule;
  }
  /**
   * Remove a schedule.
   */
  async removeSchedule(scheduleId) {
    if (!this.schedules.has(scheduleId)) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    this.schedules.delete(scheduleId);
    if (this.persistence) {
      await this.persistence.deleteSchedule(scheduleId);
    }
    this.logger.info(`Removed schedule: ${scheduleId}`);
  }
  /**
   * Update a schedule.
   */
  async updateSchedule(scheduleId, updates) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    delete updates.id;
    Object.assign(schedule, updates);
    if (updates.cronExpression !== void 0 || updates.timezone !== void 0) {
      if (schedule.cronExpression) {
        try {
          CronExpressionParser.parse(schedule.cronExpression, {
            tz: schedule.timezone
          });
          this.updateNextRunTime(schedule);
        } catch (error) {
          throw new Error(`Invalid cron expression: ${schedule.cronExpression}`);
        }
      }
    }
    if (this.persistence) {
      await this.persistence.updateSchedule(scheduleId, updates);
    }
    this.logger.debug(`Updated schedule: ${scheduleId}`);
  }
  /**
   * Get all schedules.
   */
  async getSchedules() {
    return Array.from(this.schedules.values());
  }
  /**
   * Get a schedule by ID.
   */
  getSchedule(scheduleId) {
    return this.schedules.get(scheduleId);
  }
  /**
   * Manually trigger a scheduled workflow.
   */
  async triggerNow(scheduleId) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    return this.executeSchedule(schedule);
  }
  // ============================================================================
  // Internal Methods
  // ============================================================================
  /**
   * Check all cron schedules and execute those that are due.
   */
  checkSchedules() {
    const now = /* @__PURE__ */ new Date();
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (schedule.triggerType !== "cron") continue;
      if (!schedule.nextRunAt) continue;
      if (schedule.nextRunAt <= now) {
        this.executeSchedule(schedule).catch((error) => {
          this.logger.error(`Failed to execute schedule ${schedule.id}:`, error);
        });
        this.updateNextRunTime(schedule);
      }
    }
  }
  /**
   * Handle workflow events for completion triggers.
   */
  handleWorkflowEvent(event) {
    if (event.eventType !== "run.completed" && event.eventType !== "run.failed") {
      return;
    }
    const completedStatus = event.eventType === "run.completed" ? "succeeded" : "failed";
    const completedKind = event.kind;
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (schedule.triggerType !== "workflow_completed") continue;
      if (schedule.triggerOnWorkflowKind !== completedKind) continue;
      if (schedule.triggerOnStatus && !schedule.triggerOnStatus.includes(completedStatus)) {
        continue;
      }
      this.executeSchedule(schedule, {
        triggerRunId: event.runId,
        triggerStatus: completedStatus
      }).catch((error) => {
        this.logger.error(`Failed to execute schedule ${schedule.id}:`, error);
      });
    }
  }
  /**
   * Execute a schedule by starting the workflow.
   */
  async executeSchedule(schedule, triggerContext) {
    this.logger.info(`Executing schedule: ${schedule.id} (${schedule.workflowKind})`);
    const metadata = {
      ...schedule.metadata,
      scheduleId: schedule.id,
      triggerType: schedule.triggerType,
      ...triggerContext ?? {}
    };
    const runId = await this.engine.startRun({
      kind: schedule.workflowKind,
      input: schedule.input,
      metadata
    });
    schedule.lastRunAt = /* @__PURE__ */ new Date();
    schedule.lastRunId = runId;
    if (this.persistence) {
      await this.persistence.updateSchedule(schedule.id, {
        lastRunAt: schedule.lastRunAt,
        lastRunId: schedule.lastRunId,
        nextRunAt: schedule.nextRunAt
      });
    }
    return runId;
  }
  /**
   * Update the next run time for a cron schedule.
   */
  updateNextRunTime(schedule) {
    if (!schedule.cronExpression) return;
    try {
      const interval = CronExpressionParser.parse(schedule.cronExpression, {
        currentDate: /* @__PURE__ */ new Date(),
        tz: schedule.timezone
      });
      schedule.nextRunAt = interval.next().toDate();
    } catch (error) {
      this.logger.error(`Failed to parse cron expression for schedule ${schedule.id}:`, error);
      schedule.nextRunAt = void 0;
    }
  }
};

// src/scheduler/sqlite-persistence.ts
var SQLiteSchedulePersistence = class {
  db;
  tableName;
  stmts = null;
  constructor(config) {
    this.db = config.db;
    this.tableName = config.tableName ?? "workflow_schedules";
    this.initializeDatabase();
  }
  // ============================================================================
  // Database Initialization
  // ============================================================================
  initializeDatabase() {
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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_workflow_kind
      ON ${this.tableName}(workflow_kind);

      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_enabled
      ON ${this.tableName}(enabled);

      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_trigger_type
      ON ${this.tableName}(trigger_type);
    `);
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
      `)
    };
  }
  // ============================================================================
  // SchedulePersistence Interface Implementation
  // ============================================================================
  async loadSchedules() {
    const rows = this.stmts.getAll.all();
    return rows.map((row) => this.rowToSchedule(row));
  }
  async saveSchedule(schedule) {
    this.stmts.insert.run(
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
  async updateSchedule(scheduleId, updates) {
    const existing = this.stmts.getById.get(scheduleId);
    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    const merged = {
      ...this.rowToSchedule(existing),
      ...updates
    };
    this.stmts.update.run(
      updates.workflowKind ?? null,
      updates.triggerType ?? null,
      merged.cronExpression ?? null,
      merged.timezone ?? null,
      merged.triggerOnWorkflowKind ?? null,
      merged.triggerOnStatus ? JSON.stringify(merged.triggerOnStatus) : null,
      merged.input ? JSON.stringify(merged.input) : null,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      updates.enabled !== void 0 ? updates.enabled ? 1 : 0 : null,
      merged.lastRunAt?.toISOString() ?? null,
      merged.lastRunId ?? null,
      merged.nextRunAt?.toISOString() ?? null,
      scheduleId
    );
  }
  async deleteSchedule(scheduleId) {
    this.stmts.delete.run(scheduleId);
  }
  // ============================================================================
  // Helper Methods
  // ============================================================================
  rowToSchedule(row) {
    return {
      id: row.id,
      workflowKind: row.workflow_kind,
      triggerType: row.trigger_type,
      cronExpression: row.cron_expression ?? void 0,
      timezone: row.timezone ?? void 0,
      triggerOnWorkflowKind: row.trigger_on_workflow_kind ?? void 0,
      triggerOnStatus: row.trigger_on_status ? JSON.parse(row.trigger_on_status) : void 0,
      input: row.input ? JSON.parse(row.input) : void 0,
      metadata: row.metadata ? JSON.parse(row.metadata) : void 0,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : void 0,
      lastRunId: row.last_run_id ?? void 0,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : void 0
    };
  }
};

// src/scheduler/postgres-persistence.ts
var Kysely;
var PostgresDialect;
var sql;
var pgModule;
var PostgresSchedulePersistence = class {
  db;
  pool;
  ownsPool = false;
  schema;
  tableName;
  autoMigrate;
  initialized = false;
  config;
  constructor(config) {
    this.schema = config.schema ?? "public";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.schema)) {
      throw new Error(
        `Invalid schema name "${this.schema}". Schema must start with a letter or underscore, contain only alphanumeric characters and underscores, and be at most 63 characters.`
      );
    }
    this.tableName = config.tableName ?? "workflow_schedules";
    this.autoMigrate = config.autoMigrate !== false;
    this.config = config;
  }
  /**
   * Get a schema-scoped query builder.
   * All queries MUST use this instead of this.db directly to respect config.schema.
   */
  get qb() {
    return this.db.withSchema(this.schema);
  }
  ensureInitialized() {
    if (!this.initialized) {
      throw new Error(
        "PostgresSchedulePersistence is not initialized. Call initialize() before using the adapter."
      );
    }
  }
  /**
   * Initialize the persistence layer.
   * Creates the schedules table if autoMigrate is enabled.
   */
  async initialize() {
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
        "PostgresSchedulePersistenceConfig must include either pool, connectionString, or poolConfig"
      );
    }
    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: this.pool
      })
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
  async close() {
    await this.db.destroy();
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
  // ============================================================================
  // Database Initialization
  // ============================================================================
  async createTables() {
    const fullTableName = this.schema === "public" ? this.tableName : `${this.schema}.${this.tableName}`;
    if (this.schema !== "public") {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);
    }
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
  async loadSchedules() {
    this.ensureInitialized();
    const rows = await this.qb.selectFrom(this.tableName).selectAll().execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  async saveSchedule(schedule) {
    this.ensureInitialized();
    await this.qb.insertInto(this.tableName).values({
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
      created_at: /* @__PURE__ */ new Date(),
      updated_at: /* @__PURE__ */ new Date()
    }).execute();
  }
  async updateSchedule(scheduleId, updates) {
    this.ensureInitialized();
    const existing = await this.qb.selectFrom(this.tableName).selectAll().where("id", "=", scheduleId).executeTakeFirst();
    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    const merged = {
      ...this.rowToSchedule(existing),
      ...updates
    };
    const fieldMappings = [
      { domainKey: "workflowKind", dbKey: "workflow_kind" },
      { domainKey: "triggerType", dbKey: "trigger_type" },
      { domainKey: "cronExpression", dbKey: "cron_expression" },
      { domainKey: "timezone", dbKey: "timezone" },
      { domainKey: "triggerOnWorkflowKind", dbKey: "trigger_on_workflow_kind" },
      { domainKey: "triggerOnStatus", dbKey: "trigger_on_status", serialize: (v) => v ? JSON.stringify(v) : null },
      { domainKey: "input", dbKey: "input_json", serialize: (v) => v ? JSON.stringify(v) : null },
      { domainKey: "metadata", dbKey: "metadata_json", serialize: (v) => v ? JSON.stringify(v) : null },
      { domainKey: "enabled", dbKey: "enabled" },
      { domainKey: "lastRunAt", dbKey: "last_run_at" },
      { domainKey: "lastRunId", dbKey: "last_run_id" },
      { domainKey: "nextRunAt", dbKey: "next_run_at" }
    ];
    const updateData = {
      updated_at: /* @__PURE__ */ new Date()
    };
    for (const { domainKey, dbKey, serialize } of fieldMappings) {
      if (updates[domainKey] !== void 0 || merged[domainKey] !== void 0) {
        const value = serialize ? serialize(merged[domainKey]) : merged[domainKey] ?? null;
        updateData[dbKey] = value;
      }
    }
    await this.qb.updateTable(this.tableName).set(updateData).where("id", "=", scheduleId).execute();
  }
  async deleteSchedule(scheduleId) {
    this.ensureInitialized();
    await this.qb.deleteFrom(this.tableName).where("id", "=", scheduleId).execute();
  }
  // ============================================================================
  // Additional Methods
  // ============================================================================
  /**
   * Get a schedule by ID.
   */
  async getSchedule(scheduleId) {
    this.ensureInitialized();
    const row = await this.qb.selectFrom(this.tableName).selectAll().where("id", "=", scheduleId).executeTakeFirst();
    return row ? this.rowToSchedule(row) : null;
  }
  /**
   * Get all enabled schedules that are due to run.
   */
  async getDueSchedules() {
    this.ensureInitialized();
    const now = /* @__PURE__ */ new Date();
    const rows = await this.qb.selectFrom(this.tableName).selectAll().where("enabled", "=", true).where("trigger_type", "=", "cron").where("next_run_at", "<=", now).execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  /**
   * Get schedules by workflow kind.
   */
  async getSchedulesByWorkflowKind(workflowKind) {
    this.ensureInitialized();
    const rows = await this.qb.selectFrom(this.tableName).selectAll().where("workflow_kind", "=", workflowKind).execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  /**
   * Get workflow completion triggers for a specific workflow kind.
   */
  async getCompletionTriggers(triggerOnWorkflowKind) {
    this.ensureInitialized();
    const rows = await this.qb.selectFrom(this.tableName).selectAll().where("enabled", "=", true).where("trigger_type", "=", "workflow_completed").where("trigger_on_workflow_kind", "=", triggerOnWorkflowKind).execute();
    return rows.map((row) => this.rowToSchedule(row));
  }
  // ============================================================================
  // Helper Methods
  // ============================================================================
  rowToSchedule(row) {
    return {
      id: row.id,
      workflowKind: row.workflow_kind,
      triggerType: row.trigger_type,
      cronExpression: row.cron_expression ?? void 0,
      timezone: row.timezone ?? void 0,
      triggerOnWorkflowKind: row.trigger_on_workflow_kind ?? void 0,
      triggerOnStatus: row.trigger_on_status ? typeof row.trigger_on_status === "string" ? JSON.parse(row.trigger_on_status) : row.trigger_on_status : void 0,
      input: row.input_json ? typeof row.input_json === "string" ? JSON.parse(row.input_json) : row.input_json : void 0,
      metadata: row.metadata_json ? typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json : void 0,
      enabled: row.enabled,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : void 0,
      lastRunId: row.last_run_id ?? void 0,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : void 0
    };
  }
};

export {
  CronScheduler,
  SQLiteSchedulePersistence,
  PostgresSchedulePersistence
};
//# sourceMappingURL=chunk-226JMLXO.js.map