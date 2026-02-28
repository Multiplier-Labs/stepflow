# Stepflow PostgreSQL Storage Adapter - Specification

This document specifies how to add PostgreSQL support to Stepflow as an alternative storage backend alongside SQLite.

## Overview

Add PostgreSQL as a production-ready storage backend, enabling:
- Shared database with application (connection pooling)
- Distributed deployments with multiple workers
- Better integration with existing PostgreSQL infrastructure

## File Locations

Based on the existing Stepflow structure, add these files:

```
src/
├── storage/
│   ├── index.ts           # Exports PostgresStorageAdapter
│   ├── memory.ts          # MemoryStorageAdapter
│   ├── sqlite.ts          # SQLiteStorageAdapter
│   ├── postgres.ts        # PostgresStorageAdapter
│   └── types.ts           # StorageAdapter interface and types
├── scheduler/
│   └── postgres-persistence.ts  # PostgresSchedulePersistence
```

## New Exports

Update `src/index.ts`:

```typescript
// Storage backends
export { MemoryStorageAdapter } from './storage/memory';
export { SQLiteStorageAdapter } from './storage/sqlite';
export { PostgresStorageAdapter, PostgresStorageAdapter as PostgresStorage, type PostgresStorageConfig } from './storage/postgres';

// Schedule persistence
export { PostgresSchedulePersistence } from './scheduler/postgres-persistence';
```

## Dependencies

Update `package.json`:

```json
{
  "dependencies": {
    "cron-parser": "^4.9.0"
  },
  "peerDependencies": {
    "better-sqlite3": ">=9.0.0",
    "kysely": ">=0.27.0",
    "pg": ">=8.11.0"
  },
  "peerDependenciesMeta": {
    "better-sqlite3": { "optional": true },
    "kysely": { "optional": true },
    "pg": { "optional": true }
  }
}
```

**Note:** `pg` and `kysely` are optional peer dependencies. They are loaded dynamically at runtime only when `PostgresStorage.initialize()` is called, so users of other storage backends are not affected.

---

## PostgresStorage API

### Constructor

```typescript
interface PostgresStorageConfig {
  /**
   * PostgreSQL connection string
   * Example: "postgresql://user:pass@localhost:5432/dbname"
   */
  connectionString?: string;

  /**
   * Existing pg.Pool instance for connection sharing with application
   */
  pool?: pg.Pool;

  /**
   * Pool configuration options (if not providing pool or connectionString)
   */
  poolConfig?: pg.PoolConfig;

  /**
   * Schema name for Stepflow tables
   * @default 'public'
   */
  schema?: string;

  /**
   * Automatically create tables on initialize()
   * @default true
   */
  autoMigrate?: boolean;
}

const storage = new PostgresStorageAdapter({
  connectionString: process.env.DATABASE_URL,
  schema: 'workflows',  // Optional custom schema
});
```

### Usage Example

```typescript
import { WorkflowEngine, PostgresStorageAdapter } from 'stepflow';

const storage = new PostgresStorageAdapter({
  connectionString: 'postgresql://localhost:5432/myapp',
});

const engine = new WorkflowEngine({
  storage,
  settings: {
    maxConcurrency: 5,
  },
});

await engine.initialize();
```

### Sharing Connection Pool

```typescript
import pg from 'pg';
import { PostgresStorageAdapter } from 'stepflow';

// Application's existing pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

// Share with Stepflow
const storage = new PostgresStorageAdapter({ pool });
```

---

## Database Schema

### Schema Creation

```sql
CREATE SCHEMA IF NOT EXISTS stepflow;
```

### Table: stepflow.runs

Stores workflow run state and metadata.

```sql
CREATE TABLE stepflow.runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  error JSONB,
  priority INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  CONSTRAINT runs_status_check CHECK (
    status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timeout')
  )
);

-- Indexes
CREATE INDEX idx_runs_status ON stepflow.runs (status);
CREATE INDEX idx_runs_kind ON stepflow.runs (kind);
CREATE INDEX idx_runs_created_at ON stepflow.runs (created_at DESC);

-- Partial index for efficient queue processing
CREATE INDEX idx_runs_queue ON stepflow.runs (priority DESC, created_at ASC)
  WHERE status = 'queued';
```

### Table: stepflow.step_results

Stores individual step results for crash recovery and resumption.

```sql
CREATE TABLE stepflow.step_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES stepflow.runs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  output JSONB,
  error JSONB,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  CONSTRAINT step_results_unique UNIQUE (run_id, step_name),
  CONSTRAINT step_results_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'skipped')
  )
);

CREATE INDEX idx_step_results_run_id ON stepflow.step_results (run_id);
```

### Table: stepflow.schedules (Optional)

For CronScheduler persistence.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT schedules_trigger_type_check CHECK (
    trigger_type IN ('cron', 'workflow_completed')
  )
);

-- Index for finding due schedules
CREATE INDEX idx_schedules_due ON stepflow.schedules (next_run_at)
  WHERE enabled = true;
