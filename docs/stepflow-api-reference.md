# Stepflow Implementation Guide

A durable, type-safe workflow orchestration engine for tracking asynchronous data synchronization tasks in Erwin Analytics.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Setup](#project-setup)
- [Core Concepts](#core-concepts)
- [PostgresStorage API](#postgresstorage-api)
- [Creating Workflows](#creating-workflows)
- [Step Tracking Utilities](#step-tracking-utilities)
- [API Integration](#api-integration)
- [Worker Service](#worker-service)
- [Adding New Workflows](#adding-new-workflows)
- [Monitoring and Debugging](#monitoring-and-debugging)

---

## Overview

Stepflow provides a PostgreSQL-backed job queue system with granular step tracking for the Erwin Analytics platform. It enables:

- **Durable workflow execution** - Workflows persist across process restarts
- **Granular step tracking** - Each workflow step is tracked individually
- **Atomic dequeue** - Safe concurrent processing by multiple workers
- **Real-time monitoring** - Track workflow and step progress in the UI
- **Timeout management** - Automatic cleanup of stale workflows

### How It's Used in Erwin Analytics

Stepflow tracks data synchronization workflows from external accounting systems (Xero, Directo):

1. **API** queues workflows when users trigger manual syncs
2. **Worker** picks up queued workflows and executes them
3. **Sync adapters** record step-by-step progress as they sync entities
4. **Frontend** displays workflow status and step results

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend (Web App)                        │
│  - Displays workflow runs and step results                          │
│  - Triggers manual syncs via API                                    │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           API Server (Fastify)                      │
│  - stepflowPlugin: Queues workflows, lists runs                     │
│  - /api/sync/trigger/:id → queueWorkflow()                          │
│  - /api/sync/workflows → listRuns()                                 │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌──────────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   PostgreSQL         │    │   Worker Service │    │  Sync Adapters  │
│   stepflow schema    │◄───┤   - Polls queue  │───►│  - Xero         │
│   - runs             │    │   - Executes     │    │  - Directo      │
│   - step_results     │    │   - Updates      │    │  - Records steps│
└──────────────────────┘    └──────────────────┘    └─────────────────┘
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `stepflow` package | `/packages/stepflow/` | Core storage implementation |
| Stepflow plugin | `/apps/api/src/plugins/stepflow.ts` | Fastify plugin for API |
| Worker service | `/apps/worker/src/index.ts` | Background job processor |
| Sync workflow utils | `/packages/shared/src/sync-workflow.ts` | Step tracking utilities |
| Sync adapters | `/packages/xero-adapter/`, `/packages/directo-adapter/` | Data sync implementations |

---

## Project Setup

### 1. Database Migrations

Stepflow requires PostgreSQL tables in the `stepflow` schema. These are created via the `@erwin/db` migration system.

**Migration files:**
- `002_stepflow_schema.ts` - Creates core tables and indexes
- `005_add_stepflow_runs_context.ts` - Adds context column
- `006_add_stepflow_runs_remaining_columns.ts` - Adds output, error, priority, timeout columns

Run migrations:

```bash
cd packages/db
pnpm db:migrate
```

### 2. Package Dependencies

The `stepflow` package has these dependencies:

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

**Note:** `pg` and `kysely` are optional peer dependencies. They are loaded dynamically at runtime only when `PostgresStorageAdapter.initialize()` is called, so users of other storage backends are not affected.

Build the package:

```bash
cd packages/stepflow
pnpm build
```

### 3. Environment Variables

Required for both API and Worker services:

```bash
# PostgreSQL connection string (required)
DATABASE_URL=postgresql://user:pass@localhost:5432/erwin

# Worker-specific settings
SYNC_SCHEDULE="0 6 * * *"  # Cron for scheduled syncs (default: 6 AM UTC)
POLL_INTERVAL=5000          # Queue polling interval in ms (default: 5000)
SYNC_ON_STARTUP=false       # Run sync immediately on worker start
```

### 4. Register Fastify Plugin

In your API server setup:

```typescript
import { stepflowPlugin } from './plugins/stepflow.js';

// Register after database plugin
await server.register(stepflowPlugin);

// Now available as fastify.stepflow
await fastify.stepflow.queueWorkflow('sync.xero', { subsidiaryId });
```

### 5. Start Worker Service

```bash
cd apps/worker
pnpm start
```

The worker will:
- Initialize Stepflow storage
- Schedule daily syncs via cron
- Poll for manual sync requests every 5 seconds

---

## Core Concepts

### Workflow Run

A workflow run represents a single execution of a workflow (e.g., syncing Xero data for a subsidiary).

```typescript
interface WorkflowRunRecord {
  id: string;                                    // UUID
  kind: string;                                  // Workflow type (e.g., 'sync.xero')
  status: RunStatus;                             // Current state
  parentRunId?: string;                          // Parent workflow run ID (for child workflows)
  input: Record<string, unknown>;                // Workflow parameters
  context: Record<string, unknown>;              // Accumulated step results
  output?: Record<string, unknown>;              // Final workflow output
  error?: { code: string; message: string };     // Error details if failed
  metadata?: Record<string, unknown>;            // Custom metadata
  priority?: number;                             // Queue priority (higher = processed first)
  timeoutMs?: number;                            // Execution timeout in milliseconds
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}
```

### Run Status

```typescript
type RunStatus =
  | 'pending'      // Initial state (rarely used)
  | 'queued'       // Waiting to be picked up by worker
  | 'running'      // Currently executing
  | 'succeeded'    // Completed successfully
  | 'failed'       // Execution failed
  | 'canceled'     // Manually canceled
  | 'timeout';     // Exceeded timeout duration
```

### Step Result

Each step within a workflow is tracked individually:

```typescript
interface StepResult {
  id: string;
  runId: string;                         // Parent workflow run ID
  stepName: string;                      // Step identifier (e.g., 'xero.accounts')
  status: StepStatus;                    // 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  output?: Record<string, unknown>;      // Step output (e.g., { rowsRead, rowsWritten })
  error?: Record<string, unknown>;       // Error details if failed
  attempt: number;                       // Attempt counter
  startedAt?: Date;
  completedAt?: Date;
}
```

### Workflow Kinds

Workflow kinds are string identifiers that categorize workflows:

```typescript
const WORKFLOW_KINDS = {
  XERO_SYNC: 'sync.xero',           // Xero accounting data sync
  DIRECTO_SYNC: 'sync.directo',     // Directo accounting data sync
} as const;
```

---

## PostgresStorage API

### Initialization

```typescript
import { PostgresStorageAdapter } from 'stepflow';

// Option 1: Connection string
const storage = new PostgresStorageAdapter({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow',     // Schema name (default: 'public')
  autoMigrate: false,     // Use @erwin/db migrations instead
});

// Option 2: Existing connection pool (for connection sharing)
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter({ pool, schema: 'stepflow' });

// Initialize (required before use)
await storage.initialize();

// Close when done
await storage.close();
```

**Note:** The `pg` and `kysely` packages are optional peer dependencies. They are only loaded at runtime when `PostgresStorageAdapter.initialize()` is called. Users who only use `MemoryStorageAdapter` or `SQLiteStorageAdapter` do not need to install them.

### Configuration Options

```typescript
interface PostgresStorageConfig {
  connectionString?: string;    // PostgreSQL connection URL
  pool?: pg.Pool;               // Existing pool (for sharing with app)
  poolConfig?: pg.PoolConfig;   // Pool configuration options
  schema?: string;              // Schema name (default: 'public')
  autoMigrate?: boolean;        // Auto-create tables (default: true)
}
```

### Run Operations

#### Create a Run

```typescript
const run = await storage.createRun({
  kind: 'sync.xero',
  status: 'queued',
  input: { subsidiaryId: '123', fullRefresh: false },
  context: {},
  metadata: { triggeredBy: 'user' },
  priority: 0,          // Higher = processed first
  timeoutMs: 600000,    // 10 minutes
});
console.log(run.id); // UUID
```

#### Get a Run

```typescript
const run = await storage.getRun(runId);
if (!run) {
  console.log('Run not found');
}
```

#### Update a Run

```typescript
// Mark as running
await storage.updateRun(runId, {
  status: 'running',
  startedAt: new Date(),
});

// Mark as succeeded with output
await storage.updateRun(runId, {
  status: 'succeeded',
  output: { rowsRead: 100, rowsWritten: 95 },
  finishedAt: new Date(),
});

// Mark as failed with error
await storage.updateRun(runId, {
  status: 'failed',
  error: { code: 'SYNC_FAILED', message: 'API rate limit exceeded' },
  finishedAt: new Date(),
});
```

#### List Runs

```typescript
const { items, total } = await storage.listRuns({
  kind: 'sync.xero',                    // Filter by workflow kind
  status: ['queued', 'running'],        // Filter by status (single or array)
  limit: 50,
  offset: 0,
  orderBy: 'createdAt',                 // 'createdAt' | 'startedAt' | 'finishedAt'
  orderDir: 'desc',                     // 'asc' | 'desc'
});

console.log(`Found ${total} runs`);
for (const run of items) {
  console.log(`${run.id}: ${run.status}`);
}
```

#### Delete a Run

```typescript
await storage.deleteRun(runId);
```

### Queue Operations

#### Atomic Dequeue

Safely dequeue a workflow for processing. Uses `FOR UPDATE SKIP LOCKED` to prevent duplicate processing.

```typescript
// Dequeue next workflow of specified kinds
const run = await storage.dequeueRun(['sync.xero', 'sync.directo']);

if (run) {
  // run.status is now 'running', started_at is set
  console.log(`Processing ${run.kind}: ${run.id}`);
  // Process the workflow...
} else {
  console.log('Queue is empty');
}
```

**How it works:**
1. Finds the next `queued` workflow matching the kinds (using `ANY($1::text[])` for array parameters)
2. Orders by `priority DESC, created_at ASC` (FIFO within priority)
3. Atomically updates status to `running` and sets `started_at`
4. Uses `FOR UPDATE SKIP LOCKED` to prevent duplicate processing by concurrent workers
5. Returns the workflow record

#### Cleanup Stale Runs

Mark workflows as timed out if they've been running too long:

```typescript
// Uses workflow's timeoutMs or default (10 minutes)
const count = await storage.cleanupStaleRuns(600000);
console.log(`Cleaned up ${count} stale workflows`);
```

#### Mark Runs as Failed

Bulk-mark workflows as failed (used during graceful shutdown):

```typescript
await storage.markRunsAsFailed(
  [runId1, runId2],
  'Worker process was terminated'
);
```

### Step Operations

#### Save Step Result

```typescript
await storage.saveStepResult({
  runId: run.id,
  stepName: 'xero.accounts',
  status: 'running',
  attempt: 1,
  startedAt: new Date(),
});

// Update on completion
await storage.saveStepResult({
  runId: run.id,
  stepName: 'xero.accounts',
  status: 'completed',
  output: { rowsRead: 50, rowsWritten: 50 },
  attempt: 1,
  startedAt: startTime,
  completedAt: new Date(),
});
```

**Note:** Uses `ON CONFLICT DO UPDATE` - calling with the same `runId` + `stepName` updates the existing record.

#### Get Step Results

```typescript
// Get single step
const step = await storage.getStepResult(runId, 'xero.accounts');

// Get all steps for a run
const steps = await storage.getStepResults(runId);
for (const step of steps) {
  console.log(`${step.stepName}: ${step.status}`);
}

// Get steps in StepRecord format (for API responses)
const records = await storage.getStepsForRun(runId);
```

---

## Creating Workflows

### Workflow Definition

Workflows in Erwin Analytics are defined by their **kind** and **input schema**. There's no formal workflow definition—the kind string and expected input structure form the contract.

**Current workflow kinds:**

| Kind | Input | Description |
|------|-------|-------------|
| `sync.xero` | `{ subsidiaryId, fullRefresh }` | Sync Xero accounting data |
| `sync.directo` | `{ subsidiaryId, fullRefresh }` | Sync Directo accounting data |

### Queuing a Workflow

From the API, use the `stepflowPlugin`:

```typescript
// In a Fastify route handler
const run = await fastify.stepflow.queueWorkflow(
  'sync.xero',
  {
    subsidiaryId: '550e8400-e29b-41d4-a716-446655440000',
    fullRefresh: false,
  },
  {
    priority: 5,        // Higher priority (default: 0)
    timeoutMs: 600000,  // 10 minute timeout
  }
);

// Returns the created workflow run
console.log(`Queued workflow: ${run.id}`);
```

### Processing a Workflow

The worker service polls for queued workflows and processes them:

```typescript
// Simplified worker loop
async function pollQueuedWorkflows() {
  const run = await storage.dequeueRun(['sync.xero', 'sync.directo']);

  if (run) {
    await processWorkflowRun(run.id, run.kind, run.input);
  }
}

async function processWorkflowRun(runId: string, kind: string, input: Record<string, unknown>) {
  try {
    // Update status to running
    await storage.updateRun(runId, {
      status: 'running',
      startedAt: new Date(),
    });

    // Dispatch to appropriate handler
    let result;
    if (kind === 'sync.xero') {
      result = await syncXeroSubsidiary(db, input.subsidiaryId, {
        fullRefresh: input.fullRefresh,
        workflowRunId: runId,
        workflowStorage: storage,
      });
    }

    // Update final status
    await storage.updateRun(runId, {
      status: result.success ? 'succeeded' : 'failed',
      output: { rowsRead: result.totalRowsRead, rowsWritten: result.totalRowsWritten },
      error: result.error ? { code: 'SYNC_FAILED', message: result.error } : undefined,
      finishedAt: new Date(),
    });
  } catch (err) {
    await storage.updateRun(runId, {
      status: 'failed',
      error: { code: 'WORKFLOW_ERROR', message: err.message },
      finishedAt: new Date(),
    });
  }
}
```

---

## Step Tracking Utilities

The `@erwin/shared` package provides utilities for tracking workflow steps.

### Import

```typescript
import {
  type SyncWorkflowContext,
  type EntitySyncResult,
  type WorkflowStepStorage,
  type SyncLogger,
  runStep,
  defineStep,
  aggregateResults,
  createConsoleLogger,
  createNoOpLogger,
} from '@erwin/shared';
```

### Workflow Context

Create a context object that's passed to all step runners:

```typescript
const workflowCtx: SyncWorkflowContext = {
  runId: workflowRunId,           // Stepflow run ID
  subsidiaryId: '123',             // Business context
  sourceSystem: 'xero',            // 'xero' | 'directo'
  fullRefresh: false,              // Sync mode
  storage: workflowStorage,        // PostgresStorage instance
  logger: createConsoleLogger('xero-sync'),
};
```

### Define Steps

Use `defineStep()` to create reusable step definitions:

```typescript
interface AccountsSyncInput {
  db: Kysely<Database>;
  ctx: XeroClientContext;
}

const accountsStep = defineStep<AccountsSyncInput, EntitySyncResult>(
  'xero.accounts',           // Step key (stored in database)
  'Sync Xero Accounts',      // Human-readable name
  async ({ db, ctx }) => {
    // Perform the actual sync work
    const result = await syncAccounts(db, ctx);
    return {
      success: result.success,
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
      error: result.error,
    };
  }
);
```

### Run Steps

Execute steps with automatic tracking:

```typescript
const accountResult = await runStep({
  ctx: workflowCtx,
  step: accountsStep,
  input: { db, ctx },
});

if (!accountResult.success) {
  console.log(`Step failed: ${accountResult.error}`);
}
```

**What `runStep()` does:**
1. Logs step start with context
2. Saves step as `running` in Stepflow
3. Executes the step handler
4. On success: saves step as `completed` with output
5. On failure: saves step as `failed` with error
6. On exception: catches error, saves as `failed`, returns error result

### Aggregate Results

Combine multiple step results:

```typescript
const aggregated = aggregateResults({
  accounts: accountResult,
  tracking_categories: trackingResult,
  journals: journalResult,
});

console.log(`Total: ${aggregated.totalRowsRead} read, ${aggregated.totalRowsWritten} written`);
console.log(`Success: ${aggregated.success}`);
if (aggregated.error) {
  console.log(`Errors: ${aggregated.error}`);
}
```

### Update Workflow Context

Store step results in the workflow's context for checkpointing:

```typescript
if (workflowCtx.storage) {
  await workflowCtx.storage.updateRun(workflowCtx.runId, {
    context: {
      steps: result.entityResults,
      totalRowsRead: aggregated.totalRowsRead,
      totalRowsWritten: aggregated.totalRowsWritten,
    },
  });
}
```

---

## API Integration

### Stepflow Plugin

The Fastify plugin provides workflow operations without running a full engine:

```typescript
// /apps/api/src/plugins/stepflow.ts
export interface StepflowService {
  storage: PostgresStorage;

  queueWorkflow(
    kind: string,
    input: Record<string, unknown>,
    options?: { priority?: number; timeoutMs?: number }
  ): Promise<WorkflowRunRecord>;

  getRun(runId: string): Promise<WorkflowRunRecord | undefined>;

  listRuns(options?: {
    kind?: string;
    status?: string | string[];
    limit?: number;
    offset?: number;
  }): Promise<PaginatedResult<WorkflowRunRecord>>;

  cancelRun(runId: string): Promise<void>;
}
```

### API Routes

**GET /api/sync/workflows**
```typescript
// List recent workflow runs
const { items, total } = await fastify.stepflow.listRuns({ limit: 100 });
return { data: items, total };
```

**GET /api/sync/workflows/:runId**
```typescript
// Get workflow with step details
const run = await fastify.stepflow.getRun(runId);
const steps = await fastify.stepflow.storage.getStepsForRun(runId);
return { data: { ...run, steps } };
```

**POST /api/sync/trigger/:subsidiaryId**
```typescript
// Queue a sync workflow
const run = await fastify.stepflow.queueWorkflow(
  'sync.xero',
  { subsidiaryId, fullRefresh },
  { priority: fullRefresh ? 5 : 0, timeoutMs: 600000 }
);
return { data: { runId: run.id, status: run.status } };
```

**POST /api/sync/workflows/:runId/cancel**
```typescript
// Cancel a workflow
await fastify.stepflow.cancelRun(runId);
return { data: { message: 'Workflow canceled' } };
```

---

## Worker Service

### Configuration

The worker is configured via environment variables:

```bash
DATABASE_URL=postgresql://...     # Required
SYNC_SCHEDULE="0 6 * * *"         # Daily at 6 AM UTC
POLL_INTERVAL=5000                 # Poll every 5 seconds
SYNC_ON_STARTUP=false              # Run sync on start
```

### Execution Modes

**1. Scheduled Syncs (Cron-based)**
- Runs at the configured schedule (default: 6 AM UTC daily)
- Syncs ALL subsidiaries with connected data sources
- Creates Stepflow runs for each sync for tracking

**2. Manual Syncs (Queue-based)**
- Triggered via API (`POST /api/sync/trigger/:subsidiaryId`)
- Worker polls every 5 seconds for queued workflows
- Atomic dequeue prevents duplicate processing

### Graceful Shutdown

The worker handles SIGINT/SIGTERM gracefully:

```typescript
process.on('SIGTERM', async () => {
  // Mark in-progress workflow as failed
  if (currentWorkflowRunId) {
    await storage.markRunsAsFailed(
      [currentWorkflowRunId],
      'Worker process was terminated during workflow execution'
    );
  }

  // Close connections
  await storage.close();
  await closeDb();
  process.exit(0);
});
```

### Stale Workflow Cleanup

The worker periodically cleans up stale workflows:

```typescript
// Every ~1 minute (12 poll cycles at 5s each)
const timedOutCount = await storage.cleanupStaleRuns(600000); // 10 min default
```

---

## Adding New Workflows

### Step 1: Define Workflow Kind

Add a new workflow kind constant:

```typescript
// In both API and Worker
const WORKFLOW_KINDS = {
  XERO_SYNC: 'sync.xero',
  DIRECTO_SYNC: 'sync.directo',
  MY_NEW_WORKFLOW: 'my.new.workflow',  // Add new kind
} as const;
```

### Step 2: Create Workflow Handler

Create a function that executes the workflow:

```typescript
// /packages/my-adapter/src/workflow.ts
import {
  type SyncWorkflowContext,
  type EntitySyncResult,
  runStep,
  defineStep,
  createConsoleLogger,
} from '@erwin/shared';

// Define steps
const step1 = defineStep<Step1Input, EntitySyncResult>(
  'my.step1',
  'Step 1 Description',
  async (input) => {
    // Do work...
    return { success: true, rowsRead: 10, rowsWritten: 10 };
  }
);

const step2 = defineStep<Step2Input, EntitySyncResult>(
  'my.step2',
  'Step 2 Description',
  async (input) => {
    // Do work...
    return { success: true, rowsRead: 20, rowsWritten: 20 };
  }
);

// Main workflow function
export async function runMyWorkflow(
  db: Kysely<Database>,
  input: { someParam: string },
  options: {
    workflowRunId?: string;
    workflowStorage?: WorkflowStepStorage;
  } = {}
) {
  const logger = createConsoleLogger('my-workflow');

  const workflowCtx: SyncWorkflowContext = {
    runId: options.workflowRunId ?? crypto.randomUUID(),
    subsidiaryId: input.someParam,
    sourceSystem: 'xero', // or appropriate value
    fullRefresh: false,
    storage: options.workflowStorage,
    logger,
  };

  const results: Record<string, EntitySyncResult> = {};

  // Execute steps in order
  results['step1'] = await runStep({
    ctx: workflowCtx,
    step: step1,
    input: { /* step1 input */ },
  });

  results['step2'] = await runStep({
    ctx: workflowCtx,
    step: step2,
    input: { /* step2 input */ },
  });

  // Update workflow context
  if (workflowCtx.storage) {
    const aggregated = aggregateResults(results);
    await workflowCtx.storage.updateRun(workflowCtx.runId, {
      context: { steps: results, ...aggregated },
    });
  }

  return {
    success: Object.values(results).every(r => r.success),
    totalRowsRead: Object.values(results).reduce((sum, r) => sum + r.rowsRead, 0),
    totalRowsWritten: Object.values(results).reduce((sum, r) => sum + r.rowsWritten, 0),
  };
}
```

### Step 3: Add Worker Handler

Update the worker to handle the new workflow kind:

```typescript
// /apps/worker/src/index.ts
async function processWorkflowRun(runId: string, kind: string, input: Record<string, unknown>) {
  // ... existing code ...

  if (kind === WORKFLOW_KINDS.MY_NEW_WORKFLOW) {
    result = await runMyWorkflow(db, input as MyWorkflowInput, {
      workflowRunId: runId,
      workflowStorage: storage!,
    });
  }

  // ... rest of function ...
}

// Update dequeue to include new kind
const run = await storage.dequeueRun([
  WORKFLOW_KINDS.XERO_SYNC,
  WORKFLOW_KINDS.DIRECTO_SYNC,
  WORKFLOW_KINDS.MY_NEW_WORKFLOW,
]);
```

### Step 4: Add API Endpoint (Optional)

If needed, add an API endpoint to trigger the workflow:

```typescript
// /apps/api/src/routes/my-routes.ts
fastify.post('/my-workflow/trigger', async (request, reply) => {
  const { someParam } = request.body;

  const run = await fastify.stepflow.queueWorkflow(
    WORKFLOW_KINDS.MY_NEW_WORKFLOW,
    { someParam },
    { priority: 0, timeoutMs: 300000 }
  );

  return { success: true, data: { runId: run.id } };
});
```

---

## Monitoring and Debugging

### View Workflow Runs

```typescript
// List recent runs
const { items } = await storage.listRuns({
  kind: 'sync.xero',
  status: ['running', 'failed'],
  limit: 10,
  orderBy: 'createdAt',
  orderDir: 'desc',
});

for (const run of items) {
  console.log(`${run.id}: ${run.status} - ${run.kind}`);
  if (run.error) {
    console.log(`  Error: ${run.error.message}`);
  }
}
```

### View Step Results

```typescript
const steps = await storage.getStepsForRun(runId);

for (const step of steps) {
  console.log(`${step.stepKey}: ${step.status}`);
  if (step.result) {
    console.log(`  Read: ${step.result.rowsRead}, Written: ${step.result.rowsWritten}`);
  }
  if (step.error) {
    console.log(`  Error: ${step.error.message}`);
  }
}
```

### SQL Queries

Direct database access for debugging:

```sql
-- View recent workflow runs
SELECT id, kind, status, created_at, started_at, finished_at, error
FROM stepflow.runs
ORDER BY created_at DESC
LIMIT 20;

-- View step results for a run
SELECT step_name, status, output, error, started_at, completed_at
FROM stepflow.step_results
WHERE run_id = 'your-run-id-here'
ORDER BY started_at;

-- Count workflows by status
SELECT status, COUNT(*)
FROM stepflow.runs
GROUP BY status;

-- Find stale running workflows
SELECT id, kind, started_at, timeout_ms
FROM stepflow.runs
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';
```

### Logging

The worker and sync adapters use structured JSON logging:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "INFO",
  "message": "Starting step: Sync Xero Accounts",
  "data": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "stepKey": "xero.accounts",
    "subsidiaryId": "123"
  }
}
```

---

## Database Schema

### stepflow.runs

```sql
CREATE TABLE stepflow.runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  context JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  error JSONB,
  metadata JSONB,
  priority INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_runs_status ON stepflow.runs (status);
CREATE INDEX idx_runs_kind ON stepflow.runs (kind);
CREATE INDEX idx_runs_created_at ON stepflow.runs (created_at DESC);
CREATE INDEX idx_runs_queue ON stepflow.runs (priority DESC, created_at ASC)
  WHERE status = 'queued';
```

### stepflow.step_results

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
  UNIQUE (run_id, step_name)
);

CREATE INDEX idx_step_results_run_id ON stepflow.step_results (run_id);
```

---

## TypeScript Types Reference

All types are exported from the `stepflow` package:

```typescript
import type {
  // Core types
  WorkflowRunRecord,
  StepResult,
  StepRecord,
  RunStatus,
  StepStatus,

  // Input/update types
  CreateRunInput,
  UpdateRunInput,
  ListRunsOptions,

  // Result types
  PaginatedResult,

  // Storage interface
  WorkflowStorage,

  // Config
  PostgresStorageConfig,
} from 'stepflow';

// Also available as an alias
import { PostgresStorage } from 'stepflow'; // alias for PostgresStorageAdapter
```

From `@erwin/shared`:

```typescript
import type {
  SyncWorkflowContext,
  WorkflowStepStorage,
  EntitySyncResult,
  StepDefinition,
  SyncLogger,
  AggregatedSyncResult,
} from '@erwin/shared';
```

---

## Implementation Notes

### pnpm Compatibility

The stepflow package uses dynamic `import()` internally to load `pg` and `kysely` on demand. This approach is compatible with all package managers including pnpm. Consumer code can import `pg` using any style that suits their setup.

### PostgreSQL Array Parameters

When filtering by workflow kinds in `dequeueRun`, the implementation uses PostgreSQL's `ANY()` operator with explicit type casting:

```sql
WHERE kind = ANY($1::text[])
```

This ensures proper type handling when passing string arrays as parameters.

### Table Names

The PostgreSQL storage uses these table names in the `stepflow` schema:
- `stepflow.runs` - Workflow run records
- `stepflow.step_results` - Individual step results

**Note:** Earlier versions of documentation may reference `workflow_runs` - the correct table name is `runs`.
