# Complexity Report: stepflow

**Date**: 2026-03-17T02:03:23.149Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 4a6551a1-f901-4d49-9a4f-97c8db653cd2
**Session**: cee8e151-a5cb-4331-8e03-2e491565eba0

---

## Summary

**Overall Complexity Rating: Low–Medium**

The codebase is a well-structured, TypeScript-first Node.js library (~14,359 lines including tests, ~6,300 source lines). Code is consistently organized, documented, and modular. The primary concerns are one very large storage adapter, duplicated condition-evaluation logic across two modules, an in-progress migration leaving parallel type hierarchies in `storage/types.ts`, and a few moderately complex orchestrator functions. No deeply dangerous nesting or god-class patterns exist.

| Key Metric | Value |
|---|---|
| Largest source file | `src/storage/postgres.ts` — 1,354 lines |
| Deepest nesting | 4 levels (`executeStep` retry loop → try → catch → if/else chains) |
| Most complex function | `orchestrator.ts:executeStep` — retry loop, 3 error strategies, hooks, timeout racing |
| Duplicate logic hotspot | `evaluateCondition` + `getNestedValue` in both `planner.ts` and `registry.ts` |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `src/storage/postgres.ts` | 1,354 | Full CRUD for runs/steps/events against PostgreSQL via Kysely; schema migration; row mapping | **High** |
| `src/core/engine.test.ts` | 1,364 | Test suite for WorkflowEngine (test file, not production code) | Low |
| `src/planning/planning.test.ts` | 727 | Test suite for planning subsystem | Low |
| `src/storage/sqlite.ts` | 635 | Full CRUD for runs/steps/events via better-sqlite3; prepared statements; row mapping | Medium |
| `src/core/engine.ts` | 691 | WorkflowEngine class: registration, run lifecycle, queue, resume, events | Medium |
| `src/core/orchestrator.ts` | 538 | Step + workflow execution, retry, cancellation, timeout, hooks | Medium |
| `src/scheduler/postgres-persistence.ts` | 499 | PostgreSQL persistence for cron schedules; read-modify-write update | Medium |
| `src/events/webhook.ts` | 488 | HTTP webhook delivery, HMAC signing, SSRF protection, concurrency queue | Medium |
| `src/planning/types.ts` | 565 | Type-only module: all planning domain types | Low |
| `src/scheduler/cron.ts` | 414 | CronScheduler: time-based + completion triggers, schedule management | Low |
| `src/planning/registry.ts` | 359 | In-memory recipe + step-handler registries | Low |
| `src/planning/planner.ts` | 574 | RuleBasedPlanner: recipe selection, plan generation, constraint application | Low |
| `src/storage/types.ts` | 341 | Storage interfaces (legacy + new, parallel hierarchies) | Medium |
| `src/index.ts` | 270 | Public barrel re-export (270 lines) | Low |
| `src/events/socketio.ts` | 265 | Socket.IO event transport adapter | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `orchestrator.ts:executeStep` | High (CC ~10) | `while(true)` retry loop with nested `try/catch`; 3 error strategies (`skip`, `retry`, `fail`); abort-signal checking; hook invocations; two timeout racing paths (`executeWithTimeout` vs `raceWithAbort`); ~150 lines of logic | Extract error-strategy dispatch into a separate `handleStepError()` helper; extract hook invocation into `invokeStepHooks()` |
| `orchestrator.ts:executeWorkflow` | Medium (CC ~8) | Manages run status lifecycle, step loop, checkpoint skipping, `skipIf` evaluation, hook calls (beforeRun/afterRun), timeout timer setup/teardown, error classification (timeout vs canceled vs failed) in a single ~220 line function | Split into `runStepLoop()` and `finalizeRun()` helpers to isolate the step iteration from error finalization |
| `storage/postgres.ts:createRun` / `updateRun` / `listRuns` | Medium | `listRuns` builds a complex Kysely query with 6 optional filter conditions and two sort axes; inline conditional chaining; pagination; the file's full-lifecycle logic spans ~900 lines across 3 tables | Split into `RunRepository`, `StepRepository`, `EventRepository` sub-classes or files |
| `scheduler/postgres-persistence.ts:updateSchedule` | Medium (CC ~6) | Read-modify-write cycle: fetches existing row, merges with incoming `updates`, then iterates a 12-entry `fieldMappings` array to build the update payload — not atomic, complex data flow | Use a direct partial-update pattern without a pre-fetch; build `updateData` directly from `updates` argument; accept the rare inconsistency or use a DB-level `COALESCE` pattern |
| `planning/registry.ts:evaluateCondition` | Medium (CC ~10) | 10-case `switch` statement; duplicates all logic from `planner.ts:evaluateCondition` verbatim | Extract shared `evaluateCondition` + `getNestedValue` into `planning/conditions.ts` and import from both |
| `planning/planner.ts:evaluateCondition` | Medium (CC ~10) | Identical 10-case `switch` as above | Same as above — eliminate via shared module |
| `events/webhook.ts:sendWebhook` | Medium (CC ~7) | Retry loop (up to `maxRetries+1` iterations), HMAC signing branch, payload-size guard, timeout abort via `AbortController`, error accumulation, exponential backoff | Extract retry loop into the existing `utils/retry.ts` `withRetry` utility; extract HMAC into `signPayload` (already done, good); small remaining cleanup |
| `core/engine.ts:waitForRun` | Medium (CC ~5) | Promise-based wait with dual cleanup paths (timeout + event unsubscribe), early-exit check against storage, nested async callback with its own try/catch — hard to reason about lifetime | Acceptable as-is, but could be simplified using `AbortSignal.timeout()` on Node 18+ to eliminate the manual `setTimeout`/`clearTimeout` pair |
| `storage/sqlite.ts:prepareStatements` | Low–Medium | Prepares 16 statements with positional parameters; the double-parameter binding pattern (e.g. `kind, kind`) used for optional `IS NULL OR =` guards is error-prone and not self-documenting | Add named constants or comments for each repeated-parameter pair; consider wrapping in a typed helper |
| `planning/planner.ts:generatePlan` | Low–Medium (CC ~5) | Applies three distinct modification passes (skip hints, additional config, constraints) using mutable `steps` reassignment; mixes read and write concerns | Extract constraint application (already partially done in `applyConstraints`) and hint application into their own helpers |

