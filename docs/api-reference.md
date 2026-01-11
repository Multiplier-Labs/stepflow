# Stepflow API Reference

A durable, type-safe workflow orchestration engine for Node.js with pluggable storage backends.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Storage Adapters](#storage-adapters)
- [Core Types](#core-types)
- [WorkflowEngine API](#workflowengine-api)
- [Storage Adapter API](#storage-adapter-api)
- [Scheduler API](#scheduler-api)
- [Events API](#events-api)

---

## Installation

```bash
npm install stepflow
```

### Peer Dependencies

Stepflow uses peer dependencies to keep the core lightweight. Install only what you need:

```bash
# For SQLite storage
npm install better-sqlite3

# For PostgreSQL storage
npm install pg kysely

# For Socket.IO events (optional)
npm install socket.io
```

---

## Quick Start

### 1. Create a Storage Adapter

Choose your storage backend:

```typescript
import { MemoryStorageAdapter } from 'stepflow';

// In-memory (for development/testing)
const storage = new MemoryStorageAdapter();
```

```typescript
import { SQLiteStorageAdapter } from 'stepflow';

// SQLite (for single-server deployments)
const storage = new SQLiteStorageAdapter({
  filename: './workflows.db',
});
```

```typescript
import { PostgresStorage } from 'stepflow';

// PostgreSQL (for production/distributed deployments)
const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow', // optional, defaults to 'public'
});
await storage.initialize(); // Creates tables automatically
```

### 2. Create the Workflow Engine

```typescript
import { WorkflowEngine } from 'stepflow';

const engine = new WorkflowEngine({
  storage,
  maxConcurrency: 5, // optional
});
```

### 3. Define and Register a Workflow

```typescript
engine.registerWorkflow({
  kind: 'order.process',
  name: 'Process Order',
  steps: [
    {
      key: 'validate',
      name: 'Validate Order',
      handler: async (ctx) => {
        const { orderId } = ctx.input;
        // Validate order...
        return { valid: true };
      },
    },
    {
      key: 'charge',
      name: 'Charge Payment',
      handler: async (ctx) => {
        const { valid } = ctx.results.validate;
        if (!valid) throw new Error('Invalid order');
        // Charge payment...
        return { chargeId: 'ch_123' };
      },
      onError: 'retry',
      maxRetries: 3,
    },
    {
      key: 'fulfill',
      name: 'Fulfill Order',
      handler: async (ctx) => {
        // Fulfill order...
        return { shipped: true };
      },
    },
  ],
});
```

### 4. Start a Workflow Run

```typescript
const runId = await engine.startRun({
  kind: 'order.process',
  input: { orderId: '12345' },
});

console.log(`Started workflow run: ${runId}`);
```

### 5. Subscribe to Events (Optional)

```typescript
engine.subscribeToRun(runId, (event) => {
  console.log(`${event.eventType}: ${event.stepKey ?? 'run'}`);
});
```

---

## Storage Adapters

### MemoryStorageAdapter

In-memory storage for development and testing. Data is lost when the process exits.

```typescript
import { MemoryStorageAdapter } from 'stepflow';

const storage = new MemoryStorageAdapter();

// Testing utilities
storage.clear(); // Clear all data
storage.getStats(); // { runs: 0, steps: 0, events: 0 }
```

### SQLiteStorageAdapter

SQLite-based persistent storage for single-server deployments.

```typescript
import { SQLiteStorageAdapter } from 'stepflow';

const storage = new SQLiteStorageAdapter({
  filename: './workflows.db', // or ':memory:' for in-memory SQLite
});
```

**Config Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filename` | `string` | required | Path to SQLite database file |

### PostgresStorage / PostgresStorageAdapter

PostgreSQL-based storage for production and distributed deployments.

```typescript
import { PostgresStorage } from 'stepflow';

// Option 1: Connection string
const storage = new PostgresStorage({
  connectionString: 'postgresql://user:pass@localhost:5432/dbname',
});

// Option 2: Share existing connection pool
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorage({ pool });

// Option 3: Pool config
const storage = new PostgresStorage({
  poolConfig: {
    host: 'localhost',
    port: 5432,
    database: 'myapp',
    user: 'user',
    password: 'pass',
  },
});

// Initialize (creates tables)
await storage.initialize();

// Close when done
await storage.close();
```

**Config Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | `string` | - | PostgreSQL connection URL |
| `pool` | `pg.Pool` | - | Existing connection pool to share |
| `poolConfig` | `pg.PoolConfig` | - | Pool configuration options |
| `schema` | `string` | `'public'` | Database schema for tables |
| `autoMigrate` | `boolean` | `true` | Auto-create tables on initialize |

**Tables Created:**

- `workflow_runs` - Workflow run state and metadata
- `workflow_run_steps` - Step execution results
- `workflow_events` - Workflow events

---

## Core Types

### WorkflowRunRecord

Stored representation of a workflow run.

```typescript
interface WorkflowRunRecord {
  id: string;
  kind: string;                      // Workflow type identifier
  status: RunStatus;                 // 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  parentRunId?: string;              // For child workflows
  input: Record<string, unknown>;    // Input data
  metadata: Record<string, unknown>; // Custom metadata
  context: Record<string, unknown>;  // Accumulated step results (checkpoint)
  error?: WorkflowError;             // Error details if failed
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}
```

### WorkflowRunStepRecord

Stored representation of a step execution.

```typescript
interface WorkflowRunStepRecord {
  id: string;
  runId: string;
  stepKey: string;
  stepName: string;
  status: StepStatus;        // 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  attempt: number;
  result?: unknown;          // Step output on success
  error?: WorkflowError;     // Error details if failed
  startedAt?: Date;
  finishedAt?: Date;
}
```

### WorkflowError

```typescript
interface WorkflowError {
  code: string;                       // Error code (required)
  message: string;                    // Error message (required)
  stack?: string;                     // Stack trace
  details?: Record<string, unknown>;  // Additional details
}
```

### PaginatedResult

```typescript
interface PaginatedResult<T> {
  items: T[];   // The results
  total: number;
  limit: number;
  offset: number;
}
```

---

## WorkflowEngine API

### Constructor

```typescript
const engine = new WorkflowEngine({
  storage: StorageAdapter,       // Required
  maxConcurrency?: number,       // Default: 10
  logger?: Logger,               // Custom logger
  eventTransport?: EventTransport,
});
```

### Methods

#### `registerWorkflow(definition)`

Register a workflow definition.

```typescript
engine.registerWorkflow({
  kind: 'email.send',
  name: 'Send Email',
  steps: [...],
  hooks?: {
    onStart?: (ctx) => void,
    onComplete?: (ctx, result) => void,
    onError?: (ctx, error) => void,
  },
});
```

#### `startRun(options)`

Start a new workflow run.

```typescript
const runId = await engine.startRun({
  kind: 'email.send',
  input: { to: 'user@example.com', subject: 'Hello' },
  metadata?: { userId: '123' },
});
```

#### `getRun(runId)`

Get a workflow run by ID.

```typescript
const run = await engine.getRun(runId);
// Returns: WorkflowRunRecord | null
```

#### `cancelRun(runId)`

Cancel a running workflow.

```typescript
await engine.cancelRun(runId);
```

#### `subscribeToRun(runId, callback)`

Subscribe to events for a specific run.

```typescript
const unsubscribe = engine.subscribeToRun(runId, (event) => {
  console.log(event.eventType, event.stepKey);
});

// Later: unsubscribe()
```

---

## Storage Adapter API

All storage adapters implement this interface:

### Run Operations

```typescript
// Create a new run
const run = await storage.createRun({
  kind: 'my.workflow',
  status: 'queued',
  input: { foo: 'bar' },
  metadata: {},
  context: {},
});

// Get a run by ID
const run = await storage.getRun(runId);
// Returns: WorkflowRunRecord | null

// Update a run
await storage.updateRun(runId, {
  status: 'running',
  startedAt: new Date(),
});

// List runs with filtering
const result = await storage.listRuns({
  kind?: 'my.workflow',
  status?: 'running',          // or ['queued', 'running']
  parentRunId?: string,
  limit?: 50,
  offset?: 0,
  orderBy?: 'createdAt',       // 'createdAt' | 'startedAt' | 'finishedAt'
  orderDirection?: 'desc',     // 'asc' | 'desc'
});
// Returns: PaginatedResult<WorkflowRunRecord>
// Access runs via: result.items
```

### Step Operations

```typescript
// Create a step record
const step = await storage.createStep({
  runId: 'run_123',
  stepKey: 'validate',
  stepName: 'Validate Input',
  status: 'pending',
  attempt: 1,
});

// Get a step by ID
const step = await storage.getStep(stepId);

// Update a step
await storage.updateStep(stepId, {
  status: 'succeeded',
  result: { valid: true },
  finishedAt: new Date(),
});

// Get all steps for a run
const steps = await storage.getStepsForRun(runId);
// Returns: WorkflowRunStepRecord[]
```

### Event Operations

```typescript
// Save an event
await storage.saveEvent({
  runId: 'run_123',
  stepKey: 'validate',      // optional
  eventType: 'step:started',
  level: 'info',            // 'info' | 'warn' | 'error'
  payload: { ... },         // optional
  timestamp: new Date(),
});

// Get events for a run
const events = await storage.getEventsForRun(runId, {
  stepKey?: 'validate',
  level?: 'error',
  limit?: 100,
  offset?: 0,
});
```

### PostgreSQL-Specific Methods

```typescript
// Initialize (create tables)
await storage.initialize();

// Close connection
await storage.close();

// Atomic dequeue for distributed workers
const run = await storage.dequeueRun(['my.workflow']);
// Returns: WorkflowRunRecord | null

// Get interrupted runs (for recovery)
const runs = await storage.getInterruptedRuns();

// Transaction support
await storage.transaction(async (tx) => {
  await tx.createRun({...});
  await tx.createStep({...});
});

// Cleanup old runs
const deleted = await storage.deleteOldRuns(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
);
```

---

## Scheduler API

### CronScheduler

Schedule workflows to run on a cron schedule.

```typescript
import { CronScheduler, PostgresSchedulePersistence } from 'stepflow';

// Create persistence (optional, for durable schedules)
const persistence = new PostgresSchedulePersistence({
  connectionString: process.env.DATABASE_URL,
});
await persistence.initialize();

// Create scheduler
const scheduler = new CronScheduler({
  engine,
  persistence, // optional
});

// Add a schedule
await scheduler.addSchedule({
  workflowKind: 'reports.daily',
  triggerType: 'cron',
  cronExpression: '0 9 * * *', // 9 AM daily
  timezone: 'America/New_York',
  input: { reportType: 'summary' },
  enabled: true,
});

// Start the scheduler
await scheduler.start();

// Stop when done
await scheduler.stop();
```

### PostgresSchedulePersistence

Persist schedules to PostgreSQL.

```typescript
import { PostgresSchedulePersistence } from 'stepflow';

const persistence = new PostgresSchedulePersistence({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow',        // optional
  tableName: 'workflow_schedules', // optional
});

await persistence.initialize();

// Methods
const schedules = await persistence.loadSchedules();
await persistence.saveSchedule(schedule);
await persistence.updateSchedule(id, updates);
await persistence.deleteSchedule(id);

await persistence.close();
```

---

## Events API

### Event Types

```typescript
type WorkflowEventType =
  | 'run:started'
  | 'run:completed'
  | 'run:failed'
  | 'run:canceled'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:retrying';
```

### Event Transports

#### MemoryEventTransport (default)

```typescript
import { MemoryEventTransport } from 'stepflow';

const transport = new MemoryEventTransport();
```

#### SocketIOEventTransport

```typescript
import { SocketIOEventTransport } from 'stepflow';
import { Server } from 'socket.io';

const io = new Server(httpServer);
const transport = new SocketIOEventTransport({ io });
```

#### WebhookEventTransport

```typescript
import { WebhookEventTransport } from 'stepflow';

const transport = new WebhookEventTransport({
  endpoints: [
    {
      url: 'https://example.com/webhook',
      events: ['run:completed', 'run:failed'],
      headers: { 'X-API-Key': 'secret' },
    },
  ],
});
```

---

## Common Patterns

### Integration with Existing Database

Share your application's connection pool with Stepflow:

```typescript
import pg from 'pg';
import { PostgresStorage } from 'stepflow';

// Your app's pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

// Share with Stepflow
const storage = new PostgresStorage({
  pool,
  schema: 'stepflow', // Keep tables organized
});

await storage.initialize();
```

### Creating Runs from API Endpoints

```typescript
// Fastify example
fastify.post('/workflows/:kind/runs', async (request, reply) => {
  const { kind } = request.params;
  const { input, metadata } = request.body;

  const run = await storage.createRun({
    kind,
    status: 'queued',
    input: input ?? {},
    metadata: metadata ?? {},
    context: {},
  });

  return { runId: run.id };
});
```

### Listing Runs with Pagination

```typescript
fastify.get('/workflows/runs', async (request, reply) => {
  const { kind, status, limit = 50, offset = 0 } = request.query;

  const result = await storage.listRuns({
    kind,
    status,
    limit: Number(limit),
    offset: Number(offset),
    orderBy: 'createdAt',
    orderDirection: 'desc',
  });

  return {
    data: result.items.map(r => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    })),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
});
```

### Getting Run Details with Steps

```typescript
fastify.get('/workflows/runs/:runId', async (request, reply) => {
  const { runId } = request.params;

  const run = await storage.getRun(runId);
  if (!run) {
    return reply.status(404).send({ error: 'Run not found' });
  }

  const steps = await storage.getStepsForRun(runId);

  return {
    ...run,
    steps: steps.map(s => ({
      stepKey: s.stepKey,
      stepName: s.stepName,
      status: s.status,
      result: s.result,
      error: s.error,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    })),
  };
});
```

### Updating Run Status

```typescript
// Mark as running
await storage.updateRun(runId, {
  status: 'running',
  startedAt: new Date(),
});

// Mark as succeeded
await storage.updateRun(runId, {
  status: 'succeeded',
  context: { result: 'success' },
  finishedAt: new Date(),
});

// Mark as failed
await storage.updateRun(runId, {
  status: 'failed',
  error: {
    code: 'STEP_FAILED',
    message: 'Payment processing failed',
  },
  finishedAt: new Date(),
});
```

---

## TypeScript Support

All types are exported and can be imported:

```typescript
import type {
  // Core types
  WorkflowKind,
  RunStatus,
  StepStatus,
  WorkflowError,
  WorkflowContext,
  WorkflowStep,
  WorkflowDefinition,

  // Storage types
  StorageAdapter,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  WorkflowEventRecord,
  ListRunsOptions,
  PaginatedResult,

  // Config types
  PostgresStorageConfig,
  SQLiteStorageConfig,
} from 'stepflow';
```

---

## Migration from SQLite to PostgreSQL

```typescript
import { SQLiteStorageAdapter, PostgresStorage } from 'stepflow';

async function migrate() {
  const sqlite = new SQLiteStorageAdapter({ filename: './workflows.db' });
  const postgres = new PostgresStorage({
    connectionString: process.env.DATABASE_URL,
  });

  await postgres.initialize();

  // Migrate all runs
  const { items: runs } = await sqlite.listRuns({ limit: 10000 });

  for (const run of runs) {
    await postgres.createRun(run);
    const steps = await sqlite.getStepsForRun(run.id);
    for (const step of steps) {
      await postgres.createStep(step);
    }
  }

  console.log(`Migrated ${runs.length} runs`);
  await postgres.close();
}
```
