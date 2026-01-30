// src/utils/id.ts
function generateId() {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${randomPart}`;
}

// src/storage/memory.ts
var MemoryStorageAdapter = class {
  runs = /* @__PURE__ */ new Map();
  steps = /* @__PURE__ */ new Map();
  events = /* @__PURE__ */ new Map();
  // ============================================================================
  // Run Operations
  // ============================================================================
  async createRun(run) {
    const record = {
      ...run,
      id: generateId(),
      createdAt: /* @__PURE__ */ new Date()
    };
    this.runs.set(record.id, record);
    return record;
  }
  async getRun(runId) {
    return this.runs.get(runId) ?? null;
  }
  async updateRun(runId, updates) {
    const run = this.runs.get(runId);
    if (run) {
      Object.assign(run, updates);
    }
  }
  async listRuns(options = {}) {
    let items = Array.from(this.runs.values());
    if (options.kind) {
      items = items.filter((r) => r.kind === options.kind);
    }
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      items = items.filter((r) => statuses.includes(r.status));
    }
    if (options.parentRunId !== void 0) {
      items = items.filter((r) => r.parentRunId === options.parentRunId);
    }
    const orderBy = options.orderBy ?? "createdAt";
    const direction = options.orderDirection ?? "desc";
    items.sort((a, b) => {
      const aVal = a[orderBy]?.getTime() ?? 0;
      const bVal = b[orderBy]?.getTime() ?? 0;
      return direction === "asc" ? aVal - bVal : bVal - aVal;
    });
    const total = items.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    items = items.slice(offset, offset + limit);
    return { items, total, limit, offset };
  }
  // ============================================================================
  // Step Operations
  // ============================================================================
  async createStep(step) {
    const record = {
      ...step,
      id: generateId()
    };
    this.steps.set(record.id, record);
    return record;
  }
  async getStep(stepId) {
    return this.steps.get(stepId) ?? null;
  }
  async updateStep(stepId, updates) {
    const step = this.steps.get(stepId);
    if (step) {
      Object.assign(step, updates);
    }
  }
  async getStepsForRun(runId) {
    return Array.from(this.steps.values()).filter((s) => s.runId === runId).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  }
  // ============================================================================
  // Event Operations
  // ============================================================================
  async saveEvent(event) {
    const record = {
      ...event,
      id: generateId()
    };
    this.events.set(record.id, record);
  }
  async getEventsForRun(runId, options = {}) {
    let items = Array.from(this.events.values()).filter((e) => e.runId === runId);
    if (options.stepKey) {
      items = items.filter((e) => e.stepKey === options.stepKey);
    }
    if (options.level) {
      items = items.filter((e) => e.level === options.level);
    }
    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return items.slice(offset, offset + limit);
  }
  // ============================================================================
  // Optional Operations
  // ============================================================================
  async deleteOldRuns(olderThan) {
    let deleted = 0;
    for (const [id, run] of this.runs) {
      if (run.createdAt < olderThan) {
        for (const [stepId, step] of this.steps) {
          if (step.runId === id) {
            this.steps.delete(stepId);
          }
        }
        for (const [eventId, event] of this.events) {
          if (event.runId === id) {
            this.events.delete(eventId);
          }
        }
        this.runs.delete(id);
        deleted++;
      }
    }
    return deleted;
  }
  // ============================================================================
  // Testing Utilities
  // ============================================================================
  /**
   * Clear all stored data. Useful for testing.
   */
  clear() {
    this.runs.clear();
    this.steps.clear();
    this.events.clear();
  }
  /**
   * Get counts of stored records. Useful for testing.
   */
  getStats() {
    return {
      runs: this.runs.size,
      steps: this.steps.size,
      events: this.events.size
    };
  }
};

// src/storage/sqlite.ts
var CREATE_TABLES_SQL = `
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
var SQLiteStorageAdapter = class {
  db;
  prefix;
  // Prepared statements (cached for performance)
  stmts = null;
  constructor(config) {
    this.db = config.db;
    this.prefix = config.tablePrefix ?? "workflow";
    this.db.pragma("foreign_keys = ON");
    if (config.autoCreateTables !== false) {
      this.createTables();
    }
    this.prepareStatements();
  }
  /**
   * Create the workflow tables if they don't exist.
   */
  createTables() {
    this.db.exec(CREATE_TABLES_SQL);
  }
  /**
   * Prepare all SQL statements for better performance.
   */
  prepareStatements() {
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
      `)
    };
  }
  // ============================================================================
  // Run Operations
  // ============================================================================
  async createRun(run) {
    const id = generateId();
    const createdAt = /* @__PURE__ */ new Date();
    this.stmts.insertRun.run(
      id,
      run.kind,
      run.status,
      run.parentRunId ?? null,
      JSON.stringify(run.input),
      JSON.stringify(run.metadata),
      JSON.stringify(run.context),
      run.error ? JSON.stringify(run.error) : null,
      createdAt.toISOString(),
      run.startedAt?.toISOString() ?? null,
      run.finishedAt?.toISOString() ?? null
    );
    return {
      ...run,
      id,
      createdAt
    };
  }
  async getRun(runId) {
    const row = this.stmts.getRun.get(runId);
    return row ? this.mapRunRow(row) : null;
  }
  async updateRun(runId, updates) {
    this.stmts.updateRun.run(
      updates.status ?? null,
      updates.context ? JSON.stringify(updates.context) : null,
      updates.error ? JSON.stringify(updates.error) : null,
      updates.startedAt?.toISOString() ?? null,
      updates.finishedAt?.toISOString() ?? null,
      runId
    );
  }
  async listRuns(options = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const kind = options.kind ?? null;
    const status = options.status ?? null;
    const statusJson = status ? JSON.stringify(Array.isArray(status) ? status : [status]) : null;
    const parentRunId = options.parentRunId ?? null;
    const rows = this.stmts.listRuns.all(
      kind,
      kind,
      statusJson,
      statusJson,
      parentRunId,
      parentRunId,
      limit,
      offset
    );
    const countResult = this.stmts.countRuns.get(
      kind,
      kind,
      statusJson,
      statusJson,
      parentRunId,
      parentRunId
    );
    return {
      items: rows.map((row) => this.mapRunRow(row)),
      total: countResult.count,
      limit,
      offset
    };
  }
  // ============================================================================
  // Step Operations
  // ============================================================================
  async createStep(step) {
    const id = generateId();
    this.stmts.insertStep.run(
      id,
      step.runId,
      step.stepKey,
      step.stepName,
      step.status,
      step.attempt,
      step.result !== void 0 ? JSON.stringify(step.result) : null,
      step.error ? JSON.stringify(step.error) : null,
      step.startedAt?.toISOString() ?? null,
      step.finishedAt?.toISOString() ?? null
    );
    return { ...step, id };
  }
  async getStep(stepId) {
    const row = this.stmts.getStep.get(stepId);
    return row ? this.mapStepRow(row) : null;
  }
  async updateStep(stepId, updates) {
    this.stmts.updateStep.run(
      updates.status ?? null,
      updates.attempt ?? null,
      updates.result !== void 0 ? JSON.stringify(updates.result) : null,
      updates.error ? JSON.stringify(updates.error) : null,
      updates.finishedAt?.toISOString() ?? null,
      stepId
    );
  }
  async getStepsForRun(runId) {
    const rows = this.stmts.getStepsForRun.all(runId);
    return rows.map((row) => this.mapStepRow(row));
  }
  // ============================================================================
  // Event Operations
  // ============================================================================
  async saveEvent(event) {
    const id = generateId();
    this.stmts.insertEvent.run(
      id,
      event.runId,
      event.stepKey ?? null,
      event.eventType,
      event.level,
      event.payload !== void 0 ? JSON.stringify(event.payload) : null,
      event.timestamp.toISOString()
    );
  }
  async getEventsForRun(runId, options = {}) {
    const limit = options.limit ?? 1e3;
    const offset = options.offset ?? 0;
    const stepKey = options.stepKey ?? null;
    const level = options.level ?? null;
    const rows = this.stmts.getEventsForRun.all(
      runId,
      stepKey,
      stepKey,
      level,
      level,
      limit,
      offset
    );
    return rows.map((row) => this.mapEventRow(row));
  }
  // ============================================================================
  // Transaction Support
  // ============================================================================
  /**
   * Execute a function within a database transaction (async interface).
   *
   * Note: better-sqlite3 uses synchronous transactions internally.
   * For best results, use transactionSync() directly.
   * This async version is provided for interface compatibility but
   * the callback must not contain actual async operations.
   */
  async transaction(fn) {
    return this.transactionSync(() => {
      let result = void 0;
      let error;
      const promise = fn(this);
      promise.then((r) => {
        result = r;
      }).catch((e) => {
        error = e;
      });
      if (error) throw error;
      if (result === void 0 && !promise) {
        throw new Error("Transaction callback must use synchronous operations only");
      }
      return result;
    });
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
  transactionSync(fn) {
    return this.db.transaction(fn)();
  }
  // ============================================================================
  // Cleanup Operations
  // ============================================================================
  /**
   * Delete runs older than the specified date.
   * Also deletes associated steps and events (via CASCADE).
   */
  async deleteOldRuns(olderThan) {
    const isoDate = olderThan.toISOString();
    return this.db.transaction(() => {
      this.stmts.deleteEventsForRuns.run(isoDate);
      this.stmts.deleteStepsForRuns.run(isoDate);
      const result = this.stmts.deleteOldRuns.run(isoDate);
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
  async getInterruptedRuns() {
    const stmt = this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all();
    return rows.map((row) => this.mapRunRow(row));
  }
  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId) {
    const stmt = this.db.prepare(`
      SELECT * FROM workflow_run_steps
      WHERE run_id = ? AND status = 'succeeded'
      ORDER BY finished_at DESC
      LIMIT 1
    `);
    const row = stmt.get(runId);
    return row ? this.mapStepRow(row) : null;
  }
  // ============================================================================
  // Row Mapping
  // ============================================================================
  mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentRunId: row.parent_run_id ?? void 0,
      input: JSON.parse(row.input_json),
      metadata: JSON.parse(row.metadata_json),
      context: JSON.parse(row.context_json),
      error: row.error_json ? JSON.parse(row.error_json) : void 0,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  mapStepRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status,
      attempt: row.attempt,
      result: row.result_json ? JSON.parse(row.result_json) : void 0,
      error: row.error_json ? JSON.parse(row.error_json) : void 0,
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  mapEventRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? void 0,
      eventType: row.event_type,
      level: row.level,
      payload: row.payload_json ? JSON.parse(row.payload_json) : void 0,
      timestamp: new Date(row.timestamp)
    };
  }
  // ============================================================================
  // Utility Methods
  // ============================================================================
  /**
   * Close the database connection.
   */
  close() {
    this.db.close();
  }
  /**
   * Get database statistics.
   */
  getStats() {
    const runsCount = this.db.prepare("SELECT COUNT(*) as count FROM workflow_runs").get();
    const stepsCount = this.db.prepare("SELECT COUNT(*) as count FROM workflow_run_steps").get();
    const eventsCount = this.db.prepare("SELECT COUNT(*) as count FROM workflow_events").get();
    return {
      runs: runsCount.count,
      steps: stepsCount.count,
      events: eventsCount.count
    };
  }
};

// src/storage/postgres.ts
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
var PostgresStorageAdapter = class {
  db;
  pool;
  ownsPool;
  schema;
  autoMigrate;
  initialized = false;
  constructor(config) {
    this.schema = config.schema ?? "public";
    this.autoMigrate = config.autoMigrate !== false;
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
        "PostgresStorageConfig must include either pool, connectionString, or poolConfig"
      );
    }
    this.db = new Kysely({
      dialect: new PostgresDialect({
        pool: this.pool
      })
    });
  }
  /**
   * Initialize the storage adapter.
   * Creates tables if autoMigrate is enabled.
   */
  async initialize() {
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
  async close() {
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
  async createTables() {
    if (this.schema !== "public") {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);
    }
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.runs`)} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        input_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        context_json JSONB NOT NULL DEFAULT '{}',
        output_json JSONB,
        error_json JSONB,
        priority INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT runs_status_check CHECK (
          status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timeout')
        )
      )
    `.execute(this.db);
    await sql`
      ALTER TABLE ${sql.table(`${this.schema}.runs`)}
      ADD COLUMN IF NOT EXISTS output_json JSONB,
      ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS timeout_ms INTEGER
    `.execute(this.db).catch(() => {
    });
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_kind_status
      ON ${sql.table(`${this.schema}.runs`)} (kind, status)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_parent
      ON ${sql.table(`${this.schema}.runs`)} (parent_run_id)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_created
      ON ${sql.table(`${this.schema}.runs`)} (created_at DESC)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_status
      ON ${sql.table(`${this.schema}.runs`)} (status)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runs_priority
      ON ${sql.table(`${this.schema}.runs`)} (priority DESC, created_at ASC)
    `.execute(this.db);
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_run_steps`)} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.runs`)} (id) ON DELETE CASCADE,
        step_key TEXT NOT NULL,
        step_name TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        result_json JSONB,
        error_json JSONB,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT workflow_run_steps_status_check CHECK (
          status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'completed')
        )
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run
      ON ${sql.table(`${this.schema}.workflow_run_steps`)} (run_id)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_key
      ON ${sql.table(`${this.schema}.workflow_run_steps`)} (run_id, step_key)
    `.execute(this.db);
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.stepflow_step_results`)} (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.runs`)} (id) ON DELETE CASCADE,
        step_name TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json JSONB,
        error_json JSONB,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        CONSTRAINT stepflow_step_results_status_check CHECK (
          status IN ('pending', 'running', 'completed', 'failed', 'skipped')
        ),
        UNIQUE (run_id, step_name)
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_stepflow_step_results_run
      ON ${sql.table(`${this.schema}.stepflow_step_results`)} (run_id)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_stepflow_step_results_run_name
      ON ${sql.table(`${this.schema}.stepflow_step_results`)} (run_id, step_name)
    `.execute(this.db);
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(`${this.schema}.workflow_events`)} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${sql.table(`${this.schema}.runs`)} (id) ON DELETE CASCADE,
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
  /**
   * Create a new workflow run.
   * Supports both legacy and new CreateRunInput interfaces.
   */
  async createRun(run) {
    const id = "id" in run && run.id ? run.id : generateId();
    const createdAt = /* @__PURE__ */ new Date();
    await this.db.insertInto("runs").values({
      id,
      kind: run.kind,
      status: run.status,
      parent_run_id: "parentRunId" in run ? run.parentRunId ?? null : null,
      input_json: JSON.stringify(run.input),
      metadata_json: JSON.stringify(run.metadata ?? {}),
      context_json: JSON.stringify(run.context ?? {}),
      // Default to empty object
      output_json: null,
      error_json: "error" in run && run.error ? JSON.stringify(run.error) : null,
      priority: "priority" in run ? run.priority ?? 0 : 0,
      timeout_ms: "timeoutMs" in run ? run.timeoutMs ?? null : null,
      created_at: createdAt,
      started_at: null,
      finished_at: null
    }).execute();
    return {
      id,
      kind: run.kind,
      status: run.status,
      parentRunId: "parentRunId" in run ? run.parentRunId : void 0,
      input: run.input,
      context: run.context ?? {},
      output: void 0,
      error: void 0,
      metadata: run.metadata ?? {},
      priority: "priority" in run ? run.priority ?? 0 : 0,
      timeoutMs: "timeoutMs" in run ? run.timeoutMs : void 0,
      createdAt
    };
  }
  async getRun(runId) {
    const row = await this.db.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
    return row ? this.mapRunRow(row) : null;
  }
  /**
   * Update a workflow run.
   * Supports both legacy Partial<WorkflowRunRecord> and new UpdateRunInput interfaces.
   */
  async updateRun(runId, updates) {
    const updateData = {};
    if (updates.status !== void 0) {
      updateData.status = updates.status;
    }
    if (updates.context !== void 0) {
      updateData.context_json = JSON.stringify(updates.context);
    }
    if ("output" in updates && updates.output !== void 0) {
      updateData.output_json = JSON.stringify(updates.output);
    }
    if (updates.error !== void 0) {
      updateData.error_json = JSON.stringify(updates.error);
    }
    if (updates.startedAt !== void 0) {
      updateData.started_at = updates.startedAt;
    }
    if (updates.finishedAt !== void 0) {
      updateData.finished_at = updates.finishedAt;
    }
    if (Object.keys(updateData).length > 0) {
      await this.db.updateTable("runs").set(updateData).where("id", "=", runId).execute();
    }
  }
  /**
   * List workflow runs with filtering and pagination.
   */
  async listRuns(options = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    let query = this.db.selectFrom("runs").selectAll();
    if (options.kind) {
      query = query.where("kind", "=", options.kind);
    }
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      query = query.where("status", "in", statuses);
    }
    if (options.parentRunId !== void 0) {
      query = query.where("parent_run_id", "=", options.parentRunId);
    }
    let countQuery = this.db.selectFrom("runs").select(sql`count(*)`.as("count"));
    if (options.kind) {
      countQuery = countQuery.where("kind", "=", options.kind);
    }
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      countQuery = countQuery.where("status", "in", statuses);
    }
    if (options.parentRunId !== void 0) {
      countQuery = countQuery.where("parent_run_id", "=", options.parentRunId);
    }
    const countResult = await countQuery.executeTakeFirst();
    const total = Number(countResult?.count ?? 0);
    const orderBy = options.orderBy ?? "createdAt";
    const orderDirection = options.orderDirection ?? "desc";
    const orderColumn = orderBy === "createdAt" ? "created_at" : orderBy === "startedAt" ? "started_at" : "finished_at";
    query = query.orderBy(orderColumn, orderDirection);
    query = query.limit(limit).offset(offset);
    const rows = await query.execute();
    return {
      items: rows.map((row) => this.mapRunRow(row)),
      total
    };
  }
  // ============================================================================
  // Step Operations
  // ============================================================================
  async createStep(step) {
    const id = generateId();
    await this.db.insertInto("workflow_run_steps").values({
      id,
      run_id: step.runId,
      step_key: step.stepKey,
      step_name: step.stepName,
      status: step.status,
      attempt: step.attempt,
      result_json: step.result !== void 0 ? JSON.stringify(step.result) : null,
      error_json: step.error ? JSON.stringify(step.error) : null,
      started_at: step.startedAt ?? null,
      finished_at: step.finishedAt ?? null
    }).execute();
    return { ...step, id };
  }
  async getStep(stepId) {
    const row = await this.db.selectFrom("workflow_run_steps").selectAll().where("id", "=", stepId).executeTakeFirst();
    return row ? this.mapStepRow(row) : null;
  }
  async updateStep(stepId, updates) {
    const updateData = {};
    if (updates.status !== void 0) {
      updateData.status = updates.status;
    }
    if (updates.attempt !== void 0) {
      updateData.attempt = updates.attempt;
    }
    if (updates.result !== void 0) {
      updateData.result_json = JSON.stringify(updates.result);
    }
    if (updates.error !== void 0) {
      updateData.error_json = JSON.stringify(updates.error);
    }
    if (updates.finishedAt !== void 0) {
      updateData.finished_at = updates.finishedAt;
    }
    if (Object.keys(updateData).length > 0) {
      await this.db.updateTable("workflow_run_steps").set(updateData).where("id", "=", stepId).execute();
    }
  }
  async getStepsForRun(runId) {
    const rows = await this.db.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).orderBy("started_at", "asc").execute();
    return rows.map((row) => this.mapStepRow(row));
  }
  // ============================================================================
  // Event Operations
  // ============================================================================
  async saveEvent(event) {
    const id = generateId();
    await this.db.insertInto("workflow_events").values({
      id,
      run_id: event.runId,
      step_key: event.stepKey ?? null,
      event_type: event.eventType,
      level: event.level,
      payload_json: event.payload !== void 0 ? JSON.stringify(event.payload) : null,
      timestamp: event.timestamp
    }).execute();
  }
  async getEventsForRun(runId, options = {}) {
    const limit = options.limit ?? 1e3;
    const offset = options.offset ?? 0;
    let query = this.db.selectFrom("workflow_events").selectAll().where("run_id", "=", runId);
    if (options.stepKey) {
      query = query.where("step_key", "=", options.stepKey);
    }
    if (options.level) {
      query = query.where("level", "=", options.level);
    }
    query = query.orderBy("timestamp", "asc").limit(limit).offset(offset);
    const rows = await query.execute();
    return rows.map((row) => this.mapEventRow(row));
  }
  // ============================================================================
  // Transaction Support
  // ============================================================================
  /**
   * Execute a function within a database transaction.
   */
  async transaction(fn) {
    return await this.db.transaction().execute(async (trx) => {
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
  async deleteOldRuns(olderThan) {
    const result = await this.db.deleteFrom("runs").where("created_at", "<", olderThan).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
  // ============================================================================
  // Resume Support
  // ============================================================================
  /**
   * Get all runs that were interrupted (status is 'running' or 'queued').
   * These runs can potentially be resumed.
   */
  async getInterruptedRuns() {
    const rows = await this.db.selectFrom("runs").selectAll().where("status", "in", ["queued", "running"]).orderBy("created_at", "asc").execute();
    return rows.map((row) => this.mapRunRow(row));
  }
  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId) {
    const row = await this.db.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).where("status", "=", "succeeded").orderBy("finished_at", "desc").limit(1).executeTakeFirst();
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
  async dequeueRun(workflowKinds) {
    const kindFilter = workflowKinds && workflowKinds.length > 0 ? sql`AND kind = ANY(${workflowKinds}::text[])` : sql``;
    const result = await sql`
      UPDATE ${sql.table(`${this.schema}.runs`)}
      SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM ${sql.table(`${this.schema}.runs`)}
        WHERE status = 'queued' ${kindFilter}
        ORDER BY priority DESC, created_at ASC
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
  mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentRunId: row.parent_run_id ?? void 0,
      input: typeof row.input_json === "string" ? JSON.parse(row.input_json) : row.input_json,
      context: typeof row.context_json === "string" ? JSON.parse(row.context_json) : row.context_json,
      output: row.output_json ? typeof row.output_json === "string" ? JSON.parse(row.output_json) : row.output_json : void 0,
      error: row.error_json ? typeof row.error_json === "string" ? JSON.parse(row.error_json) : row.error_json : void 0,
      metadata: typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json,
      priority: row.priority ?? 0,
      timeoutMs: row.timeout_ms ?? void 0,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  /**
   * Map a database row to an extended workflow run record.
   */
  mapExtendedRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      input: typeof row.input_json === "string" ? JSON.parse(row.input_json) : row.input_json,
      metadata: typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json,
      context: typeof row.context_json === "string" ? JSON.parse(row.context_json) : row.context_json,
      output: row.output_json ? typeof row.output_json === "string" ? JSON.parse(row.output_json) : row.output_json : void 0,
      error: row.error_json ? typeof row.error_json === "string" ? JSON.parse(row.error_json) : row.error_json : void 0,
      priority: row.priority ?? 0,
      timeoutMs: row.timeout_ms ?? void 0,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  mapStepResultRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepName: row.step_name,
      status: row.status,
      output: row.output_json ? typeof row.output_json === "string" ? JSON.parse(row.output_json) : row.output_json : void 0,
      error: row.error_json ? typeof row.error_json === "string" ? JSON.parse(row.error_json) : row.error_json : void 0,
      attempt: row.attempt,
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      completedAt: row.completed_at ? new Date(row.completed_at) : void 0
    };
  }
  mapStepRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status,
      attempt: row.attempt,
      result: row.result_json ? typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json : void 0,
      error: row.error_json ? typeof row.error_json === "string" ? JSON.parse(row.error_json) : row.error_json : void 0,
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  mapEventRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? void 0,
      eventType: row.event_type,
      level: row.level,
      payload: row.payload_json ? typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json : void 0,
      timestamp: new Date(row.timestamp)
    };
  }
  // ============================================================================
  // New WorkflowStorage Methods
  // ============================================================================
  /**
   * Delete a workflow run by ID.
   * Also deletes associated steps and events (via CASCADE).
   */
  async deleteRun(id) {
    await this.db.deleteFrom("runs").where("id", "=", id).execute();
  }
  /**
   * Cleanup stale runs that have exceeded their timeout.
   * Marks them as 'timeout' status with an appropriate error.
   *
   * @param defaultTimeoutMs - Default timeout in ms for runs without explicit timeout (default: 600000 = 10 minutes)
   * @returns Number of runs marked as timed out
   */
  async cleanupStaleRuns(defaultTimeoutMs = 6e5) {
    const result = await sql`
      UPDATE ${sql.table(`${this.schema}.runs`)}
      SET
        status = 'timeout',
        error_json = jsonb_build_object(
          'code', 'WORKFLOW_TIMEOUT',
          'message', 'Workflow exceeded maximum execution time and was marked as timed out'
        ),
        finished_at = NOW()
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND (
          (timeout_ms IS NOT NULL AND started_at < NOW() - (timeout_ms || ' milliseconds')::interval)
          OR
          (timeout_ms IS NULL AND started_at < NOW() - (${defaultTimeoutMs} || ' milliseconds')::interval)
        )
      RETURNING id
    `.execute(this.db);
    return result.rows.length;
  }
  /**
   * Mark multiple runs as failed with a given reason.
   * Useful for cleanup when a worker shuts down unexpectedly.
   *
   * @param runIds - Array of run IDs to mark as failed
   * @param reason - Reason message for the failure
   */
  async markRunsAsFailed(runIds, reason) {
    if (runIds.length === 0) return;
    await sql`
      UPDATE ${sql.table(`${this.schema}.runs`)}
      SET
        status = 'failed',
        error_json = jsonb_build_object(
          'code', 'WORKER_SHUTDOWN',
          'message', ${reason}
        ),
        finished_at = NOW()
      WHERE id = ANY(${runIds})
        AND status = 'running'
    `.execute(this.db);
  }
  /**
   * Get a specific step result by run ID and step name.
   */
  async getStepResult(runId, stepName) {
    const row = await this.db.selectFrom("stepflow_step_results").selectAll().where("run_id", "=", runId).where("step_name", "=", stepName).executeTakeFirst();
    return row ? this.mapStepResultRow(row) : void 0;
  }
  /**
   * Get all step results for a run.
   */
  async getStepResults(runId) {
    const rows = await this.db.selectFrom("stepflow_step_results").selectAll().where("run_id", "=", runId).orderBy("started_at", "asc").execute();
    return rows.map((row) => this.mapStepResultRow(row));
  }
  /**
   * Save or update a step result.
   * Uses upsert to handle both new and existing results.
   */
  async saveStepResult(result) {
    const id = result.id ?? generateId();
    await this.db.insertInto("stepflow_step_results").values({
      id,
      run_id: result.runId,
      step_name: result.stepName,
      status: result.status,
      output_json: result.output ? JSON.stringify(result.output) : null,
      error_json: result.error ? JSON.stringify(result.error) : null,
      attempt: result.attempt,
      started_at: result.startedAt ?? null,
      completed_at: result.completedAt ?? null
    }).onConflict(
      (oc) => oc.columns(["run_id", "step_name"]).doUpdateSet({
        status: result.status,
        output_json: result.output ? JSON.stringify(result.output) : null,
        error_json: result.error ? JSON.stringify(result.error) : null,
        attempt: result.attempt,
        started_at: result.startedAt ?? null,
        completed_at: result.completedAt ?? null
      })
    ).execute();
  }
  // ============================================================================
  // Utility Methods
  // ============================================================================
  /**
   * Get database statistics.
   */
  async getStats() {
    const [runsCount, stepsCount, eventsCount] = await Promise.all([
      this.db.selectFrom("runs").select(sql`count(*)`.as("count")).executeTakeFirst(),
      this.db.selectFrom("workflow_run_steps").select(sql`count(*)`.as("count")).executeTakeFirst(),
      this.db.selectFrom("workflow_events").select(sql`count(*)`.as("count")).executeTakeFirst()
    ]);
    return {
      runs: Number(runsCount?.count ?? 0),
      steps: Number(stepsCount?.count ?? 0),
      events: Number(eventsCount?.count ?? 0)
    };
  }
};
var PostgresTransactionAdapter = class {
  constructor(trx, schema) {
    this.trx = trx;
    this.schema = schema;
  }
  async createRun(run) {
    const id = "id" in run && run.id ? run.id : generateId();
    const createdAt = /* @__PURE__ */ new Date();
    await this.trx.insertInto("runs").values({
      id,
      kind: run.kind,
      status: run.status,
      parent_run_id: "parentRunId" in run ? run.parentRunId ?? null : null,
      input_json: JSON.stringify(run.input),
      metadata_json: JSON.stringify(run.metadata ?? {}),
      context_json: JSON.stringify(run.context ?? {}),
      output_json: null,
      error_json: "error" in run && run.error ? JSON.stringify(run.error) : null,
      priority: "priority" in run ? run.priority ?? 0 : 0,
      timeout_ms: "timeoutMs" in run ? run.timeoutMs ?? null : null,
      created_at: createdAt,
      started_at: null,
      finished_at: null
    }).execute();
    return {
      id,
      kind: run.kind,
      status: run.status,
      parentRunId: "parentRunId" in run ? run.parentRunId : void 0,
      input: run.input,
      context: run.context ?? {},
      output: void 0,
      error: void 0,
      metadata: run.metadata ?? {},
      priority: "priority" in run ? run.priority ?? 0 : 0,
      timeoutMs: "timeoutMs" in run ? run.timeoutMs : void 0,
      createdAt
    };
  }
  async getRun(runId) {
    const row = await this.trx.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
    return row ? this.mapRunRow(row) : null;
  }
  async updateRun(runId, updates) {
    const updateData = {};
    if (updates.status !== void 0) updateData.status = updates.status;
    if (updates.context !== void 0) updateData.context_json = JSON.stringify(updates.context);
    if ("output" in updates && updates.output !== void 0) updateData.output_json = JSON.stringify(updates.output);
    if (updates.error !== void 0) updateData.error_json = JSON.stringify(updates.error);
    if (updates.startedAt !== void 0) updateData.started_at = updates.startedAt;
    if (updates.finishedAt !== void 0) updateData.finished_at = updates.finishedAt;
    if (Object.keys(updateData).length > 0) {
      await this.trx.updateTable("runs").set(updateData).where("id", "=", runId).execute();
    }
  }
  async listRuns(options = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    let query = this.trx.selectFrom("runs").selectAll();
    if (options.kind) query = query.where("kind", "=", options.kind);
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      query = query.where("status", "in", statuses);
    }
    if (options.parentRunId !== void 0) {
      query = query.where("parent_run_id", "=", options.parentRunId);
    }
    const orderColumn = (options.orderBy ?? "createdAt") === "createdAt" ? "created_at" : options.orderBy === "startedAt" ? "started_at" : "finished_at";
    const orderDirection = options.orderDirection ?? "desc";
    query = query.orderBy(orderColumn, orderDirection).limit(limit).offset(offset);
    const rows = await query.execute();
    return {
      items: rows.map((row) => this.mapRunRow(row)),
      total: rows.length
      // Simplified for transaction context
    };
  }
  async createStep(step) {
    const id = generateId();
    await this.trx.insertInto("workflow_run_steps").values({
      id,
      run_id: step.runId,
      step_key: step.stepKey,
      step_name: step.stepName,
      status: step.status,
      attempt: step.attempt,
      result_json: step.result !== void 0 ? JSON.stringify(step.result) : null,
      error_json: step.error ? JSON.stringify(step.error) : null,
      started_at: step.startedAt ?? null,
      finished_at: step.finishedAt ?? null
    }).execute();
    return { ...step, id };
  }
  async getStep(stepId) {
    const row = await this.trx.selectFrom("workflow_run_steps").selectAll().where("id", "=", stepId).executeTakeFirst();
    return row ? this.mapStepRow(row) : null;
  }
  async updateStep(stepId, updates) {
    const updateData = {};
    if (updates.status !== void 0) updateData.status = updates.status;
    if (updates.attempt !== void 0) updateData.attempt = updates.attempt;
    if (updates.result !== void 0) updateData.result_json = JSON.stringify(updates.result);
    if (updates.error !== void 0) updateData.error_json = JSON.stringify(updates.error);
    if (updates.finishedAt !== void 0) updateData.finished_at = updates.finishedAt;
    if (Object.keys(updateData).length > 0) {
      await this.trx.updateTable("workflow_run_steps").set(updateData).where("id", "=", stepId).execute();
    }
  }
  async getStepsForRun(runId) {
    const rows = await this.trx.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).orderBy("started_at", "asc").execute();
    return rows.map((row) => this.mapStepRow(row));
  }
  async saveEvent(event) {
    const id = generateId();
    await this.trx.insertInto("workflow_events").values({
      id,
      run_id: event.runId,
      step_key: event.stepKey ?? null,
      event_type: event.eventType,
      level: event.level,
      payload_json: event.payload !== void 0 ? JSON.stringify(event.payload) : null,
      timestamp: event.timestamp
    }).execute();
  }
  async getEventsForRun(runId, options = {}) {
    let query = this.trx.selectFrom("workflow_events").selectAll().where("run_id", "=", runId);
    if (options.stepKey) query = query.where("step_key", "=", options.stepKey);
    if (options.level) query = query.where("level", "=", options.level);
    const rows = await query.orderBy("timestamp", "asc").limit(options.limit ?? 1e3).offset(options.offset ?? 0).execute();
    return rows.map((row) => this.mapEventRow(row));
  }
  mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentRunId: row.parent_run_id ?? void 0,
      input: typeof row.input_json === "string" ? JSON.parse(row.input_json) : row.input_json,
      context: typeof row.context_json === "string" ? JSON.parse(row.context_json) : row.context_json,
      output: row.output_json ? typeof row.output_json === "string" ? JSON.parse(row.output_json) : row.output_json : void 0,
      error: row.error_json ? typeof row.error_json === "string" ? JSON.parse(row.error_json) : row.error_json : void 0,
      metadata: typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json,
      priority: row.priority ?? 0,
      timeoutMs: row.timeout_ms ?? void 0,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  mapStepRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      stepName: row.step_name,
      status: row.status,
      attempt: row.attempt,
      result: row.result_json ? typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json : void 0,
      error: row.error_json ? typeof row.error_json === "string" ? JSON.parse(row.error_json) : row.error_json : void 0,
      startedAt: row.started_at ? new Date(row.started_at) : void 0,
      finishedAt: row.finished_at ? new Date(row.finished_at) : void 0
    };
  }
  mapEventRow(row) {
    return {
      id: row.id,
      runId: row.run_id,
      stepKey: row.step_key ?? void 0,
      eventType: row.event_type,
      level: row.level,
      payload: row.payload_json ? typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json : void 0,
      timestamp: new Date(row.timestamp)
    };
  }
};

export {
  generateId,
  MemoryStorageAdapter,
  SQLiteStorageAdapter,
  PostgresStorageAdapter
};
//# sourceMappingURL=chunk-QWJVJ22L.js.map