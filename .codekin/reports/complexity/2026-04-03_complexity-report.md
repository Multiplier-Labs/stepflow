# Complexity Report: stepflow

**Date**: 2026-04-03T20:01:36.000Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: ba52b549-8f86-4537-b95d-af7bbe803812
**Session**: 456e9325-f315-4a53-8b5f-e02d09d44a08

---

Now I have sufficient data to produce the full report.

## Summary

**Overall Complexity Rating: Medium**

The codebase is a TypeScript workflow orchestration library (~8,700 source lines across 19 source files, 14,600 including tests). It is well-structured overall, with clear module boundaries and good separation between execution, storage, scheduling, and events. The main complexity hotspots are: (1) `postgres.ts` at 1,354 lines — a large god class with dual interface implementations, (2) `orchestrator.ts:executeStep` — deeply nested retry/cancellation logic, and (3) an unresolved migration from a legacy `StorageAdapter` interface to a newer `WorkflowStorage` interface that introduces duplicated type hierarchies and dead code paths.

- **Largest file**: `src/storage/postgres.ts` — 1,354 lines
- **Deepest nesting**: `orchestrator.ts:executeStep` — ~4 levels in the retry/cancellation catch block
- **Most complex function**: `executeStep` in `orchestrator.ts` — ~185 lines, retry loop, 4 error paths, 5+ storage/event calls per iteration

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|------------------------|-------------------|
| `src/storage/postgres.ts` | 1,354 | PostgreSQL storage adapter (DDL + CRUD + extended API) | **High** |
| `src/core/engine.ts` | 692 | WorkflowEngine class (registry, run lifecycle, queue) | Medium |
| `src/storage/sqlite.ts` | 621 | SQLite storage adapter | Medium |
| `src/planning/planner.ts` | 576 | Rule-based recipe selection and plan generation | Low |
| `src/planning/types.ts` | 566 | Planning type definitions | Low |
| `src/core/orchestrator.ts` | 564 | Workflow + step execution logic | **High** |
| `src/events/webhook.ts` | 557 | Webhook event transport + SSRF protection | Medium |
| `src/scheduler/postgres-persistence.ts` | 512 | PostgreSQL schedule persistence | Medium |
| `src/scheduler/cron.ts` | 414 | CronScheduler (polling + event triggers) | Low |
| `src/planning/registry.ts` | 365 | Recipe and step handler registries | Low |
| `src/storage/types.ts` | 342 | Storage interface definitions (legacy + new) | **High** |
| `src/index.ts` | 270 | Public API re-exports | Low |
| `src/events/socketio.ts` | 262 | Socket.IO event transport | Low |
| `src/scheduler/sqlite-persistence.ts` | 261 | SQLite schedule persistence | Low |
| `src/storage/memory.ts` | 227 | In-memory storage adapter | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---------------|---------------------|-------------------|---------------------|
| `orchestrator.ts:executeStep` | High | ~185 lines; infinite `while(true)` retry loop; 4 distinct exit paths (success, skip, retry, fail); 5+ storage/event calls per iteration; 4-level nesting in catch block | Extract `handleStepError()` and `executeStepWithTimeout()` helper; separate retry orchestration from event emission |
| `orchestrator.ts:executeWorkflow` | High | ~220 lines; manages hooks, checkpointing, timeouts, cancellation, success/failure divergence; complex error classification logic (lines 237–244) | Split into `runSteps()` + `finalizeRun()` helpers; extract error classification into a pure function |
| `postgres.ts:createTables` | High | ~155 lines; 20+ sequential `sql\`...\`.execute(this.db)` calls; mixes initial DDL with alter-column migration; silent `.catch(() => {})` suppresses errors | Split into `createSchemaTables()` and `runMigrations()`; use a proper migration runner; avoid silent catch |
| `postgres.ts:mapRunRow` | Medium | Repeated `typeof row.X === 'string' ? JSON.parse(row.X) : row.X` guard on every JSON column — 8 repetitions in one function | Extract a `parseJsonColumn(col: unknown): unknown` helper shared across all map methods |
| `postgres.ts:createRun` | Medium | Accepts a union type `CreateRunInput \| Omit<WorkflowRunRecord, …>` — forces `'id' in run`, `'parentRunId' in run`, etc. inline discriminators throughout the method body | Consolidate to a single input type; bridge at the call site rather than inside the method |
| `sqlite.ts:prepareStatements` | Medium | Bulk-prepares 15 SQL statements in one method; `listRuns` uses double-binding pattern (`kind, kind`, `statusJson, statusJson`) which is fragile and easily mis-ordered | Each statement can be lazily prepared on first use; document or encapsulate the double-bind idiom |
| `planner.ts:generatePlan` | Medium | Applies three independent mutation passes (hints, constraints, config) over the steps array using nested loops; emits `PlanModification` records as a side effect | Extract `applyHints()`, `applyAdditionalConfig()` as pure functions returning `{ steps, modifications }` |
| `engine.ts:startRun` | Medium | Handles both the immediate-start and queue paths, emits multiple events, performs queue insertion — 60 lines with branching and inline event building | Extract `enqueueOrExecute()` helper to isolate the concurrency decision; move event building to a factory |
| `webhook.ts:sendWebhook` | Medium | Retry loop, timeout via AbortController, SSRF re-validation on every send, payload signing, concurrency queue interaction — all in one method | SSRF validation at `addEndpoint` time only (URL is static); extract `buildHeaders()` |
| `planner.ts:evaluateCondition` | Low–Medium | 10-case switch statement; regex instantiated on every call via `new RE2(conditionValue)` inside the `matches` branch | Cache compiled RE2 instances per pattern; no structural issue but the hot-path instantiation is a performance concern |

