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
- **Planning System**: Rule-based recipe selection and dynamic plan generation

## Installation

This package is published to GitHub Packages. See [docs/github-packages-setup.md](docs/github-packages-setup.md) for authentication setup.

```bash
npm install @multiplier-labs/stepflow
```

## Quick Start

```typescript
import Database from 'better-sqlite3';
import { WorkflowEngine, SQLiteStorageAdapter } from '@multiplier-labs/stepflow';

// Create engine with SQLite storage
const db = new Database('./workflows.db');
const engine = new WorkflowEngine({
  storage: new SQLiteStorageAdapter({ db }),
});

// Register a workflow
engine.registerWorkflow({
  kind: 'order.process',
  name: 'Process Order',
  steps: [
    {
      key: 'validateOrder',
      name: 'Validate Order',
      handler: async (ctx) => {
        return { valid: true, total: 99.99 };
      },
    },
    {
      key: 'processPayment',
      name: 'Process Payment',
      handler: async (ctx) => {
        const { total } = ctx.results.validateOrder;
        return { transactionId: 'txn-123', amount: total };
      },
    },
    {
      key: 'sendConfirmation',
      name: 'Send Confirmation',
      handler: async (ctx) => {
        return { emailSent: true };
      },
    },
  ],
});

// Start a workflow run
const runId = await engine.startRun({
  kind: 'order.process',
  input: { orderId: 'order-123', items: ['item-1', 'item-2'] },
});

// Wait for completion
const result = await engine.waitForRun(runId);
console.log(result.status); // 'succeeded'
```

## Core Concepts

### Workflows

A workflow is a series of steps that execute sequentially. Each step's result is persisted, allowing the workflow to resume from where it left off if interrupted.

```typescript
engine.registerWorkflow({
  kind: 'my.workflow',
  name: 'My Workflow',
  steps: [
    {
      key: 'step1',
      name: 'Step 1',
      handler: async (ctx) => {
        return { data: 'step1 result' };
      },
    },
    {
      key: 'step2',
      name: 'Step 2',
      handler: async (ctx) => {
        // Access previous step results
        const step1Result = ctx.results.step1;
        return { combined: step1Result.data + ' plus step2' };
      },
    },
  ],
});
```

### Step Options

Steps support retry logic and timeouts:

```typescript
engine.registerWorkflow({
  kind: 'resilient.workflow',
  name: 'Resilient Workflow',
  steps: [
    {
      key: 'fetchData',
      name: 'Fetch Data',
      handler: async (ctx) => {
        const response = await fetch(ctx.input.url);
        return response.json();
      },
      onError: 'retry',
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 30000,
    },
  ],
});
```

### Workflow Timeouts

Set a maximum duration for entire workflow runs via engine settings:

```typescript
const engine = new WorkflowEngine({
  storage,
  settings: {
    defaultTimeout: 60000, // 1 minute default timeout for all runs
  },
});
```

### Concurrency Control

Limit concurrent workflow executions with priority queues:

```typescript
const engine = new WorkflowEngine({
  storage,
  settings: {
    maxConcurrency: 5, // Max 5 concurrent runs
  },
});

// Higher priority runs execute first
await engine.startRun({
  kind: 'urgent.workflow',
  input: { data: 'urgent' },
  priority: 10,
});

await engine.startRun({
  kind: 'normal.workflow',
  input: { data: 'normal' },
  priority: 1,
});
```

## Lifecycle

The engine supports explicit initialization and shutdown:

```typescript
const engine = new WorkflowEngine({
  storage: new PostgresStorageAdapter({
    connectionString: 'postgresql://localhost:5432/myapp',
  }),
});

// Initialize storage (required for PostgreSQL, creates tables)
await engine.initialize();

// ... use the engine ...

// Graceful shutdown (cancels active runs, closes connections)
await engine.shutdown();
```

## Storage

### In-Memory Storage

For testing and development:

```typescript
import { MemoryStorageAdapter } from '@multiplier-labs/stepflow';

const storage = new MemoryStorageAdapter();
```

### SQLite Storage

For single-process deployments:

```typescript
import Database from 'better-sqlite3';
import { SQLiteStorageAdapter } from '@multiplier-labs/stepflow';

const db = new Database('./workflows.db'); // File path or ':memory:'
const storage = new SQLiteStorageAdapter({ db });
```

### PostgreSQL Storage

For production use with distributed workers:

```typescript
import { PostgresStorageAdapter } from '@multiplier-labs/stepflow';

// Option 1: Connection string
const storage = new PostgresStorageAdapter({
  connectionString: 'postgresql://user:pass@localhost:5432/myapp',
  schema: 'myapp', // Optional, defaults to 'public'
});

// Option 2: Share existing connection pool
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter({ pool });
```

**Note:** `pg` and `kysely` are optional peer dependencies. They are loaded dynamically at runtime only when `PostgresStorageAdapter` is initialized, so users of other storage backends are not affected.

PostgreSQL storage provides:
- **Atomic dequeue**: Safe concurrent processing with `FOR UPDATE SKIP LOCKED`
- **Connection pooling**: Share database connections with your application
- **Schema isolation**: Custom schema names for multi-tenant deployments
- **Stale workflow cleanup**: Automatic timeout handling

## Event Transports

### Memory Events

Simple in-memory event emitter:

```typescript
import { MemoryEventTransport } from '@multiplier-labs/stepflow';

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
import { SocketIOEventTransport } from '@multiplier-labs/stepflow';

const io = new Server(httpServer);
const events = new SocketIOEventTransport({ io });

const engine = new WorkflowEngine({ storage, events });

// Set up client handlers with authorization
io.on('connection', (socket) => {
  events.setupClientHandlers(socket, async (runId, socket) => {
    return /* authorization check */;
  });
});

// Client-side:
// socket.emit('workflow:subscribe', runId);
// socket.on('workflow:event', (event) => console.log(event));
```

### Webhook Events

POST events to HTTP endpoints:

```typescript
import { WebhookEventTransport } from '@multiplier-labs/stepflow';

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
import Database from 'better-sqlite3';
import { CronScheduler, SQLiteSchedulePersistence, SQLiteStorageAdapter } from '@multiplier-labs/stepflow';

const db = new Database('./workflows.db');
const storage = new SQLiteStorageAdapter({ db });
const engine = new WorkflowEngine({ storage });

const schedulePersistence = new SQLiteSchedulePersistence({ db });
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
await scheduler.start();
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

## Planning System

Stepflow includes a rule-based planning system for dynamic workflow generation:

```typescript
import {
  RuleBasedPlanner,
  MemoryRecipeRegistry,
  MemoryStepHandlerRegistry,
  createRegistry,
} from '@multiplier-labs/stepflow';

// Create registries for recipes and step handlers
const { recipes, handlers } = createRegistry();

// Register recipes and handlers, then create plans
const planner = new RuleBasedPlanner({ recipeRegistry: recipes, handlerRegistry: handlers });
const plan = await planner.plan('process-order', { orderId: '123' });
```

See the [API Reference](docs/stepflow-api-reference.md#planning-system) for full documentation on recipes, step handlers, and planner configuration.

## API Reference

For the complete API reference including all classes, interfaces, and configuration options, see [docs/stepflow-api-reference.md](docs/stepflow-api-reference.md).

## Security

This project takes security seriously. The repository enforces:

- **Branch protection** on `main` with required PR reviews and status checks
- **CODEOWNERS** requiring designated reviewer approval for security-sensitive paths
- **Pinned GitHub Actions** to full commit SHAs to prevent supply-chain attacks
- **Automated dependency scanning** via Dependabot with weekly update PRs
- **npm audit** in CI on every pull request and weekly scheduled runs
- **Secret scanning** and **push protection** to prevent credential leaks

For vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Contributing

1. Fork the repository and create a feature branch from `main`
2. Ensure your changes pass all checks: `npm run typecheck && npm run build && npm test`
3. Open a pull request — CI will run automatically
4. A CODEOWNERS reviewer will be assigned based on the files changed

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a history of notable changes.

## License

MIT