---

## Coupling & Cohesion Issues

1. **Duplicated condition-evaluation logic (`planner.ts` ↔ `registry.ts`)**
   - `evaluateCondition` (10-case switch) and `getNestedValue` (dot-notation traversal) are copy-pasted identically in both `src/planning/planner.ts` (lines 31–103) and `src/planning/registry.ts` (lines 263–336).
   - **Suggested fix:** Extract to `src/planning/conditions.ts` and import from both files. This is the highest-impact coupling issue in the codebase.

2. **Parallel type hierarchies in `storage/types.ts`**
   - The file ships two complete, independent storage contracts side-by-side: the legacy `StorageAdapter` + `WorkflowRunRecord` hierarchy and the newer `WorkflowStorage` + `ExtendedWorkflowRunRecord` hierarchy. The extended types add fields like `priority`, `timeoutMs`, `dequeueRun`, `cleanupStaleRuns` that are absent from the legacy interface but appear to be implemented (partially) by the Postgres adapter.
   - **Suggested fix:** Either complete the migration and deprecate the legacy interface in a minor version, or add clear `@deprecated` annotations and separation (e.g., `storage/types.legacy.ts`). As-is, it is unclear which interface new storage implementations should target.

3. **`storage/postgres.ts` is a monolithic god-module**
   - The 1,354-line file handles: Kysely initialization, schema creation+migration for 3 tables (6+ `CREATE TABLE`/`CREATE INDEX` statements), full CRUD for runs, full CRUD for steps, full CRUD for events, row-mapping functions, cleanup/pruning, and utility queries. Each responsibility could be a separate class.
   - **Suggested fix:** Split into `PostgresRunRepository`, `PostgresStepRepository`, `PostgresEventRepository`, each ~300 lines, composed by a `PostgresStorageAdapter` coordinator. Alternatively, at minimum extract the DDL into a `migrations.ts` file.

