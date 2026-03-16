# Complexity Report: stepflow

**Date**: 2026-03-16T14:08:54.739Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: cdbcdce1-aacc-41e6-a6d2-5867f4cad089
**Session**: 18a0fdd1-9de2-4759-9c9c-71ead2b7c1bc

---

## Summary

**Overall Complexity Rating: Medium**

The codebase is a TypeScript workflow orchestration library (~13,400 lines total). It is well-structured for its domain, but several files have grown into "god" classes handling too many concerns. The heaviest complexity concentrates in the PostgreSQL storage adapter and the orchestrator's step execution loop. The dual storage interface hierarchy (legacy `StorageAdapter` vs. new `WorkflowStorage`) is the most significant architectural debt.

| Key Metric | Value |
|---|---|
| Total source lines (excl. tests/node_modules) | ~7,200 |
| Largest file | `src/storage/postgres.ts` — 1,336 lines |
| Deepest nesting | `executeStep` in `orchestrator.ts` — 4 levels (while → try/catch → if/else → nested catch) |
| Most complex function | `executeStep` — cyclomatic complexity ~12 |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `src/storage/postgres.ts` | 1,336 | PostgreSQL storage adapter — schema creation, run/step/event CRUD, dequeue, row mapping | **High** |
| `src/core/engine.test.ts` | 1,272 | Unit/integration tests for WorkflowEngine | Low (test file) |
| `src/core/engine.ts` | 679 | WorkflowEngine class — registration, run lifecycle, queue, resume | Medium |
| `src/planning/planning.test.ts` | 659 | Planning subsystem tests | Low (test file) |
| `src/storage/sqlite.ts` | 639 | SQLite storage adapter — schema, prepared statements, CRUD, row mapping | Medium |
| `src/planning/types.ts` | 559 | All planning type declarations (recipes, plans, registries, conditions) | Medium |
| `src/planning/planner.ts` | 555 | Rule-based planner — recipe selection, plan generation, constraint application | Medium |
| `src/core/orchestrator.ts` | 538 | Step execution engine — workflow loop, retries, hooks, abort | **High** |
| `src/scheduler/postgres-persistence.ts` | 504 | PostgreSQL persistence for schedules — schema, CRUD, row mapping | Medium |
| `src/storage/sqlite.test.ts` | 448 | SQLite adapter tests | Low (test file) |
| `src/events/webhook.test.ts` | 442 | Webhook transport tests | Low (test file) |
| `src/scheduler/cron.ts` | 415 | CronScheduler — polling, event subscription, schedule management | Low |
| `src/scheduler/cron.test.ts` | 409 | CronScheduler tests | Low (test file) |
| `src/planning/registry.ts` | 340 | In-memory recipe and handler registries | Low |
| `src/storage/types.ts` | 338 | Storage interface types — dual legacy + extended hierarchy | **High** |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `orchestrator.ts:executeStep` (L296–453) | Cyclomatic ~12 | 158-line while-loop with 4-level nesting: retry loop → try/catch → `onError` branching → nested hook error catch. Handles retries, timeouts, three error strategies, two hook call-sites, and event emission in one function. | Extract retry logic into a `retryStep()` helper; extract hook invocation into a `runStepHooks()` helper. |
| `orchestrator.ts:executeWorkflow` (L63–280) | Cyclomatic ~8 | 218-line function managing workflow lifecycle: status updates, checkpoint restore, per-step iteration with skip conditions, workflow timeout, and the entire success/failure result path. | Split into `runSteps()` and a thin `executeWorkflow()` orchestrator that handles only status transitions. |
| `postgres.ts:createTables` (L293–443) | Sequential complexity ~15 | 150-line function issuing 15+ sequential SQL `await` calls with embedded DDL strings and a silently-ignored ALTER TABLE migration. | Split into `createRunsTable()`, `createStepsTable()`, `createEventsTable()`, and a `runMigrations()` helper. |
| `postgres.ts:listRuns` (L545–604) | Cyclomatic ~7 | Filter conditions are manually duplicated to build both the data query and the `COUNT(*)` query. Any new filter must be added twice. | Extract a `buildRunsFilter()` helper and apply it to both queries. |
| `postgres-persistence.ts:updateSchedule` (L325–392) | Cyclomatic ~13 | 12 independent `if (updates.X !== undefined)` branches to map domain fields to DB columns. Verbose and tedious to extend. | Use a field-mapping table (`{ domainKey, dbKey, serialize }[]`) driven by a loop. |
| `engine.ts:resumeRun` (L503–564) | Structural duplication | 30+ lines of near-identical async execution closure copied from `executeRun`. Any change to execution setup must be applied in two places. | Unify into a single `launchExecution(runId, definition, input, options)` helper. |
| `sqlite.ts:transaction` (L445–464) | Reliability risk | The async `transaction()` wrapper silently returns `undefined` if the callback contains real async I/O (network, timers). The anti-pattern is documented but still a trap for callers. | Rename to `transactionSync()` only; remove the async overload or throw a clearer error. |
| `planner.ts:applyConstraints` (L443–495) | Cyclomatic ~6 | Maps constraints to step mutations via a chain of independent `if` blocks; each constraint is a separate map pass, leading to O(n×c) iterations. | Apply all constraint mutations in a single `steps.map()` pass. |
| `planner.ts:estimateResources` (L402–416) | Magic constants | Uses three unexplained hard-coded estimates (`baseApiCallsPerStep = 1`, `baseTokensPerStep = 500`, `baseDurationPerStep = 2000`) with no way to customise them. | Expose as configurable `RuleBasedPlannerConfig` fields with sensible defaults. |
| `postgres.ts:createRun` (L454–493) | Type branching | Method accepts a union `CreateRunInput | Omit<WorkflowRunRecord, ...>` and uses `'id' in run`, `'parentRunId' in run` runtime type guards throughout. Makes every branch harder to follow. | Accept a single normalised input type; convert legacy callers at the boundary. |

