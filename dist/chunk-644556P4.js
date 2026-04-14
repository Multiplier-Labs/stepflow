import {
  generateId,
  loadPostgresDeps,
  sanitizeErrorForStorage
} from "./chunk-ML35PIHX.js";

// src/storage/memory.ts
var MemoryStorageAdapter = class {
  runs = /* @__PURE__ */ new Map();
  steps = /* @__PURE__ */ new Map();
  events = /* @__PURE__ */ new Map();
  // ============================================================================
  // Run Operations
  // ============================================================================
  /** Create and persist a new workflow run record. */
  async createRun(run) {
    const record = {
      ...run,
      id: generateId(),
      createdAt: /* @__PURE__ */ new Date()
    };
    this.runs.set(record.id, record);
    return record;
  }
  /** Retrieve a workflow run by ID, or null if not found. */
  async getRun(runId) {
    return this.runs.get(runId) ?? null;
  }
  /** Apply partial updates to an existing workflow run. No-op if the run does not exist. */
  async updateRun(runId, updates) {
    const run = this.runs.get(runId);
    if (run) {
      Object.assign(run, updates);
    }
  }
  /** List workflow runs with optional filtering, sorting, and pagination. */
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
  /** Create and persist a new step execution record. */
  async createStep(step) {
    const record = {
      ...step,
      id: generateId()
    };
    this.steps.set(record.id, record);
    return record;
  }
  /** Retrieve a step record by ID, or null if not found. */
  async getStep(stepId) {
    return this.steps.get(stepId) ?? null;
  }
  /** Apply partial updates to an existing step record. No-op if the step does not exist. */
  async updateStep(stepId, updates) {
    const step = this.steps.get(stepId);
    if (step) {
      Object.assign(step, updates);
    }
  }
  /** Retrieve all step records for a workflow run, ordered by start time ascending. */
  async getStepsForRun(runId) {
    return Array.from(this.steps.values()).filter((s) => s.runId === runId).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  }
  // ============================================================================
  // Event Operations
  // ============================================================================
  /** Persist a workflow event record. */
  async saveEvent(event) {
    const record = {
      ...event,
      id: generateId()
    };
    this.events.set(record.id, record);
  }
  /** Retrieve events for a workflow run with optional filtering and pagination. */
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
  /** Delete runs (and their associated steps and events) created before the given date. Returns the number of deleted runs. */
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
  completed_steps_json TEXT,
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
        INSERT INTO workflow_runs (id, kind, status, parent_run_id, input_json, metadata_json, context_json, completed_steps_json, error_json, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getRun: this.db.prepare(`
        SELECT * FROM workflow_runs WHERE id = ?
      `),
      updateRun: this.db.prepare(`
        UPDATE workflow_runs
        SET status = COALESCE(?, status),
            context_json = COALESCE(?, context_json),
            completed_steps_json = COALESCE(?, completed_steps_json),
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
      run.completedSteps ? JSON.stringify(run.completedSteps) : null,
      run.error ? JSON.stringify(sanitizeErrorForStorage(run.error)) : null,
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
      updates.completedSteps ? JSON.stringify(updates.completedSteps) : null,
      updates.error ? JSON.stringify(sanitizeErrorForStorage(updates.error)) : null,
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
      step.error ? JSON.stringify(sanitizeErrorForStorage(step.error)) : null,
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
      updates.error ? JSON.stringify(sanitizeErrorForStorage(updates.error)) : null,
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
   * @deprecated Use `transactionSync()` instead. This method only works when
   * the callback performs purely synchronous operations wrapped in async/await.
   * If the callback awaits real async I/O (network, timers, etc.), it will
   * throw an error. `transactionSync()` makes the synchronous requirement explicit.
   */
  async transaction(fn) {
    let fnPromise;
    this.transactionSync(() => {
      fnPromise = fn(this);
    });
    return fnPromise;
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
    const rows = this.stmts.getInterruptedRuns.all();
    return rows.map((row) => this.mapRunRow(row));
  }
  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId) {
    const row = this.stmts.getLastCompletedStep.get(runId);
    return row ? this.mapStepRow(row) : null;
  }
  // ============================================================================
  // Row Mapping
  // ============================================================================
  safeJsonParse(json, fallback = {}) {
    try {
      return JSON.parse(json);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn(`[SQLiteStorageAdapter] Corrupted JSON in database row, using fallback:`, error.message);
        return fallback;
      }
      throw error;
    }
  }
  mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentRunId: row.parent_run_id ?? void 0,
      input: this.safeJsonParse(row.input_json, {}),
      metadata: this.safeJsonParse(row.metadata_json, {}),
      context: this.safeJsonParse(row.context_json, {}),
      completedSteps: row.completed_steps_json ? this.safeJsonParse(row.completed_steps_json, void 0) : void 0,
      error: row.error_json ? this.safeJsonParse(row.error_json, void 0) : void 0,
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
      result: row.result_json ? this.safeJsonParse(row.result_json, void 0) : void 0,
      error: row.error_json ? this.safeJsonParse(row.error_json, void 0) : void 0,
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
      payload: row.payload_json ? this.safeJsonParse(row.payload_json, void 0) : void 0,
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
var Kysely;
var PostgresDialect;
var sql;
var pgModule;
function stripStack(error) {
  const { stack: _stack, ...rest } = error;
  return rest;
}
var PostgresStorageAdapter = class {
  db;
  pool;
  ownsPool = false;
  schema;
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
        "PostgresStorageAdapter is not initialized. Call initialize() before using the adapter."
      );
    }
  }
  /**
   * Initialize the storage adapter.
   * Creates tables if autoMigrate is enabled.
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
        "PostgresStorageConfig must include either pool, connectionString, or poolConfig"
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
    this.ensureInitialized();
    const id = "id" in run && run.id ? run.id : generateId();
    const createdAt = /* @__PURE__ */ new Date();
    await this.qb.insertInto("runs").values({
      id,
      kind: run.kind,
      status: run.status,
      parent_run_id: "parentRunId" in run ? run.parentRunId ?? null : null,
      input_json: JSON.stringify(run.input),
      metadata_json: JSON.stringify(run.metadata ?? {}),
      context_json: JSON.stringify(run.context ?? {}),
      // Default to empty object
      output_json: null,
      error_json: "error" in run && run.error ? JSON.stringify(sanitizeErrorForStorage(run.error)) : null,
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
    this.ensureInitialized();
    const row = await this.qb.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
    return row ? this.mapRunRow(row) : null;
  }
  /**
   * Update a workflow run.
   * Supports both legacy Partial<WorkflowRunRecord> and new UpdateRunInput interfaces.
   */
  async updateRun(runId, updates) {
    this.ensureInitialized();
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
      updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error));
    }
    if (updates.startedAt !== void 0) {
      updateData.started_at = updates.startedAt;
    }
    if (updates.finishedAt !== void 0) {
      updateData.finished_at = updates.finishedAt;
    }
    if (Object.keys(updateData).length > 0) {
      await this.qb.updateTable("runs").set(updateData).where("id", "=", runId).execute();
    }
  }
  /**
   * List workflow runs with filtering and pagination.
   */
  /**
   * Apply common run filters to a Kysely query builder.
   * Used by both the data query and count query in listRuns to avoid duplication.
   */
  applyRunsFilters(query, options) {
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
    return query;
  }
  async listRuns(options = {}) {
    this.ensureInitialized();
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    let query = this.applyRunsFilters(
      this.qb.selectFrom("runs").selectAll(),
      options
    );
    const countQuery = this.applyRunsFilters(
      this.qb.selectFrom("runs").select(sql`count(*)`.as("count")),
      options
    );
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
    this.ensureInitialized();
    const id = generateId();
    await this.qb.insertInto("workflow_run_steps").values({
      id,
      run_id: step.runId,
      step_key: step.stepKey,
      step_name: step.stepName,
      status: step.status,
      attempt: step.attempt,
      result_json: step.result !== void 0 ? JSON.stringify(step.result) : null,
      error_json: step.error ? JSON.stringify(sanitizeErrorForStorage(step.error)) : null,
      started_at: step.startedAt ?? null,
      finished_at: step.finishedAt ?? null
    }).execute();
    return { ...step, id };
  }
  async getStep(stepId) {
    this.ensureInitialized();
    const row = await this.qb.selectFrom("workflow_run_steps").selectAll().where("id", "=", stepId).executeTakeFirst();
    return row ? this.mapStepRow(row) : null;
  }
  async updateStep(stepId, updates) {
    this.ensureInitialized();
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
      updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error));
    }
    if (updates.finishedAt !== void 0) {
      updateData.finished_at = updates.finishedAt;
    }
    if (Object.keys(updateData).length > 0) {
      await this.qb.updateTable("workflow_run_steps").set(updateData).where("id", "=", stepId).execute();
    }
  }
  async getStepsForRun(runId) {
    this.ensureInitialized();
    const rows = await this.qb.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).orderBy("started_at", "asc").execute();
    return rows.map((row) => this.mapStepRow(row));
  }
  // ============================================================================
  // Event Operations
  // ============================================================================
  async saveEvent(event) {
    this.ensureInitialized();
    const id = generateId();
    await this.qb.insertInto("workflow_events").values({
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
    this.ensureInitialized();
    const limit = options.limit ?? 1e3;
    const offset = options.offset ?? 0;
    let query = this.qb.selectFrom("workflow_events").selectAll().where("run_id", "=", runId);
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
    this.ensureInitialized();
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
    this.ensureInitialized();
    const result = await this.qb.deleteFrom("runs").where("created_at", "<", olderThan).executeTakeFirst();
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
    this.ensureInitialized();
    const rows = await this.qb.selectFrom("runs").selectAll().where("status", "in", ["queued", "running"]).orderBy("created_at", "asc").execute();
    return rows.map((row) => this.mapRunRow(row));
  }
  /**
   * Get the last completed step for a run.
   * Useful for resuming from a checkpoint.
   */
  async getLastCompletedStep(runId) {
    this.ensureInitialized();
    const row = await this.qb.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).where("status", "=", "succeeded").orderBy("finished_at", "desc").limit(1).executeTakeFirst();
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
    this.ensureInitialized();
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
  safeJsonParse(json, fallback = {}) {
    try {
      return JSON.parse(json);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn(`[PostgresStorageAdapter] Corrupted JSON in database row, using fallback:`, error.message);
        return fallback;
      }
      throw error;
    }
  }
  safeParseField(value, fallback = {}) {
    if (typeof value === "string") {
      return this.safeJsonParse(value, fallback);
    }
    return value;
  }
  safeParseOptionalField(value) {
    if (!value) return void 0;
    if (typeof value === "string") {
      return this.safeJsonParse(value, void 0);
    }
    return value;
  }
  mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentRunId: row.parent_run_id ?? void 0,
      input: this.safeParseField(row.input_json, {}),
      context: this.safeParseField(row.context_json, {}),
      output: this.safeParseOptionalField(row.output_json),
      error: this.safeParseOptionalField(row.error_json),
      metadata: this.safeParseField(row.metadata_json, {}),
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
      input: this.safeParseField(row.input_json, {}),
      metadata: this.safeParseField(row.metadata_json, {}),
      context: this.safeParseField(row.context_json, {}),
      output: this.safeParseOptionalField(row.output_json),
      error: this.safeParseOptionalField(row.error_json),
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
      output: this.safeParseOptionalField(row.output_json),
      error: this.safeParseOptionalField(row.error_json),
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
      result: this.safeParseOptionalField(row.result_json),
      error: this.safeParseOptionalField(row.error_json),
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
      payload: this.safeParseOptionalField(row.payload_json),
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
    this.ensureInitialized();
    await this.qb.deleteFrom("runs").where("id", "=", id).execute();
  }
  /**
   * Cleanup stale runs that have exceeded their timeout.
   * Marks them as 'timeout' status with an appropriate error.
   *
   * @param defaultTimeoutMs - Default timeout in ms for runs without explicit timeout (default: 600000 = 10 minutes)
   * @returns Number of runs marked as timed out
   */
  async cleanupStaleRuns(defaultTimeoutMs = 6e5) {
    this.ensureInitialized();
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
    this.ensureInitialized();
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
    this.ensureInitialized();
    const row = await this.qb.selectFrom("stepflow_step_results").selectAll().where("run_id", "=", runId).where("step_name", "=", stepName).executeTakeFirst();
    return row ? this.mapStepResultRow(row) : void 0;
  }
  /**
   * Get all step results for a run.
   */
  async getStepResults(runId) {
    this.ensureInitialized();
    const rows = await this.qb.selectFrom("stepflow_step_results").selectAll().where("run_id", "=", runId).orderBy("started_at", "asc").execute();
    return rows.map((row) => this.mapStepResultRow(row));
  }
  /**
   * Save or update a step result.
   * Uses upsert to handle both new and existing results.
   */
  async saveStepResult(result) {
    this.ensureInitialized();
    const id = result.id ?? generateId();
    await this.qb.insertInto("stepflow_step_results").values({
      id,
      run_id: result.runId,
      step_name: result.stepName,
      status: result.status,
      output_json: result.output ? JSON.stringify(result.output) : null,
      error_json: result.error ? JSON.stringify(stripStack(result.error)) : null,
      attempt: result.attempt,
      started_at: result.startedAt ?? null,
      completed_at: result.completedAt ?? null
    }).onConflict(
      (oc) => oc.columns(["run_id", "step_name"]).doUpdateSet({
        status: result.status,
        output_json: result.output ? JSON.stringify(result.output) : null,
        error_json: result.error ? JSON.stringify(stripStack(result.error)) : null,
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
    this.ensureInitialized();
    const [runsCount, stepsCount, eventsCount] = await Promise.all([
      this.qb.selectFrom("runs").select(sql`count(*)`.as("count")).executeTakeFirst(),
      this.qb.selectFrom("workflow_run_steps").select(sql`count(*)`.as("count")).executeTakeFirst(),
      this.qb.selectFrom("workflow_events").select(sql`count(*)`.as("count")).executeTakeFirst()
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
    this.qb = trx.withSchema(schema);
  }
  qb;
  async createRun(run) {
    const id = "id" in run && run.id ? run.id : generateId();
    const createdAt = /* @__PURE__ */ new Date();
    await this.qb.insertInto("runs").values({
      id,
      kind: run.kind,
      status: run.status,
      parent_run_id: "parentRunId" in run ? run.parentRunId ?? null : null,
      input_json: JSON.stringify(run.input),
      metadata_json: JSON.stringify(run.metadata ?? {}),
      context_json: JSON.stringify(run.context ?? {}),
      output_json: null,
      error_json: "error" in run && run.error ? JSON.stringify(sanitizeErrorForStorage(run.error)) : null,
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
    const row = await this.qb.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
    return row ? this.mapRunRow(row) : null;
  }
  async updateRun(runId, updates) {
    const updateData = {};
    if (updates.status !== void 0) updateData.status = updates.status;
    if (updates.context !== void 0) updateData.context_json = JSON.stringify(updates.context);
    if ("output" in updates && updates.output !== void 0) updateData.output_json = JSON.stringify(updates.output);
    if (updates.error !== void 0) updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error));
    if (updates.startedAt !== void 0) updateData.started_at = updates.startedAt;
    if (updates.finishedAt !== void 0) updateData.finished_at = updates.finishedAt;
    if (Object.keys(updateData).length > 0) {
      await this.qb.updateTable("runs").set(updateData).where("id", "=", runId).execute();
    }
  }
  async listRuns(options = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    let query = this.qb.selectFrom("runs").selectAll();
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
    await this.qb.insertInto("workflow_run_steps").values({
      id,
      run_id: step.runId,
      step_key: step.stepKey,
      step_name: step.stepName,
      status: step.status,
      attempt: step.attempt,
      result_json: step.result !== void 0 ? JSON.stringify(step.result) : null,
      error_json: step.error ? JSON.stringify(sanitizeErrorForStorage(step.error)) : null,
      started_at: step.startedAt ?? null,
      finished_at: step.finishedAt ?? null
    }).execute();
    return { ...step, id };
  }
  async getStep(stepId) {
    const row = await this.qb.selectFrom("workflow_run_steps").selectAll().where("id", "=", stepId).executeTakeFirst();
    return row ? this.mapStepRow(row) : null;
  }
  async updateStep(stepId, updates) {
    const updateData = {};
    if (updates.status !== void 0) updateData.status = updates.status;
    if (updates.attempt !== void 0) updateData.attempt = updates.attempt;
    if (updates.result !== void 0) updateData.result_json = JSON.stringify(updates.result);
    if (updates.error !== void 0) updateData.error_json = JSON.stringify(sanitizeErrorForStorage(updates.error));
    if (updates.finishedAt !== void 0) updateData.finished_at = updates.finishedAt;
    if (Object.keys(updateData).length > 0) {
      await this.qb.updateTable("workflow_run_steps").set(updateData).where("id", "=", stepId).execute();
    }
  }
  async getStepsForRun(runId) {
    const rows = await this.qb.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).orderBy("started_at", "asc").execute();
    return rows.map((row) => this.mapStepRow(row));
  }
  async saveEvent(event) {
    const id = generateId();
    await this.qb.insertInto("workflow_events").values({
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
    let query = this.qb.selectFrom("workflow_events").selectAll().where("run_id", "=", runId);
    if (options.stepKey) query = query.where("step_key", "=", options.stepKey);
    if (options.level) query = query.where("level", "=", options.level);
    const rows = await query.orderBy("timestamp", "asc").limit(options.limit ?? 1e3).offset(options.offset ?? 0).execute();
    return rows.map((row) => this.mapEventRow(row));
  }
  safeJsonParse(json, fallback = {}) {
    try {
      return JSON.parse(json);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn(`[PostgresTransactionAdapter] Corrupted JSON in database row, using fallback:`, error.message);
        return fallback;
      }
      throw error;
    }
  }
  safeParseField(value, fallback = {}) {
    if (typeof value === "string") {
      return this.safeJsonParse(value, fallback);
    }
    return value;
  }
  safeParseOptionalField(value) {
    if (!value) return void 0;
    if (typeof value === "string") {
      return this.safeJsonParse(value, void 0);
    }
    return value;
  }
  mapRunRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      parentRunId: row.parent_run_id ?? void 0,
      input: this.safeParseField(row.input_json, {}),
      context: this.safeParseField(row.context_json, {}),
      output: this.safeParseOptionalField(row.output_json),
      error: this.safeParseOptionalField(row.error_json),
      metadata: this.safeParseField(row.metadata_json, {}),
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
      result: this.safeParseOptionalField(row.result_json),
      error: this.safeParseOptionalField(row.error_json),
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
      payload: this.safeParseOptionalField(row.payload_json),
      timestamp: new Date(row.timestamp)
    };
  }
};

export {
  MemoryStorageAdapter,
  SQLiteStorageAdapter,
  PostgresStorageAdapter
};
//# sourceMappingURL=chunk-644556P4.js.map