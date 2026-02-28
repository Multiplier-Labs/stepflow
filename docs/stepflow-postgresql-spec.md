# Stepflow PostgreSQL Storage — Schema & Usage Reference

This document describes the PostgreSQL storage backend used by Stepflow (`@multiplier-labs/stepflow@^0.2.6`). PostgreSQL is the production storage backend, providing durable workflow persistence, atomic queue operations, and distributed worker support.

## Overview

The PostgreSQL storage backend enables:
- Shared database with the application (connection pooling)
- Distributed deployments with multiple workers (atomic dequeue via `FOR UPDATE SKIP LOCKED`)
- Schema isolation to avoid conflicts with application tables

## Import & Configuration

```typescript
import { PostgresStorage } from '@multiplier-labs/stepflow/storage';

const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow',      // Schema name (default: 'stepflow')
  autoMigrate: false,       // Set true for auto table creation, false for managed migrations
});

await storage.initialize();
```

### Sharing a Connection Pool

```typescript
import pg from 'pg';

// Application's existing pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

// Share with Stepflow — it will not close the pool on storage.close()
const storage = new PostgresStorage({ pool, schema: 'stepflow' });
```

### Configuration Options

```typescript
interface PostgresStorageConfig {
  connectionString?: string;    // PostgreSQL connection URL
  pool?: pg.Pool;               // Existing pg.Pool instance (for connection sharing)
  poolConfig?: pg.PoolConfig;   // Pool options (if not providing pool or connectionString)
  schema?: string;              // Schema name (default: 'stepflow')
  autoMigrate?: boolean;        // Auto-create tables on initialize() (default: true)
}
```

### Connection Pool Management

When a `pool` is provided, Stepflow does not own it and will not close it. When `connectionString` is provided, Stepflow creates and owns the pool internally:

```typescript
// Owns the pool — storage.close() will end the pool
new PostgresStorage({ connectionString: '...' });

// Does NOT own the pool — storage.close() leaves the pool open
new PostgresStorage({ pool: existingPool });
```

---

## Database Schema

### Schema Creation

```sql
CREATE SCHEMA IF NOT EXISTS stepflow;
```

### Table: stepflow.runs

Stores workflow run state and metadata. IDs are TEXT (nanoid strings), not UUIDs.

```sql
CREATE TABLE stepflow.runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_run_id TEXT REFERENCES stepflow.runs(id) ON DELETE SET NULL,
  input JSONB NOT NULL DEFAULT '{}',
  context JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  error JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- Stepflow v0.2.6 reads/writes _json columns internally
  input_json JSONB,
  output_json JSONB,
  context_json JSONB,
  metadata_json JSONB,
  error_json JSONB
);

-- Indexes
CREATE INDEX idx_runs_status ON stepflow.runs (status);
CREATE INDEX idx_runs_kind ON stepflow.runs (kind);
CREATE INDEX idx_runs_created_at ON stepflow.runs (created_at DESC);
CREATE INDEX idx_runs_parent ON stepflow.runs (parent_run_id);

-- Partial index for efficient queue processing
CREATE INDEX idx_runs_queue ON stepflow.runs (priority DESC, created_at ASC)
  WHERE status = 'queued';
```

**Valid statuses:** `'queued'`, `'running'`, `'succeeded'`, `'failed'`, `'canceled'`, `'timeout'`

**Note on `_json` columns:** Stepflow v0.2.6 internally reads and writes the `_json` variants (`input_json`, `output_json`, etc.). The non-suffixed columns (`input`, `output`, etc.) exist for backward compatibility. When querying directly, use `COALESCE(output_json, output)` to get the correct value.

### Table: stepflow.workflow_run_steps

Stores individual step results within a workflow run.

```sql
CREATE TABLE stepflow.workflow_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES stepflow.runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  result JSONB,
  error JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_workflow_run_steps_unique
  ON stepflow.workflow_run_steps (run_id, step_key);
CREATE INDEX idx_workflow_run_steps_run_id
  ON stepflow.workflow_run_steps (run_id);
```