4. **`src/index.ts` as a leaky barrel export**
   - All 270 lines are re-exports. Both `StorageAdapter` (legacy) and `WorkflowStorage` (new) are exported at the top level with no clear guidance on which to use. The extended types (`ExtendedWorkflowRunRecord`, `ExtendedRunStatus`, `StepflowRunsTable`, `StepflowDatabase`) also leak implementation details that belong in internal types.
   - **Suggested fix:** Mark internal extended types with `@internal` JSDoc or move them behind the `./storage` sub-path export only.

5. **Module-level `any`-typed lazy-loaded peer dependencies (`postgres.ts`, `scheduler/postgres-persistence.ts`)**
   - Both files use `let Kysely: any; let PostgresDialect: any; let sql: any; let pgModule: any;` at module scope to support optional peer dependency loading. This pattern sacrifices all TypeScript safety for these symbols.
   - **Suggested fix:** The existing `loadPostgresDeps()` utility already returns typed deps. Widen the return type signature to use proper type imports (`import type`) at the call site or use a typed wrapper object.

6. **`CronScheduler` holds an in-memory schedule store that can diverge from persistence**
   - The scheduler maintains its own `Map<string, WorkflowSchedule>` as the source of truth and syncs writes to the persistence adapter. If the persistence layer is modified externally (e.g., by another process), the in-memory store is stale. `checkSchedules()` never re-reads from persistence.
   - **Suggested fix:** For distributed deployments, add an optional periodic `reloadSchedules()` call, or document clearly that `PostgresSchedulePersistence` is not safe for multi-instance use without distributed locking.

---

## Refactoring Candidates

**1. Extract shared condition evaluation to `src/planning/conditions.ts`**
- **Location:** `src/planning/planner.ts:31–103`, `src/planning/registry.ts:263–336`
- **Problem:** `evaluateCondition` (10-case switch) and `getNestedValue` are copy-pasted verbatim in both files. Any change to operator semantics (e.g., fixing the `matches` operator to compile the regex once rather than per-call) must be applied in two places.
- **Approach:** Create `src/planning/conditions.ts` with both exported functions; update both callers to import from there. Also opens the door to caching compiled `RegExp` instances.
- **Effort:** Small

**2. Split `src/storage/postgres.ts` into focused repository classes**
- **Location:** `src/storage/postgres.ts` (1,354 lines)
- **Problem:** One file owns schema migration, connection management, and full CRUD for three tables. Adding a fourth table, changing the schema, or switching from Kysely would require touching 1,300+ lines.
- **Approach:** Extract `PostgresRunRepository`, `PostgresStepRepository`, `PostgresEventRepository`, and a `PostgresMigrations` module. `PostgresStorageAdapter` becomes a thin coordinator. Each file stays under 300 lines.
- **Effort:** Medium

**3. Resolve the dual storage-interface hierarchy in `storage/types.ts`**
- **Location:** `src/storage/types.ts` (lines 230–293 vs 263–293)
- **Problem:** `WorkflowStorage` and `StorageAdapter` are parallel contracts that overlap significantly. Consumers don't know which to implement. `ExtendedWorkflowRunRecord` has `priority: number` (required) while `WorkflowRunRecord` has `priority?: number` (optional), creating inconsistency.
- **Approach:** Pick one interface as the target; deprecate the other with `@deprecated` and a migration guide. Update all adapters to implement the chosen interface. Remove the `Extended` prefix from types once migration is complete.
- **Effort:** Large (breaking API change, requires adapter updates and semver major)

**4. Decompose `orchestrator.ts:executeStep` into focused helpers**
- **Location:** `src/core/orchestrator.ts:executeStep` (~150 lines, lines 296–453)
- **Problem:** The function mixes retry-loop mechanics, hook invocation, event emission, timeout racing, and error-strategy dispatch. The `while(true)` with `try/catch` and three `if` branches for error strategy is hard to unit-test in isolation.
- **Approach:** Extract `invokeStepHooks(before/after/onError)`, `resolveErrorStrategy(onError, attempt, maxRetries)`, and reuse the existing `utils/retry.ts:withRetry` for the retry loop. `executeStep` becomes a coordinator.
- **Effort:** Medium

