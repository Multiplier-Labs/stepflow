# Stepflow

A durable, type-safe workflow orchestration engine for Node.js with SQLite or PostgreSQL persistence, scheduling, and real-time events.

## Features

- **Durable Execution**: Steps are persisted to SQLite or PostgreSQL, allowing workflows to resume after crashes
- **Type-Safe**: Full TypeScript support with inferred types for inputs, outputs, and step results
- **Step Orchestration**: Sequential step execution with automatic retry and timeout support
- **Scheduling**: Cron-based scheduling and workflow completion triggers
- **Real-Time Events**: Socket.IO and webhook adapters for event streaming
- **Concurrency Control**: Limit concurrent workflow runs with priority queues
- **Multiple Storage Backends**: Choose SQLite for simplicity or PostgreSQL for distributed deployments

## Installation

```bash
npm install stepflow
```

## Quick Start

```typescript
import { WorkflowEngine, SQLiteStorage, defineWorkflow } from 'stepflow';

// Define a workflow
const orderWorkflow = defineWorkflow({
  kind: 'order.process',
  input: {} as { orderId: string; items: string[] },
  steps: {
    validateOrder: {
      run: async ({ input }) => {
        // Validate the order
        return { valid: true, total: 99.99 };
      },
    },
    processPayment: {
      run: async ({ input, steps }) => {
        const { total } = steps.validateOrder;
        // Process payment
        return { transactionId: 'txn-123', amount: total };
      },
    },
    sendConfirmation: {
      run: async ({ input, steps }) => {
        // Send confirmation email
        return { emailSent: true };
      },
    },
  },
});

// Create engine with SQLite storage
const storage = new SQLiteStorage({ filename: './workflows.db' });
const engine = new WorkflowEngine({ storage });

// Register workflow
engine.register(orderWorkflow);

// Start a workflow run
const run = await engine.start('order.process', {
  input: { orderId: 'order-123', items: ['item-1', 'item-2'] },
});

// Wait for completion
const result = await engine.waitForCompletion(run.id);
console.log(result.status); // 'succeeded'
console.log(result.output); // { emailSent: true }
```

## Core Concepts

### Workflows

A workflow is a series of steps that execute sequentially. Each step's result is persisted, allowing the workflow to resume from where it left off if interrupted.

```typescript
const myWorkflow = defineWorkflow({
  kind: 'my.workflow',
  input: {} as { userId: string },
  steps: {
    step1: {
      run: async ({ input }) => {
        return { data: 'step1 result' };
      },
    },
    step2: {
      run: async ({ input, steps }) => {
        // Access previous step results
        const step1Result = steps.step1;
        return { combined: step1Result.data + ' plus step2' };
      },
    },
  },
});
```

### Step Options

Steps support retry logic and timeouts:

```typescript
const workflow = defineWorkflow({
  kind: 'resilient.workflow',
  input: {} as { url: string },
  steps: {
    fetchData: {
      run: async ({ input }) => {
        const response = await fetch(input.url);
        return response.json();
      },
      retry: {
        maxAttempts: 3,
        delayMs: 1000,
        backoffMultiplier: 2, // Exponential backoff
      },
      timeoutMs: 30000,
    },
  },
});
```

### Workflow Timeouts

Set a maximum duration for entire workflow runs:

```typescript
const run = await engine.start('my.workflow', {
  input: { data: 'value' },
  timeoutMs: 60000, // 1 minute timeout
});
```

### Concurrency Control

Limit concurrent workflow executions with priority queues:

```typescript
const engine = new WorkflowEngine({
  storage,
  maxConcurrency: 5, // Max 5 concurrent runs
});

// Higher priority runs execute first
await engine.start('urgent.workflow', {
  input: { data: 'urgent' },
  priority: 10,
});

await engine.start('normal.workflow', {
  input: { data: 'normal' },
  priority: 1,
});
```

## Storage

### In-Memory Storage

For testing and development:

```typescript
import { MemoryStorage } from 'stepflow';

const storage = new MemoryStorage();
```

### SQLite Storage

For single-process deployments:

```typescript
import { SQLiteStorage } from 'stepflow';

const storage = new SQLiteStorage({
  filename: './workflows.db', // File path or ':memory:'
});
```

### PostgreSQL Storage

For production use with distributed workers:

```typescript
import { PostgresStorage } from 'stepflow';

// Option 1: Connection string
const storage = new PostgresStorage({
  connectionString: 'postgresql://user:pass@localhost:5432/myapp',
  schema: 'stepflow', // Optional, defaults to 'stepflow'
});

await storage.initialize();

// Option 2: Share existing connection pool
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorage({ pool });
```

PostgreSQL storage provides:
- **Atomic dequeue**: Safe concurrent processing with `FOR UPDATE SKIP LOCKED`
- **Connection pooling**: Share database connections with your application
- **Schema isolation**: Custom schema names for multi-tenant deployments
- **Stale workflow cleanup**: Automatic timeout handling

## Event Transports

### Memory Events

Simple in-memory event emitter:

```typescript
import { MemoryEventTransport } from 'stepflow';

const events = new MemoryEventTransport();
const engine = new WorkflowEngine({ storage, events });

// Subscribe to events
events.subscribeAll((event) => {
  console.log(`Event: ${event.eventType} for run ${event.runId}`);
});
```