**Valid statuses:** `'pending'`, `'running'`, `'succeeded'`, `'failed'`, `'skipped'`

**Key column differences from common assumptions:**
- Step output is stored in `result` (not `output`)
- Completion timestamp is `finished_at` (not `completed_at`)
- Steps are identified by `step_key` (not `step_name` — `step_name` holds the human-readable label)
- The unique constraint is on `(run_id, step_key)`, enabling upsert via `ON CONFLICT DO UPDATE`

### Table: stepflow.workflow_events (Optional)

Workflow audit/event log for detailed tracing.

```sql
CREATE TABLE stepflow.workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES stepflow.runs(id) ON DELETE CASCADE,
  step_key TEXT,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  payload JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_events_run_id ON stepflow.workflow_events (run_id);
CREATE INDEX idx_workflow_events_timestamp ON stepflow.workflow_events (timestamp);
```

**Valid levels:** `'info'`, `'warn'`, `'error'`

### Table: stepflow.schedules (Optional)

For cron-based schedule persistence. Not used in Erwin Analytics (scheduling is handled at the application level via `node-cron` and per-subsidiary `sync_schedule` fields).

```sql
CREATE TABLE stepflow.schedules (
  id TEXT PRIMARY KEY,
  workflow_kind TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  cron_expression TEXT,
  timezone TEXT DEFAULT 'UTC',
  trigger_on_workflow_kind TEXT,
  trigger_on_status TEXT[],
  input JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding due schedules
CREATE INDEX idx_schedules_due ON stepflow.schedules (next_run_at)
  WHERE enabled = true;
```

**Valid trigger types:** `'cron'`, `'workflow_completed'`

---

## Storage Interface

The `PostgresStorage` class implements the `WorkflowStorage` interface:

```typescript
class PostgresStorage implements WorkflowStorage {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Run operations
  createRun(run: CreateRunInput): Promise<WorkflowRunRecord>;
  getRun(id: string): Promise<WorkflowRunRecord | undefined>;
  updateRun(id: string, updates: UpdateRunInput): Promise<void>;
  listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
  deleteRun(id: string): Promise<void>;

  // Queue operations (atomic)
  dequeueRun(workflowKinds: string[]): Promise<WorkflowRunRecord | undefined>;
  cleanupStaleRuns(timeoutMs?: number): Promise<number>;
  markRunsAsFailed(runIds: string[], reason: string): Promise<void>;

  // Step operations
  saveStepResult(result: SaveStepResultInput): Promise<void>;
  getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
  getStepResults(runId: string): Promise<StepResult[]>;
  getStepsForRun(runId: string): Promise<StepRecord[]>;
}
```

---

## Atomic Dequeue

Critical for distributed workers. Uses `FOR UPDATE SKIP LOCKED` to atomically claim one queued run without blocking other workers:

```sql
UPDATE stepflow.runs
SET status = 'running', started_at = NOW()
WHERE id = (
  SELECT id FROM stepflow.runs
  WHERE status = 'queued' AND kind = ANY($1)
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

This ensures:
- Only one worker picks up each run (atomic claim)
- Higher priority runs are processed first
- FIFO ordering within same priority level
- No blocking between concurrent workers — `SKIP LOCKED` skips rows already claimed by other transactions

---

## Stale Run Cleanup

Marks runs as timed out if they've been running longer than their `timeout_ms` (or the provided default):

```sql
UPDATE stepflow.runs
SET status = 'timeout', finished_at = NOW()
WHERE status = 'running'
  AND started_at + (COALESCE(timeout_ms, $1) * interval '1 millisecond') < NOW();