---

## Coupling & Cohesion Issues

1. **`src/storage/postgres.ts` — God class implementing two interfaces**
   The class implements `StorageAdapter` (legacy, keyed around `workflow_run_steps` / `workflow_events`) and also exposes `WorkflowStorage`-flavoured methods (`dequeueRun`, `getStepResult`, `getStepsForRun` over `stepflow_step_results`). Two separate table schemas co-exist in one class. The result is 1,336 lines of mixed responsibilities.
   *Suggested fix*: Extract a `PostgresWorkflowStorage` class (new interface, new tables) and keep `PostgresStorageAdapter` thin for the legacy `StorageAdapter` interface. Let the user choose which one to instantiate.

2. **`src/storage/types.ts` — Dual type hierarchy**
   The file contains two complete, overlapping type systems: the legacy (`StorageAdapter`, `WorkflowRunRecord`, `RunStatus`) and the new (`WorkflowStorage`, `ExtendedWorkflowRunRecord`, `ExtendedRunStatus`). Many fields differ only in naming convention (`status` vs `ExtendedRunStatus`, `succeeded` vs `completed` for steps). This doubles the cognitive overhead for all callers and contributes to the union-type `createRun` signature.
   *Suggested fix*: Pick one model and migrate the other to it, or at minimum clearly mark legacy types `@deprecated` and remove them in the next minor version.

3. **Duplicated lazy-loading pattern in `postgres.ts` and `postgres-persistence.ts`**
   Both files independently declare module-level variables (`let Kysely: any; let PostgresDialect: any; let sql: any; let pgModule: any;`) and a nearly identical `loadDependencies()` async function. Any change to the loading strategy must be applied in two places.
   *Suggested fix*: Extract a shared `loadPostgresDeps()` utility in `src/utils/postgres-deps.ts`.

4. **`src/core/engine.ts` — Mixed registration and lifecycle management**
   `WorkflowEngine` handles workflow registration (`registerWorkflow`, `unregisterWorkflow`, `getWorkflow`), run lifecycle (`startRun`, `cancelRun`, `resumeRun`, `waitForRun`), the in-process priority queue (`queueRun`, `processQueue`), and storage/event access delegation. All in one class, 679 lines.
   *Suggested fix*: Extract `WorkflowRegistry` as a standalone class. The queue management could similarly be isolated, making `WorkflowEngine` a thin coordinator.

5. **`src/planning/types.ts` — Type-only file grown too large**
   At 559 lines, this file defines all planning types in one place: conditions, recipes, plans, planner interface, registry interfaces, constraints, hints. Changes to any part require navigating the full file.
   *Suggested fix*: Split into `recipe-types.ts`, `plan-types.ts`, `registry-types.ts`, and re-export from a barrel `types/index.ts`.

---

## Refactoring Candidates

1. **Split `src/storage/postgres.ts` by concern**
   *Location*: `src/storage/postgres.ts` (1,336 lines)
   *Problem*: Single file combines lazy-loading, two complete schema definitions (4 tables), two interface implementations with different field naming conventions, and full CRUD for each. Adding any new storage feature requires navigating 1,300+ lines.
   *Approach*: Extract into `postgres-schema.ts` (DDL + `createTables`), `postgres-run-ops.ts`, `postgres-step-ops.ts`, `postgres-event-ops.ts`, and `postgres-extended-ops.ts` (new `WorkflowStorage` methods). Keep `postgres.ts` as a thin façade that composes them.
   *Effort*: **Large**

