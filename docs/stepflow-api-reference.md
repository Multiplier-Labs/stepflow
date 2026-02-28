# Stepflow Implementation Guide

A durable, PostgreSQL-backed workflow queue with granular step tracking. Stepflow is an npm package (`@multiplier-labs/stepflow`) that provides storage and queue primitives — step definitions, the step runner, and workflow dispatch logic are application code you build on top.

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
- [Production Patterns](#production-patterns)
- [Adding New Workflows](#adding-new-workflows)
- [Monitoring and Debugging](#monitoring-and-debugging)

---

## Overview

Stepflow provides a PostgreSQL-backed job queue system with granular step tracking for the Erwin Analytics platform. It enables:

- **Durable workflow execution** - Workflows persist across process restarts
- **Granular step tracking** - Each workflow step is tracked individually
- **Atomic dequeue** - Safe concurrent processing by multiple workers via `FOR UPDATE SKIP LOCKED`
- **Real-time monitoring** - Track workflow and step progress in the UI
- **Timeout management** - Automatic cleanup of stale workflows

### How It's Used in Erwin Analytics

Stepflow tracks data synchronization workflows from external systems (Xero, Directo, BambooHR, ECB exchange rates):

1. **API** queues workflows when users trigger manual syncs
2. **Worker** polls the queue and picks up workflows for execution
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
│   - workflow_run_    │    │   - Updates      │    │  - BambooHR     │
│     steps            │    └──────────────────┘    │  - Records steps│
│   - workflow_events  │                            └─────────────────┘
└──────────────────────┘
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `stepflow` package | `@multiplier-labs/stepflow@^0.2.6` (npm) | Core storage and queue implementation |
| Stepflow plugin | `/apps/api/src/plugins/stepflow.ts` | Fastify plugin for API |
| Worker service | `/apps/worker/src/index.ts` | Background job processor |
| Sync workflow utils | `/packages/shared/src/sync-workflow.ts` | Step tracking utilities |
| Sync adapters | `/packages/xero-adapter/`, `/packages/directo-adapter/`, `/packages/bamboohr-adapter/` | Data sync implementations |

---

## Project Setup

### 1. Install the Package

```bash
pnpm add @multiplier-labs/stepflow
```

The package has peer dependencies on `pg` and `kysely`:

```json
{
  "dependencies": {
    "@multiplier-labs/stepflow": "^0.2.6",
    "kysely": "^0.27.0",
    "pg": "^8.11.0"
  }
}
```

### 2. Database Migrations

Stepflow requires PostgreSQL tables in the `stepflow` schema. The library supports `autoMigrate: true` to create tables automatically, or you can manage migrations yourself (recommended for production).

In Erwin Analytics, migrations are managed via the `@erwin/db` migration system:

**Migration files:**
- `002_stepflow_schema.ts` - Creates core tables (runs, workflow_run_steps, workflow_events, schedules)
- `005_add_stepflow_runs_context.ts` - Adds `context` column for step checkpointing
- `006_add_stepflow_runs_remaining_columns.ts` - Adds `output`, `error`, `priority`, `timeout_ms` columns
- `013_rename_stepflow_tables.ts` - Renames tables for stepflow v0.2.6 compatibility
- `014_fix_stepflow_steps_table.ts` - Ensures workflow_run_steps structure
- `015_fix_step_results_table.ts` - Fixes column naming (output→result, completed_at→finished_at)
- `016_add_parent_run_id_to_runs.ts` - Adds `parent_run_id` for nested workflows, converts IDs from UUID to TEXT

Run migrations:

```bash
cd packages/db
pnpm db:migrate
```

### 3. Environment Variables

Required for both API and Worker services:

```bash
# PostgreSQL connection string (required)
DATABASE_URL=postgresql://user:pass@localhost:5432/erwin

# Worker-specific settings
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
- Check per-subsidiary cron schedules every minute
- Schedule daily exchange rate sync at 7 AM UTC
- Poll for manual sync requests every 5 seconds

---

## Core Concepts

### Workflow Run

A workflow run represents a single execution of a workflow (e.g., syncing Xero data for a subsidiary).

```typescript
interface WorkflowRunRecord {
  id: string;                                    // TEXT (nanoid, not UUID)
  kind: string;                                  // Workflow type (e.g., 'sync.xero')
  status: RunStatus;                             // Current state
  parentRunId?: string;                          // Parent run ID (for nested workflows)
  input: Record<string, unknown>;                // Workflow parameters
  context: Record<string, unknown>;              // Accumulated step results (checkpointing)
  output?: Record<string, unknown>;              // Final workflow output
  error?: { code: string; message: string };     // Error details if failed
  metadata?: Record<string, unknown>;            // Custom metadata
  priority: number;                              // Queue priority (higher = processed first)
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
  | 'timeout';     // Exceeded timeout duration (set by cleanupStaleRuns)
```

**Lifecycle:** `queued` → `running` → `succeeded` | `failed` | `canceled` | `timeout`

### Step Result

Each step within a workflow is tracked individually:

```typescript
interface StepResult {
  id: string;
  runId: string;                         // Parent workflow run ID
  stepName: string;                      // Step identifier (e.g., 'xero.accounts')
  status: StepStatus;                    // Step state
  output?: Record<string, unknown>;      // Step output (e.g., { rowsRead, rowsWritten })
  error?: Record<string, unknown>;       // Error details if failed
  attempt: number;                       // Attempt counter
  startedAt?: Date;
  completedAt?: Date;
}
```

### Step Status

```typescript
type StepStatus =
  | 'pending'      // Defined but not started
  | 'running'      // Currently executing
  | 'succeeded'    // Completed successfully
  | 'failed'       // Execution failed
  | 'skipped';     // Skipped (prerequisite failed)
```

### Workflow Kinds

Workflow kinds are string identifiers that categorize workflows:

```typescript
const WORKFLOW_KINDS = {
  XERO_SYNC: 'sync.xero',                   // Xero accounting data sync
  DIRECTO_SYNC: 'sync.directo',             // Directo accounting data sync
  BAMBOOHR_SYNC: 'sync.bamboohr',           // BambooHR employee & compensation sync
  EXCHANGE_RATE_SYNC: 'sync.exchange_rates', // ECB exchange rate sync
} as const;
```

---

## PostgresStorage API

### Initialization

```typescript
import { PostgresStorage } from '@multiplier-labs/stepflow/storage';

// Option 1: Connection string
const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow',     // Schema name (default: 'stepflow')
  autoMigrate: false,     // Use your own migrations in production
});

// Option 2: Existing connection pool (for connection sharing)
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorage({ pool, schema: 'stepflow' });

// Initialize (required before use)
await storage.initialize();

// Close when done
await storage.close();
```

### Configuration Options

```typescript
interface PostgresStorageConfig {
  connectionString?: string;    // PostgreSQL connection URL
  pool?: pg.Pool;               // Existing pool (for sharing with app)
  poolConfig?: pg.PoolConfig;   // Pool configuration options
  schema?: string;              // Schema name (default: 'stepflow')
  autoMigrate?: boolean;        // Auto-create tables (default: true)
}
```

### Full API Surface

```typescript
class PostgresStorage {
  // Lifecycle
  constructor(config: PostgresStorageConfig)
  initialize(): Promise<void>
  close(): Promise<void>

  // Run operations
  createRun(input: CreateRunInput): Promise<WorkflowRunRecord>
  getRun(runId: string): Promise<WorkflowRunRecord | undefined>
  updateRun(runId: string, updates: UpdateRunInput): Promise<void>
  listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>
  deleteRun(runId: string): Promise<void>

  // Queue operations
  dequeueRun(workflowKinds: string[]): Promise<WorkflowRunRecord | undefined>
  cleanupStaleRuns(timeoutMs?: number): Promise<number>
  markRunsAsFailed(runIds: string[], reason: string): Promise<void>

  // Step operations
  saveStepResult(result: SaveStepResultInput): Promise<void>
  getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>
  getStepResults(runId: string): Promise<StepResult[]>
  getStepsForRun(runId: string): Promise<StepRecord[]>
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
});
console.log(run.id); // nanoid string (e.g., 'V1StGXR8_Z5jdHi6B-myT')
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

// Update context for checkpointing
await storage.updateRun(runId, {
  context: { steps: stepResults, totalRowsRead: 200 },
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

Safely dequeue a workflow for processing. Uses `FOR UPDATE SKIP LOCKED` to prevent duplicate processing across multiple workers.

```typescript
// Dequeue next workflow of specified kinds
const run = await storage.dequeueRun(['sync.xero', 'sync.directo']);

if (run) {
  // run.status is already 'running', started_at is already set
  // No need to call updateRun(status: 'running') — dequeueRun does this atomically
  console.log(`Processing ${run.kind}: ${run.id}`);
} else {
  console.log('Queue is empty');
}
```

**How it works (SQL):**
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
- FIFO ordering within same priority
- No blocking between concurrent workers

#### Cleanup Stale Runs

Mark workflows as timed out if they've been running too long:

```typescript
// Marks runs as 'timeout' where started_at + timeout_ms < NOW()
const count = await storage.cleanupStaleRuns(600000); // 10 min default
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
// Record step as running
await storage.saveStepResult({
  runId: run.id,
  stepName: 'xero.accounts',
  status: 'running',
  attempt: 1,
  startedAt: new Date(),
});

// Update on completion (same runId + stepName updates the existing record)
await storage.saveStepResult({
  runId: run.id,
  stepName: 'xero.accounts',
  status: 'succeeded',
  output: { rowsRead: 50, rowsWritten: 50 },
  attempt: 1,
  startedAt: startTime,
  completedAt: new Date(),
});
```

**Note:** Uses `ON CONFLICT DO UPDATE` on `(run_id, step_name)` — calling with the same `runId` + `stepName` updates the existing record rather than inserting a duplicate.

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

Workflows are defined by their **kind** string and **input schema**. There is no formal workflow definition — the kind string and expected input structure form the contract.

**Current workflow kinds:**

| Kind | Input | Description |
|------|-------|-------------|
| `sync.xero` | `{ subsidiaryId, fullRefresh, syncMode? }` | Sync Xero accounting data |
| `sync.directo` | `{ subsidiaryId, fullRefresh, syncMode? }` | Sync Directo accounting data |
| `sync.bamboohr` | `{ subsidiaryId, fullRefresh }` | Sync BambooHR employee & compensation data |
| `sync.exchange_rates` | `{ currencies, fullRefresh, months }` | Sync ECB exchange rates |

### Queuing a Workflow

From the API, use the `stepflowPlugin`:

```typescript
// In a Fastify route handler
const run = await fastify.stepflow.queueWorkflow(
  'sync.xero',
  {
    subsidiaryId: '550e8400-e29b-41d4-a716-446655440000',
    fullRefresh: false,
    syncMode: 'incremental',  // 'incremental' | 'full' | 'ytd'
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
async function pollQueuedWorkflows() {
  // dequeueRun atomically claims a run and sets status='running'
  const run = await storage.dequeueRun([
    'sync.xero',
    'sync.directo',
    'sync.bamboohr',
    'sync.exchange_rates',
  ]);

  if (run) {
    await processWorkflowRun(run.id, run.kind, run.input);
  }
}

async function processWorkflowRun(runId: string, kind: string, input: Record<string, unknown>) {
  try {
    // Dispatch to appropriate handler, passing storage for step tracking
    let result;
    if (kind === 'sync.xero') {
      result = await syncXeroSubsidiary(db, input.subsidiaryId as string, {
        fullRefresh: input.fullRefresh as boolean,
        workflowRunId: runId,
        workflowStorage: storage,
      });
    }
    // ... other kinds ...

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
      error: { code: 'WORKFLOW_ERROR', message: (err as Error).message },
      finishedAt: new Date(),
    });
  }
}
```

---

## Step Tracking Utilities

The `@erwin/shared` package provides utilities for tracking workflow steps. These are **application-level code**, not part of the stepflow npm package.

### Import

```typescript
import {
  type SyncWorkflowContext,
  type EntitySyncResult,
  type WorkflowStepStorage,
  type SyncLogger,
  type StepDefinition,
  type AggregatedSyncResult,
  type StepDependencyMap,
  runStep,
  defineStep,
  skipStep,
  shouldSkipStep,
  aggregateResults,
  updateWorkflowContext,
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
  sourceSystem: 'xero',            // 'xero' | 'directo' | 'bamboohr' | 'ecb'
  fullRefresh: false,              // Sync mode
  storage: workflowStorage,        // PostgresStorage instance (optional)
  logger: createConsoleLogger('xero-sync'),
};
```

The `storage` field is optional — when omitted, `runStep()` still executes the handler and returns results, it just doesn't persist step status to the database.

### WorkflowStepStorage Interface

The minimal interface that sync functions need from the storage layer:

```typescript
interface WorkflowStepStorage {
  saveStepResult(result: {
    runId: string;
    stepName: string;
    status: StepStatus;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
    attempt: number;
    startedAt?: Date;
    completedAt?: Date;
  }): Promise<void>;

  updateRun(runId: string, updates: {
    context?: Record<string, unknown>;
  }): Promise<void>;
}
```

`PostgresStorage` satisfies this interface, so it can be passed directly.

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

### EntitySyncResult

The standard return type for step handlers:

```typescript
interface EntitySyncResult {
  success: boolean;
  rowsRead: number;
  rowsWritten: number;
  error?: string;
}
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
1. Logs step start with context (runId, stepKey, subsidiaryId)
2. Saves step as `running` in Stepflow (if storage provided)
3. Executes the step handler
4. On success (handler returns `success: true`): saves step as `succeeded` with output
5. On failure (handler returns `success: false`): saves step as `failed` with error
6. On exception (handler throws): catches error, saves as `failed`, returns `{ success: false, rowsRead: 0, rowsWritten: 0, error: message }` — **never throws**

### Step Dependencies

Skip steps whose prerequisites failed:

```typescript
// Define which steps depend on which
const dependencies: StepDependencyMap = {
  'xero.journals': ['xero.accounts'],         // journals requires accounts
  'xero.bank_transactions': ['xero.accounts'], // bank requires accounts
};

const failedSteps = new Set<string>();

// Run prerequisite step
const accountResult = await runStep({ ctx, step: accountsStep, input });
if (!accountResult.success) {
  failedSteps.add('xero.accounts');
}

// Check if dependent step should be skipped
const skipReason = shouldSkipStep('xero.journals', dependencies, failedSteps);
if (skipReason) {
  // Records step as 'skipped' in storage with the reason
  await skipStep({ ctx, step: journalsStep, reason: skipReason });
} else {
  await runStep({ ctx, step: journalsStep, input });
}
```

### Aggregate Results

Combine multiple step results into a workflow-level summary:

```typescript
const aggregated = aggregateResults({
  accounts: accountResult,
  tracking_categories: trackingResult,
  journals: journalResult,
});

console.log(`Total: ${aggregated.totalRowsRead} read, ${aggregated.totalRowsWritten} written`);
console.log(`Success: ${aggregated.success}`);  // false if any step failed
if (aggregated.error) {
  console.log(`Errors: ${aggregated.error}`);    // "accounts: ...; journals: ..."
}
```

### Update Workflow Context

Store step results in the workflow's context for checkpointing:

```typescript
// Helper that aggregates and saves in one call
await updateWorkflowContext(workflowCtx, stepResults);

// Or manually:
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

### Logging

Two logger implementations are provided:

```typescript
// Structured JSON logger with timestamps
const logger = createConsoleLogger('xero-sync');
// Output: [2024-01-15T10:30:00.000Z] [INFO] [xero-sync] Starting step: Sync Xero Accounts {"runId":"abc","stepKey":"xero.accounts"}

// No-op logger (for tests or when logging is unwanted)
const silent = createNoOpLogger();
```

---

## API Integration

### Stepflow Plugin

The Fastify plugin provides workflow operations. It creates its own `PostgresStorage` instance and exposes a service interface:

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

The plugin automatically closes the storage connection when Fastify shuts down.

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
// Cancel a queued or running workflow
await fastify.stepflow.cancelRun(runId);
return { data: { message: 'Workflow canceled' } };
```

---

## Worker Service

### Configuration

The worker is configured via environment variables:

```bash
DATABASE_URL=postgresql://...     # Required
POLL_INTERVAL=5000                 # Poll every 5 seconds (default: 5000)
SYNC_ON_STARTUP=false              # Run sync on start (default: false)
```

### Execution Modes

**1. Scheduled Syncs (Per-subsidiary cron)**
- Each subsidiary has its own `sync_schedule` cron expression in the database
- Worker checks every minute which subsidiaries are due for syncing
- Queues workflows into the Stepflow table (same queue as manual syncs)
- Skips subsidiaries with `sync_enabled = false`
- Skips if an active (queued/running) sync already exists for that subsidiary+source

**2. Scheduled Exchange Rate Sync**
- Runs daily at 7:00 AM UTC via `node-cron`
- Queues an `sync.exchange_rates` workflow if auto-sync is enabled in org settings

**3. Manual Syncs (Queue-based)**
- Triggered via API (`POST /api/sync/trigger/:subsidiaryId`)
- Worker polls every `POLL_INTERVAL` ms for queued workflows
- Atomic dequeue prevents duplicate processing

All three modes queue into the same Stepflow runs table and are processed by the same poll loop.

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

The worker periodically cleans up stale workflows during the poll loop:

```typescript
// Every ~1 minute (12 poll cycles at 5s each)
const timedOutCount = await storage.cleanupStaleRuns();
// Marks runs as 'timeout' where status='running' and started_at + timeout_ms < NOW()
```

### Single-Threaded Execution

The worker uses an `isProcessing` flag to ensure only one workflow executes at a time, preventing concurrent API calls that could overwhelm external services.

---

## Production Patterns

### Preventing Duplicate Syncs

Before queueing a scheduled sync, check for active runs:

```typescript
const activeRun = await findActiveWorkflowRun(db, workflowKind, subsidiaryId);
if (activeRun) {
  log('info', `Already ${activeRun.status}, skipping`);
  return;
}
```

### Advisory Locks

PostgreSQL advisory locks prevent concurrent processing of the same subsidiary across multiple worker instances:

```typescript
const lockAcquired = await tryAcquireSyncLock(db, subsidiaryId);
if (!lockAcquired) {
  // Re-queue the workflow for later processing
  await storage.updateRun(runId, { status: 'queued' });
  return;
}

try {
  // Process the workflow...
} finally {
  await releaseSyncLock(db, subsidiaryId);
}
```

### Auto-Retry Incomplete Full Refreshes

If a full refresh fails partway through, the output is marked with `fullRefreshIncomplete: true`. The next incremental sync detects this and auto-upgrades to a full refresh:

```typescript
const lastRun = await getLastWorkflowRun(db, subsidiaryId, sourceSystem);
const lastOutput = (lastRun?.output_json ?? lastRun?.output) as Record<string, unknown>;
if (lastOutput?.['fullRefreshIncomplete']) {
  effectiveFullRefresh = true;
  effectiveSyncMode = 'full';
}
```

### YTD Sync Mode

In addition to `incremental` and `full`, a `ytd` (Year-To-Date) mode syncs from January 1st of the previous year:

```typescript
if (syncMode === 'ytd') {
  const previousYear = new Date().getFullYear() - 1;
  dateOptions.startDate = `${previousYear}-01-01`;
}
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
  BAMBOOHR_SYNC: 'sync.bamboohr',
  EXCHANGE_RATE_SYNC: 'sync.exchange_rates',
  MY_NEW_WORKFLOW: 'my.new.workflow',  // Add new kind
} as const;
```

### Step 2: Create Workflow Handler

Create a function that executes the workflow with step tracking:

```typescript
// /packages/my-adapter/src/workflow.ts
import {
  type SyncWorkflowContext,
  type EntitySyncResult,
  runStep,
  defineStep,
  aggregateResults,
  updateWorkflowContext,
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
    sourceSystem: 'xero',
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

  // Checkpoint step results to workflow context
  await updateWorkflowContext(workflowCtx, results);

  const aggregated = aggregateResults(results);
  return {
    success: aggregated.success,
    totalRowsRead: aggregated.totalRowsRead,
    totalRowsWritten: aggregated.totalRowsWritten,
    error: aggregated.error,
    entityResults: results,
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
  WORKFLOW_KINDS.BAMBOOHR_SYNC,
  WORKFLOW_KINDS.EXCHANGE_RATE_SYNC,
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
SELECT id, kind, status, created_at, started_at, finished_at,
       COALESCE(error_json, error) AS error
FROM stepflow.runs
ORDER BY created_at DESC
LIMIT 20;

-- View step results for a run
SELECT step_key, step_name, status, result, error, started_at, finished_at
FROM stepflow.workflow_run_steps
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

-- Find all runs for a subsidiary
SELECT id, kind, status, created_at,
       COALESCE(output_json, output) AS output
FROM stepflow.runs
WHERE input->>'subsidiaryId' = 'your-subsidiary-id'
ORDER BY created_at DESC;
```

### Logging

The worker and sync adapters use structured logging via `createConsoleLogger()`:

```
[2024-01-15T10:30:00.000Z] [INFO] [xero-sync] Starting step: Sync Xero Accounts {"runId":"V1StGXR8_Z5jdHi6B","stepKey":"xero.accounts","subsidiaryId":"123"}
[2024-01-15T10:30:05.000Z] [INFO] [xero-sync] Step completed: Sync Xero Accounts {"runId":"V1StGXR8_Z5jdHi6B","stepKey":"xero.accounts","rowsRead":50,"rowsWritten":50,"durationMs":5000}
```

---

## Database Schema

### stepflow.runs

```sql
CREATE TABLE stepflow.runs (
  id TEXT PRIMARY KEY,                    -- nanoid string (NOT UUID)
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
  -- Stepflow v0.2.6 uses _json columns internally
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

### stepflow.workflow_run_steps

```sql
CREATE TABLE stepflow.workflow_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES stepflow.runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,                 -- programmatic identifier
  step_name TEXT NOT NULL,                -- human-readable name
  status TEXT NOT NULL,                   -- 'pending'|'running'|'succeeded'|'failed'|'skipped'
  attempt INTEGER NOT NULL DEFAULT 1,
  result JSONB,                           -- step output data (NOT named 'output')
  error JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ                 -- (NOT named 'completed_at')
);

CREATE UNIQUE INDEX idx_workflow_run_steps_unique
  ON stepflow.workflow_run_steps (run_id, step_key);
CREATE INDEX idx_workflow_run_steps_run_id
  ON stepflow.workflow_run_steps (run_id);
```

**Note on `_json` columns:** Stepflow v0.2.6 reads/writes to the `_json` variants (`input_json`, `output_json`, etc.) internally. When querying directly, use `COALESCE(output_json, output)` to get the correct value regardless of which column was written.

---

## TypeScript Types Reference

From the stepflow npm package:

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
} from '@multiplier-labs/stepflow';

// Storage class (subpath export)
import { PostgresStorage } from '@multiplier-labs/stepflow/storage';
```

From `@erwin/shared` (application-level utilities):

```typescript
import type {
  SyncWorkflowContext,
  WorkflowStepStorage,
  EntitySyncResult,
  StepDefinition,
  SyncLogger,
  AggregatedSyncResult,
  StepDependencyMap,
} from '@erwin/shared';

import {
  runStep,
  defineStep,
  skipStep,
  shouldSkipStep,
  aggregateResults,
  updateWorkflowContext,
  createConsoleLogger,
  createNoOpLogger,
} from '@erwin/shared';
```