```

Call periodically from the worker (e.g., every ~1 minute):

```typescript
const timedOutCount = await storage.cleanupStaleRuns(600_000); // 10 min default
```

---

## Schema Isolation

Custom schema names keep Stepflow tables separate from application tables:

```typescript
const storage = new PostgresStorage({
  connectionString: '...',
  schema: 'my_workflows',  // Tables: my_workflows.runs, my_workflows.workflow_run_steps, etc.
});
```

This is useful for:
- Multi-tenant deployments (separate schemas per tenant)
- Avoiding table name conflicts
- Organized database structure with `\dn` visibility in psql

---

## Migration Notes

### From Stepflow < 0.2.6

Stepflow v0.2.6 changed:
- **ID columns** from `UUID` to `TEXT` (nanoid strings)
- **Table names** from `workflow_runs` / `step_results` to `runs` / `workflow_run_steps`
- **Step columns** from `output` / `completed_at` to `result` / `finished_at`
- **Step columns** added `step_key` and `step_name` (previously just `step_name`)
- **Added** `_json` suffix columns (`input_json`, `output_json`, etc.) that the library reads/writes internally
- **Added** `parent_run_id` for nested/child workflow runs
- **Added** `context` column for step checkpointing

If upgrading from an earlier version, you'll need migrations to rename tables, alter column types, and add the new columns. See the Erwin-Analytics migration files `013` through `016` in `packages/db/src/migrations/` for a reference implementation of this upgrade path.

---

## Useful SQL Queries

```sql
-- View recent workflow runs
SELECT id, kind, status, created_at, started_at, finished_at,
       COALESCE(error_json, error) AS error
FROM stepflow.runs
ORDER BY created_at DESC
LIMIT 20;

-- View step results for a specific run
SELECT step_key, step_name, status, result, error, started_at, finished_at
FROM stepflow.workflow_run_steps
WHERE run_id = 'your-run-id'
ORDER BY started_at;

-- Count workflows by status
SELECT status, COUNT(*)
FROM stepflow.runs
GROUP BY status;

-- Queue depth
SELECT kind, COUNT(*) AS queued
FROM stepflow.runs
WHERE status = 'queued'
GROUP BY kind;

-- Find stale running workflows (running longer than 10 minutes)
SELECT id, kind, started_at, timeout_ms,
       EXTRACT(EPOCH FROM NOW() - started_at) / 60 AS running_minutes
FROM stepflow.runs
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';

-- Find all runs for a subsidiary
SELECT id, kind, status, created_at,
       COALESCE(output_json, output) AS output
FROM stepflow.runs
WHERE input->>'subsidiaryId' = 'your-subsidiary-id'
ORDER BY created_at DESC;
```

---

## Testing

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresStorage } from '@multiplier-labs/stepflow/storage';

describe('PostgresStorage', () => {
  let storage: PostgresStorage;

  beforeAll(async () => {
    storage = new PostgresStorage({
      connectionString: process.env.TEST_DATABASE_URL,
      schema: 'stepflow_test',
      autoMigrate: true,  // Auto-create tables for tests
    });
    await storage.initialize();
  });

  afterAll(async () => {
    await storage.close();
  });

  it('should create and retrieve a run', async () => {
    const run = await storage.createRun({
      kind: 'test.workflow',
      status: 'queued',
      input: { foo: 'bar' },
      context: {},
    });

    expect(run.id).toBeDefined();
    expect(run.kind).toBe('test.workflow');
    expect(run.status).toBe('queued');

    const retrieved = await storage.getRun(run.id);
    expect(retrieved).toEqual(run);
  });

  it('should atomically dequeue runs', async () => {
    await storage.createRun({ kind: 'test.workflow', status: 'queued', input: {}, context: {} });
    await storage.createRun({ kind: 'test.workflow', status: 'queued', input: {}, context: {} });

    // Dequeue should return one and atomically mark it running
    const dequeued = await storage.dequeueRun(['test.workflow']);
    expect(dequeued).toBeDefined();
    expect(dequeued!.status).toBe('running');
    expect(dequeued!.startedAt).toBeDefined();
  });

  it('should save and retrieve step results', async () => {
    const run = await storage.createRun({
      kind: 'test.workflow',
      status: 'running',
      input: {},
      context: {},
    });

    await storage.saveStepResult({
      runId: run.id,
      stepName: 'test.step',
      status: 'succeeded',
      output: { rowsRead: 10, rowsWritten: 10 },
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const steps = await storage.getStepResults(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepName).toBe('test.step');
    expect(steps[0].status).toBe('succeeded');
  });
});
```