---

## Coupling & Cohesion Issues

1. **Dual storage interface (`StorageAdapter` vs. `WorkflowStorage`) in `storage/types.ts`**
   - **Problem**: The file defines two nearly-identical storage interfaces: the legacy `StorageAdapter` (used by the engine) and a new `WorkflowStorage` (used by `PostgresStorageAdapter` internally). `PostgresStorageAdapter` implements both simultaneously. This doubles the number of types for runs/steps (`WorkflowRunRecord` vs. `ExtendedWorkflowRunRecord`, `RunStatus` vs. `ExtendedRunStatus`, `StepStatus` vs. `ExtendedStepStatus`, `ListRunsOptions` vs. `ExtendedListRunsOptions`).
   - **Suggested Fix**: Pick one interface as canonical and migrate all adapters to it; keep the other as a shim alias during transition. The duplicated status union types should be unified.

2. **`postgres.ts` is a god class**
   - **Problem**: `PostgresStorageAdapter` (1,354 lines) is responsible for: connection pool management, lazy dependency loading, DDL/migration, all CRUD operations for three tables, the extended `WorkflowStorage` API (7 additional methods), row-mapping helpers, atomic dequeue, and transaction wrapping. Unrelated responsibilities are co-located.
   - **Suggested Fix**: Extract `PostgresMigrationRunner` (DDL), `PostgresRunRepository`, and `PostgresStepRepository` as internal collaborators.

3. **Lazy-loaded module globals in `postgres.ts` and `postgres-persistence.ts`**
   - **Problem**: `let Kysely: any; let PostgresDialect: any; let sql: any; let pgModule: any;` are module-level mutable variables populated by `loadPostgresDeps()` during `initialize()`. These are effectively global singletons shared across all adapter instances. Concurrent `initialize()` calls could create a race condition. All type safety is lost (`any`).
   - **Suggested Fix**: Store loaded dependencies as instance properties populated in `initialize()`, or use a module-level `Promise` cache so the load happens exactly once and the result is strongly typed.

4. **`executeStep` is tightly coupled to storage, events, logger, and abort controller**
   - **Problem**: The function signature passes a 5-field `StepExecutionOptions` object, and inside it makes direct calls to `storage.createStep`, `storage.updateStep`, `events.emit` (×5–6 per iteration), `definition.hooks.*` (×3), and `abortController.signal`. It is essentially untestable in isolation without mocking all infrastructure.
   - **Suggested Fix**: Extract an `StepExecutionContext` interface that provides `onStarted`, `onSucceeded`, `onFailed`, `onCanceled` callbacks; the orchestrator wires these to storage/events; the step function only calls the context.

5. **`executeRun` is a no-op pass-through in `engine.ts`**
   - **Problem**: `executeRun` (lines 324–332) calls `launchRun` with identical arguments. It exists only as an indirection, adding a layer of abstraction with no logic.
   - **Suggested Fix**: Remove `executeRun`; call `launchRun` directly from `startRun` and `processQueue`.

6. **`SQLiteStorageAdapter.transaction()` misrepresents its async contract**
   - **Problem**: The `transaction()` method (marked `@deprecated`) has an `async` signature but actually runs synchronously via `better-sqlite3`. The JSDoc warns "only works for synchronous operations," but callers expecting async-safe semantics will be misled.
   - **Suggested Fix**: Remove the method (it is already deprecated); expose only `transactionSync()`.

---

## Refactoring Candidates

1. **Unify the dual storage interface hierarchy**
   - **Location**: `src/storage/types.ts`, `src/storage/postgres.ts`, `src/storage/sqlite.ts`, `src/storage/memory.ts`
   - **Problem**: Two parallel type families (`StorageAdapter`/`WorkflowStorage`, `WorkflowRunRecord`/`ExtendedWorkflowRunRecord`, `RunStatus`/`ExtendedRunStatus`) exist as an in-progress migration that was never completed. All consumers must understand both, and `PostgresStorageAdapter` implements both simultaneously.
   - **Suggested Approach**: Merge the two interfaces; remove the `Extended*` duplicates by upgrading `RunStatus` to include `'pending'` and `'timeout'` and adding `output` to the base record. Adapters can implement a single interface.
   - **Effort**: Large