2. **Resolve the dual-interface type hierarchy in `src/storage/types.ts`**
   *Location*: `src/storage/types.ts`
   *Problem*: Two parallel type systems (`StorageAdapter`/`WorkflowRunRecord` vs `WorkflowStorage`/`ExtendedWorkflowRunRecord`) with incompatible status enums (`succeeded` vs `completed` for steps). Callers must know which interface they're using; `postgres.ts` accepts both via runtime type guards.
   *Approach*: Deprecate the legacy types; add a `@deprecated` JSDoc tag and a migration note in README. Target removal in the next major version. In the interim, provide an `adaptLegacy(record: WorkflowRunRecord): ExtendedWorkflowRunRecord` conversion helper to ease migration.
   *Effort*: **Medium**

3. **Extract shared Postgres dependency loader**
   *Location*: `src/storage/postgres.ts` L11–44, `src/scheduler/postgres-persistence.ts` L11–36
   *Problem*: Module-level `any`-typed variable declarations and a `loadDependencies()` function are copy-pasted verbatim between the two files. Future adapters will repeat the same boilerplate.
   *Approach*: Create `src/utils/postgres-deps.ts` that exports `loadPostgresDeps(): Promise<{ Kysely, PostgresDialect, sql, Pool }>` with the idempotent loading logic, shared by both files.
   *Effort*: **Small**

4. **Unify `executeRun` and `resumeRun` execution closures in `engine.ts`**
   *Location*: `src/core/engine.ts` L324–362 and L503–563
   *Problem*: Both methods build an identical async closure that calls `executeWorkflow`, registers an `AbortController`, cleans up `activeRuns`, and calls `processQueue` in a `finally` block. The 30+ duplicated lines will diverge over time.
   *Approach*: Extract a private `launchRun(runId, definition, input, metadata, delay?, checkpoint?)` method. Both `executeRun` and `resumeRun` delegate to it.
   *Effort*: **Small**

5. **Extract `executeStep` retry/error logic from `orchestrator.ts`**
   *Location*: `src/core/orchestrator.ts:executeStep` L296–453
   *Problem*: A 158-line function mixes retry-loop control, hook invocations, step record persistence, event emission, and three error strategies in a single deeply nested structure. It is the hardest function to unit-test and the most likely to regress.
   *Approach*: Extract `shouldRetryStep(error, attempt, strategy, maxRetries)` predicate and `invokeStepHooks(hooks, context, step, phase)` helper. The retry while-loop becomes a ~30-line function delegating to these helpers.
   *Effort*: **Medium**

6. **Replace polling in `waitForRun` with event subscription**
   *Location*: `src/core/engine.ts:waitForRun` L464–488
   *Problem*: The method polls the storage adapter every 100ms. Under any storage backend this is unnecessary latency and extra load; events already signal run completion.
   *Approach*: Subscribe to `run.completed`, `run.failed`, `run.canceled`, and `run.timeout` events for the given `runId`. Fall back to a single storage read to avoid a race condition at subscription time. Remove the `setInterval` loop.
   *Effort*: **Small**

7. **Make `SQLiteStorageAdapter.transaction()` safe or remove it**
   *Location*: `src/storage/sqlite.ts` L445–464
   *Problem*: The async `transaction()` overload silently returns `undefined` if the callback awaits real I/O. This is an invisible correctness hazard — no error is thrown and no data is rolled back, yet the code appears to succeed.
   *Approach*: Remove the async `transaction(fn: (tx) => Promise<T>)` overload entirely and keep only `transactionSync(fn: () => T)`. If an async-compatible transaction API is needed for interface parity, throw `new Error('SQLiteStorageAdapter does not support async transactions')` immediately, forcing callers to use `transactionSync`.
   *Effort*: **Small**

8. **Eliminate duplicated filter building in `PostgresStorageAdapter.listRuns`**
   *Location*: `src/storage/postgres.ts:listRuns` L545–604
   *Problem*: Filter conditions (`kind`, `status`, `parentRunId`) are applied to both the main select query and a separate count query. All three filters must be maintained twice; the count query diverges from the data query each time a new filter is added.
   *Approach*: Extract `applyRunsFilters<T>(query: T, options: ListRunsOptions): T` as a generic Kysely query modifier. Apply it to both query builders.
   *Effort*: **Small**