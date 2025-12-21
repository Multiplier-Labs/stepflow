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

export {
  generateId,
  MemoryStorageAdapter,
  SQLiteStorageAdapter
};
//# sourceMappingURL=chunk-U2YEQGHB.js.map