2. **Extract `PostgresMigrationRunner` from `PostgresStorageAdapter`**
   - **Location**: `src/storage/postgres.ts:314–465` (`createTables`)
   - **Problem**: 155 lines of sequential DDL mixed with the adapter. It also silently swallows `ALTER TABLE` errors, making it hard to reason about migration state.
   - **Suggested Approach**: Move all DDL into a standalone `PostgresMigrationRunner` class with versioned migrations and explicit error handling. `PostgresStorageAdapter` calls `runner.migrate()` during `initialize()`.
   - **Effort**: Medium

3. **Decompose `executeStep` in the orchestrator**
   - **Location**: `src/core/orchestrator.ts:296–479`
   - **Problem**: ~185-line function with 4 exit paths, 4-level nesting, and direct coupling to all infrastructure. The retry delay sleep path duplicates cancellation handling from the outer path.
   - **Suggested Approach**: Extract `handleStepSuccess()`, `handleStepCancellation()`, and `handleStepRetry()` — each taking the step record and emitting the right events/storage calls. The main function becomes a loop calling these.
   - **Effort**: Medium

4. **Fix lazy-loaded dependency globals in postgres adapters**
   - **Location**: `src/storage/postgres.ts:13–16`, `src/scheduler/postgres-persistence.ts:11–15`
   - **Problem**: `let Kysely: any` etc. as module-level mutable globals. Both files duplicate this pattern. Type safety lost, race condition risk on concurrent initialization.
   - **Suggested Approach**: Create a shared `src/utils/postgres-deps.ts` module (it may partially exist as `loadPostgresDeps`) that returns a typed, promise-cached result; store the resolved deps as instance properties.
   - **Effort**: Small

5. **Cache RE2 instances in `evaluateCondition`**
   - **Location**: `src/planning/planner.ts:88–93`
   - **Problem**: `new RE2(conditionValue)` is called on every condition evaluation. In a hot planning path with many recipes and conditions, this allocates a new compiled regex object on each call.
   - **Suggested Approach**: Add a `Map<string, RE2>` cache at module scope or on the `RuleBasedPlanner` instance; look up or create before matching.
   - **Effort**: Small

6. **Remove `executeRun` pass-through in `WorkflowEngine`**
   - **Location**: `src/core/engine.ts:323–332`
   - **Problem**: `executeRun` adds a layer of indirection with zero logic, making the call chain harder to follow (`startRun → executeRun → launchRun`).
   - **Suggested Approach**: Delete `executeRun`; call `launchRun` directly from `startRun` (line 270) and `processQueue` (line 392).
   - **Effort**: Small

7. **Extract a `parseJsonColumn` helper in `postgres.ts` row mappers**
   - **Location**: `src/storage/postgres.ts:861–940` (four `map*Row` methods)
   - **Problem**: The guard `typeof row.X === 'string' ? JSON.parse(row.X) : row.X` is repeated ~10 times across four mapper methods, indicating that Kysely returns JSONB as either a string or a parsed object depending on configuration.
   - **Suggested Approach**: Extract `parseJsonColumn(col: unknown): unknown` and call it from all mappers. Alternatively, configure Kysely with a `pg.types.setTypeParser` for the JSONB OID to always return parsed objects, eliminating the guard entirely.
   - **Effort**: Small

8. **Encapsulate the SQLite double-binding pattern**
   - **Location**: `src/storage/sqlite.ts:329–341` (`listRuns`)
   - **Problem**: Prepared statements use `? IS NULL OR field = ?` which requires each parameter to be passed twice: `kind, kind` / `statusJson, statusJson` / `parentRunId, parentRunId`. This is fragile — if parameter order changes, bugs are silent.
   - **Suggested Approach**: Add a small helper `nullableParam(val)` returning `[val, val]` to make the doubling explicit and documented, or switch to Kysely for SQLite queries to get type-safe query building.
   - **Effort**: Small

9. **Remove or complete the deprecated `SQLiteStorageAdapter.transaction()` method**
   - **Location**: `src/storage/sqlite.ts:440–446`
   - **Problem**: The `async transaction()` method has a misleading contract — it wraps a synchronous transaction with an async signature, only works if the callback does no real async I/O, and is deprecated. It remains in the public API creating a footgun.
   - **Suggested Approach**: Remove the method in the next minor version (or immediately if semver allows). Consumers should use `transactionSync()`. Add a clear deprecation notice in the changelog.
   - **Effort**: Small

10. **Consolidate magic timeout/retry defaults into named constants**
    - **Location**: `src/core/orchestrator.ts:304–307`, `src/core/engine.ts:484`, `src/events/webhook.ts:145–151`
    - **Problem**: Default values like `maxRetries: 3`, `retryDelay: 1000`, `retryBackoff: 2`, `timeout: 60000`, `defaultTimeout: 5000` are magic numbers scattered across files. They are inconsistent (`orchestrator.ts` defaults `maxRetries` to 3 inline; `webhook.ts` defaults `defaultRetries` to 3 separately).
    - **Suggested Approach**: Collect all engine defaults into a `src/core/defaults.ts` constants file (`DEFAULT_MAX_RETRIES`, `DEFAULT_RETRY_DELAY_MS`, `DEFAULT_WAIT_TIMEOUT_MS`, etc.) and reference them everywhere.
    - **Effort**: Small