**5. Eliminate read-modify-write in `PostgresSchedulePersistence.updateSchedule`**
- **Location:** `src/scheduler/postgres-persistence.ts:updateSchedule` (lines 327–387)
- **Problem:** The method fetches the full existing row, merges it with incoming `updates`, and then writes all columns back. This is not atomic: two concurrent updates to different fields can stomp each other. It also introduces an extra DB round-trip on every update.
- **Approach:** Build the `SET` clause directly from `updates` using `COALESCE(?, column)` (same pattern used in the SQLite adapter), or use Kysely's built-in partial update with only the provided keys. The field-mapping array can stay but should operate on `updates` directly rather than on a merged object.
- **Effort:** Small

**6. Reuse `utils/retry.ts:withRetry` in `webhook.ts:sendWebhook`**
- **Location:** `src/events/webhook.ts:sendWebhook` (lines 299–364)
- **Problem:** A manual retry loop with exponential backoff is re-implemented, while `src/utils/retry.ts` already provides `withRetry` and `calculateRetryDelay`. The webhook retry logic diverges subtly (it uses `Math.pow(2, attempt)` directly rather than `calculateRetryDelay`).
- **Approach:** Wrap the single fetch attempt in `withRetry({ maxRetries, delay: retryDelay, backoff })`. This unifies retry semantics and removes ~20 lines from `sendWebhook`.
- **Effort:** Small

**7. Compile `RegExp` instances once in condition evaluation**
- **Location:** `src/planning/planner.ts:84–92`, `src/planning/registry.ts:317–325`
- **Problem:** The `matches` operator calls `new RegExp(conditionValue)` on every condition evaluation. If the same recipe is selected hundreds of times, the same regex is recompiled each time.
- **Approach:** After extracting to `conditions.ts` (candidate #1), add a module-level `Map<string, RegExp>` cache keyed on the pattern string. Reuse on subsequent calls. Also catches invalid regex at recipe registration time rather than silently returning `false` at runtime.
- **Effort:** Small (dependent on candidate #1)

**8. Introduce a `ScheduleStore` abstraction in `CronScheduler`**
- **Location:** `src/scheduler/cron.ts` (the in-memory `schedules` Map + persistence sync pattern)
- **Problem:** The scheduler has two sources of truth for schedule state: the in-memory `Map` (used for fast iteration) and the persistence adapter (used for durability). Every mutating operation must update both. In a multi-instance deployment, the in-memory map is stale.
- **Approach:** Introduce an internal `ScheduleStore` interface with `get`, `set`, `delete`, `values` methods. The memory-only implementation wraps the `Map`; a persistence-backed implementation wraps the adapter. `CronScheduler` works only against `ScheduleStore`. This opens the door to a future `poll-and-sync` store that re-reads from the DB on each tick.
- **Effort:** Medium

**9. Add explicit type annotations to lazy-loaded PostgreSQL deps**
- **Location:** `src/storage/postgres.ts:13–15`, `src/scheduler/postgres-persistence.ts:12–15`
- **Problem:** `let Kysely: any`, `let PostgresDialect: any`, `let sql: any`, `let pgModule: any` disable TypeScript checking for all usages of these symbols. A typo in a Kysely query builder call compiles silently.
- **Approach:** In `loadPostgresDeps()`, return a typed result object using `import type` from `kysely` and `pg`. Cast once at the call site (a single `as` cast), then all downstream usage is typed. The `any` module-level vars disappear.
- **Effort:** Small

**10. Reduce `src/index.ts` surface area by gating internal types to sub-path exports**
- **Location:** `src/index.ts` (lines 103–111)
- **Problem:** `StepflowRunsTable`, `StepflowStepResultsTable`, `StepflowDatabase`, `ExtendedWorkflowRunRecord`, `ExtendedRunStatus`, `ExtendedStepStatus`, and `ExtendedListRunsOptions` are DB schema / internal migration types exported from the root package. Library consumers should not need these for normal usage and their presence in the top-level API adds confusion.
- **Approach:** Move these types behind the `./storage` sub-path export (already defined in `package.json`). Remove them from the root `index.ts`. Any consumer who genuinely needs them can import from `stepflow/storage`.
- **Effort:** Small (may be a minor breaking change for consumers who import these from the root)