### Socket.IO Events

Real-time events via Socket.IO:

```typescript
import { Server } from 'socket.io';
import { SocketIOEventTransport } from 'stepflow';

const io = new Server(httpServer);
const events = new SocketIOEventTransport({ io });

const engine = new WorkflowEngine({ storage, events });

// Set up client handlers
io.on('connection', (socket) => {
  events.setupClientHandlers(socket);
});

// Client-side:
// socket.emit('workflow:subscribe', runId);
// socket.on('workflow:event', (event) => console.log(event));
```

### Webhook Events

POST events to HTTP endpoints:

```typescript
import { WebhookEventTransport } from 'stepflow';

const events = new WebhookEventTransport({
  endpoints: [
    {
      id: 'slack',
      url: 'https://hooks.slack.com/...',
      eventTypes: ['run.completed', 'run.failed'],
    },
    {
      id: 'analytics',
      url: 'https://api.analytics.com/events',
      secret: 'webhook-secret', // HMAC-SHA256 signing
    },
  ],
});

const engine = new WorkflowEngine({ storage, events });
```

## Scheduling

### Cron Scheduler

Schedule workflows using cron expressions:

```typescript
import { CronScheduler, SQLiteSchedulePersistence } from 'stepflow';

const schedulePersistence = new SQLiteSchedulePersistence({ db: storage.getDb() });
const scheduler = new CronScheduler({
  engine,
  persistence: schedulePersistence,
});

// Schedule a workflow to run every hour
await scheduler.addSchedule({
  id: 'hourly-cleanup',
  workflowKind: 'cleanup.workflow',
  triggerType: 'cron',
  cronExpression: '0 * * * *', // Every hour
  timezone: 'America/New_York',
  input: { dryRun: false },
});

// Start the scheduler
scheduler.start();
```

### Workflow Completion Triggers

Trigger workflows when other workflows complete:

```typescript
await scheduler.addSchedule({
  id: 'post-order-notification',
  workflowKind: 'notification.send',
  triggerType: 'workflow_completed',
  triggerOnWorkflowKind: 'order.process',
  triggerOnStatus: ['succeeded', 'failed'],
  input: { template: 'order-status' },
});
```

## Event Types

The engine emits the following event types:

- `run.created` - Workflow run created
- `run.queued` - Run queued (when at max concurrency)
- `run.dequeued` - Run dequeued and starting
- `run.started` - Run execution started
- `run.resumed` - Run resumed after interruption
- `run.completed` - Run completed successfully
- `run.failed` - Run failed with error
- `run.canceled` - Run was canceled
- `run.timeout` - Run exceeded timeout
- `step.started` - Step execution started
- `step.completed` - Step completed successfully
- `step.failed` - Step failed (may retry)
- `step.skipped` - Step skipped (already completed)
- `step.retry` - Step retrying after failure

## API Reference

### WorkflowEngine

```typescript
class WorkflowEngine {
  constructor(config: WorkflowEngineConfig);

  register(workflow: WorkflowDefinition): void;
  unregister(kind: string): boolean;

  start(kind: string, options?: StartRunOptions): Promise<WorkflowRun>;
  cancel(runId: string): Promise<void>;
  resume(runId: string): Promise<WorkflowRun>;

  getRun(runId: string): Promise<WorkflowRun | undefined>;
  listRuns(options?: ListRunsOptions): Promise<{ runs: WorkflowRun[]; total: number }>;

  waitForCompletion(runId: string, options?: WaitOptions): Promise<WorkflowRun>;

  getActiveRunCount(): number;
  getQueuedRunCount(): number;

  close(): void;
}
```

### defineWorkflow

```typescript
function defineWorkflow<TInput, TSteps>(config: {
  kind: string;
  input: TInput;
  steps: TSteps;
}): WorkflowDefinition;
```

### SQLiteStorage

```typescript
class SQLiteStorage implements WorkflowStorage {
  constructor(config: { filename?: string; db?: Database });
  getDb(): Database;
  // ... storage methods
}
```

### PostgresStorage

```typescript
class PostgresStorage implements WorkflowStorage {
  constructor(config: PostgresStorageConfig);

  initialize(): Promise<void>;
  close(): Promise<void>;

  // Run operations
  createRun(run: CreateRunInput): Promise<WorkflowRunRecord>;
  getRun(id: string): Promise<WorkflowRunRecord | undefined>;
  updateRun(id: string, updates: UpdateRunInput): Promise<void>;
  listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;
  deleteRun(id: string): Promise<void>;

  // Queue operations
  dequeueRun(workflowKinds?: string[]): Promise<WorkflowRunRecord | null>;
  cleanupStaleRuns(defaultTimeoutMs?: number): Promise<number>;
  markRunsAsFailed(runIds: string[], reason: string): Promise<void>;

  // Step operations
  getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
  getStepResults(runId: string): Promise<StepResult[]>;
  saveStepResult(result: StepResult): Promise<void>;
}

interface PostgresStorageConfig {
  connectionString?: string;  // PostgreSQL connection URL
  pool?: pg.Pool;             // Existing pool for connection sharing
  poolConfig?: pg.PoolConfig; // Pool configuration options
  schema?: string;            // Schema name (default: 'stepflow')
  autoMigrate?: boolean;      // Auto-create tables (default: true)
}
```

## License

MIT