```

---

## Storage Interface Implementation

The `PostgresStorage` class must implement the existing `WorkflowStorage` interface from `src/storage/types.ts`.

### Key Methods

```typescript
class PostgresStorageAdapter implements StorageAdapter {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Run operations
  createRun(input: CreateRunInput): Promise<WorkflowRunRecord>;
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  updateRun(id: string, updates: UpdateRunInput): Promise<void>;
  listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
  deleteOldRuns(before: Date): Promise<number>;

  // Atomic dequeue for concurrency control
  dequeueRun(workflowKinds?: string[]): Promise<WorkflowRunRecord | null>;

  // Step operations
  createStep(input: CreateStepInput): Promise<WorkflowRunStepRecord>;
  getStep(id: string): Promise<WorkflowRunStepRecord | null>;
  updateStep(id: string, updates: UpdateStepInput): Promise<void>;
  getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;

  // Event operations
  saveEvent(event: WorkflowEventRecord): Promise<void>;
  getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;
}
```

### Atomic Dequeue Implementation

Critical for distributed workers - use `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE stepflow.runs
SET status = 'running', started_at = NOW()
WHERE id = (
  SELECT id FROM stepflow.runs
  WHERE status = 'queued' AND kind = ANY($1::text[])
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Note:** Use `ANY($1::text[])` for array parameters in PostgreSQL. This ensures proper type casting when passing string arrays.

This ensures:
- Only one worker picks up each run
- Higher priority runs are processed first
- FIFO ordering within same priority
- No blocking between workers

---

## Implementation Notes

### Using Kysely

Recommend using Kysely for type-safe queries:

```typescript
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const db = new Kysely<StepflowDatabase>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString }),
  }),
});
```

**Note:** The library uses dynamic `import()` internally to load `pg` and `kysely` on demand. Consumer code can import `pg` using any style that suits their setup.

### JSONB for Flexibility

Use JSONB columns for `input`, `output`, and `error` to handle arbitrary workflow data without schema changes.

### Connection Pool Management

```typescript
class PostgresStorageAdapter {
  private pool: pg.Pool;
  private ownsPool: boolean;

  constructor(config: PostgresStorageConfig) {
    if (config.pool) {
      this.pool = config.pool;
      this.ownsPool = false;  // Don't close on destroy
    } else {
      this.pool = new pg.Pool({ connectionString: config.connectionString });
      this.ownsPool = true;   // Close on destroy
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
```

### Schema Isolation

Support custom schema names for:
- Multi-tenant deployments
- Avoiding conflicts with application tables
- Organized database structure

```typescript
const storage = new PostgresStorageAdapter({
  connectionString: '...',
  schema: 'my_workflows',  // Tables created as my_workflows.runs, etc.
});
```

---

## Testing

Add tests in `src/storage/postgres.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresStorageAdapter } from './postgres';

describe('PostgresStorageAdapter', () => {
  let storage: PostgresStorageAdapter;

  beforeAll(async () => {
    storage = new PostgresStorageAdapter({
      connectionString: process.env.TEST_DATABASE_URL,
      schema: 'stepflow_test',
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
    });

    expect(run.id).toBeDefined();
    expect(run.kind).toBe('test.workflow');
    expect(run.status).toBe('queued');

    const retrieved = await storage.getRun(run.id);
    expect(retrieved).toEqual(run);
  });

  it('should atomically dequeue runs', async () => {
    // Create multiple queued runs
    await storage.createRun({ kind: 'test.workflow', status: 'queued', input: {} });
    await storage.createRun({ kind: 'test.workflow', status: 'queued', input: {} });

    // Dequeue should return one and mark it running
    const dequeued = await storage.dequeueRun(['test.workflow']);
    expect(dequeued).toBeDefined();
    expect(dequeued!.status).toBe('running');
  });

  // ... more tests
});
```

---

## Migration from SQLite

For users migrating from SQLite to PostgreSQL:

```typescript
import { SQLiteStorageAdapter, PostgresStorageAdapter } from 'stepflow';

async function migrate() {
  const sqlite = new SQLiteStorageAdapter({ filename: './workflows.db' });
  const postgres = new PostgresStorageAdapter({ connectionString: '...' });

  await postgres.initialize();

  // Get all runs from SQLite
  const { runs } = await sqlite.listRuns({ limit: 10000 });

  // Insert into PostgreSQL
  for (const run of runs) {
    await postgres.createRun(run);
    const steps = await sqlite.getStepResults(run.id);
    for (const step of steps) {
      await postgres.saveStepResult(step);
    }
  }

  console.log(`Migrated ${runs.length} workflow runs`);
}
```

---

## Reference Implementation

A reference implementation is available in the Erwin-Analytics repository:
- `packages/stepflow-pg/src/storage.ts` - PostgresStorage class
- `packages/stepflow-pg/src/schedule-persistence.ts` - PostgresSchedulePersistence class
- `packages/stepflow-pg/src/types.ts` - TypeScript interfaces

This code can be copied directly into the Stepflow repository with minimal modifications.
