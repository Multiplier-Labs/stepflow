# Complexity Report: stepflow

**Date**: 2026-04-11T02:46:40.781Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 7c4174ae-8cba-4ad8-9a30-b2f56cf4c98b
**Session**: 474ba458-5157-4ff3-8ef4-802b1bc389e5

---

Now I have enough information to produce the report.

## Summary

**Overall Complexity Rating: Medium**

The codebase is a TypeScript workflow orchestration library (~14,300 lines across source + tests). The implementation is generally clean and well-structured, but several files are oversized, the storage layer has two parallel interface lineages with significant duplication, and the orchestrator's `executeStep` function carries the highest cyclomatic complexity. No deeply pathological nesting exists, but coupling between the `postgres.ts` adapter and two different storage interfaces is the most acute maintenance risk.

Key metrics:
- **Largest file:** `src/storage/postgres.ts` — 1,354 lines
- **Deepest nesting:** `executeStep` in `orchestrator.ts` — 4–5 levels (`while → try → if → if → try`)
- **Most complex function:** `executeStep` — retry loop, cancellation guards, hooks, event emission, 4 error-handling branches
- **Duplicate interface footprint:** `StorageAdapter` vs. `WorkflowStorage` — two complete CRUD contracts implemented in the same `postgres.ts` class

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|------------------------|-------------------|
| `src/storage/postgres.ts` | 1,354 | PostgreSQL adapter (implements both `StorageAdapter` and `WorkflowStorage`) | **High** |
| `src/core/engine.test.ts` | 1,364 | Engine integration tests | Low (test file) |
| `src/planning/planning.test.ts` | 727 | Planner integration tests | Low (test file) |
| `src/events/webhook.test.ts` | 657 | Webhook transport tests | Low (test file) |
| `src/core/engine.ts` | 692 | `WorkflowEngine` class — run lifecycle, queue, resume | Medium |
| `src/storage/sqlite.ts` | 621 | SQLite adapter | Medium |
| `src/planning/planner.ts` | 576 | `RuleBasedPlanner` — recipe selection, plan generation | Low |
| `src/planning/types.ts` | 566 | Planning domain types (Recipe, Plan, Planner interfaces) | Low |
| `src/core/orchestrator.ts` | 564 | Step execution loop, retry logic, hooks | **High** |
| `src/events/webhook.ts` | 557 | WebhookEventTransport — SSRF guards, signing, concurrency | Medium |
| `src/scheduler/postgres-persistence.ts` | 512 | PostgreSQL schedule persistence | Low |
| `src/scheduler/cron.ts` | 414 | CronScheduler — polling + event-driven triggers | Low |
| `src/storage/types.ts` | 342 | Storage type definitions (two parallel interface families) | **High** |
| `src/events/socketio.ts` | 262 | Socket.IO event transport | Low |
| `src/index.ts` | 270 | Public API barrel file | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---------------|---------------------|-------------------|---------------------|
| `orchestrator.ts:executeStep` | Very High (CC ~12) | Single `while(true)` loop wraps: `AbortSignal` check, step record creation, `beforeStep` hook, conditional timeout vs. `raceWithAbort`, `afterStep` hook, cancellation detection, `onStepError` hook, three error branches (`skip`/`retry`/`fail`), sleep-with-abort, and re-throw. 4–5 nesting levels. | Extract `handleStepError(error, attempt, strategy)` and `executeStepOnce(step, context, options)` as separate functions |
| `orchestrator.ts:executeWorkflow` | High (CC ~8) | Combines run status update, event emission, context construction, timeout setup, `beforeRun` hook, step loop with skip checks, `afterRun` hook, success/failure/timeout/cancel branching in one try/catch | Split success path and failure classification into `finalizeSuccess()` / `finalizeFailure()` helpers |
| `storage/postgres.ts:createTables` | High (CC ~7) | 150-line method issues 15+ raw SQL statements sequentially with ad-hoc `catch(() => {})` for ALTER TABLE idempotency. No migration versioning. | Replace with a proper migration runner (numbered migration files or Kysely-migrate) |
| `storage/postgres.ts:mapRunRow` | Medium (CC ~6) | Repeated `typeof x === 'string' ? JSON.parse(x) : x` ternary for every JSONB column (6 occurrences in `mapRunRow` alone, duplicated in `mapExtendedRunRow`) | Extract `parseJsonColumn<T>(col: string | T): T` helper; used in all `mapXRow` methods |
| `events/webhook.ts:sendWebhook` | Medium (CC ~6) | Retry loop with DNS validation re-run on every attempt, payload size check, dynamic header assembly, HMAC signing, and `AbortController` per attempt | Extract `deliverOnce(url, headers, body, timeout)` and call from `sendWebhookWithRetry` |
| `events/webhook.ts:isBlockedHost` | Medium (CC ~9) | Flat function with 9 early-return branches testing IPv4 ranges, IPv6 literals, loopback, link-local — logic duplicated almost identically in `isBlockedIp` | Merge `isBlockedHost` and `isBlockedIp` into a single `isBlockedAddress(address: string)` that handles both hostname and resolved-IP cases |
| `planner.ts:selectRecipe` | Medium (CC ~6) | Three sequential priority checks (forced, preferred, scored) each with early returns, plus a fallback chain of two more returns | Already reasonably structured; document the scoring ladder with inline comments |
| `storage/postgres.ts:updateRun` | Medium (CC ~5) | Builds `updateData` object via 6 independent `if` guards covering two different input shapes (`UpdateRunInput` and `Partial<WorkflowRunRecord>`) simultaneously | Accept only `UpdateRunInput`; deprecate the `Partial<WorkflowRunRecord>` overload |
| `engine.ts:waitForRun` | Medium (CC ~5) | Interleaves early-return for already-completed runs with Promise-based event subscription, dual cleanup via `cleanup()` closure, nested `try/catch` inside the event callback | Extract the Promise setup into a `awaitRunEvent(runId, timeout)` utility |
| `planner.ts:evaluateCondition` | Low-Medium (CC ~11) | Large `switch` on 9 operators; each case is self-contained but the function is called in a hot loop for every condition on every recipe | Acceptable as-is; consider a `conditionEvaluators: Record<ConditionOperator, Evaluator>` map if operators are user-extensible |

---

## Coupling & Cohesion Issues

**1. `storage/postgres.ts` implements two unrelated storage interfaces**

`PostgresStorageAdapter` simultaneously implements `StorageAdapter` (the legacy interface with `WorkflowRunRecord`, `WorkflowRunStepRecord`) and `WorkflowStorage` (the newer interface with `ExtendedWorkflowRunRecord`, `StepResult`). This means `postgres.ts` contains two nearly identical sets of CRUD methods (`createRun`/`getRun`/`updateRun` in both shapes), two `mapRunRow` functions (`mapRunRow` and `mapExtendedRunRow`) that differ only in the target type, and two separate status type hierarchies (`RunStatus` vs. `ExtendedRunStatus`). Any schema change must be applied in multiple places.

*Suggested fix:* Decide on one canonical interface. If `WorkflowStorage` is the future, mark `StorageAdapter` as deprecated and migrate callers. Provide an adapter shim for backward compatibility during the transition rather than carrying both implementations indefinitely.

**2. `storage/types.ts` defines two parallel type families**

`StorageAdapter` + `WorkflowRunRecord`/`WorkflowRunStepRecord` and `WorkflowStorage` + `ExtendedWorkflowRunRecord`/`StepResult` overlap heavily. `ExtendedRunStatus` adds `'pending'` and `'timeout'` to `RunStatus`; `ExtendedStepStatus` renames `'succeeded'` to `'completed'`. These differences are not documented as deliberate — they appear to be the result of incremental additions without consolidation.

*Suggested fix:* Unify the status enums (`RunStatus` should include `'timeout'`; step status should use consistent terminology). Remove the `Extended*` types once the single interface is adopted.

**3. `engine.ts` holds both scheduling concerns and run lifecycle concerns**

`WorkflowEngine` manages the in-memory run queue with priority insertion (`queueRun`, `processQueue`), active-run tracking (`activeRuns` map), child spawning delegation, event subscription forwarding, and shutdown. This is reasonable but the queue and concurrency control logic (`hasCapacity`, `queueRun`, `processQueue`) could become an independent `RunQueue` class, making `WorkflowEngine` a thinner coordinator.

**4. `events/webhook.ts` duplicates IP-range logic across two functions**

`isBlockedHost` and `isBlockedIp` both check the same IPv4 private ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 0.0.0.0) with near-identical code. A future range addition or bug fix must be applied twice.

**5. `scheduler/postgres-persistence.ts` repeats the Kysely lazy-load pattern from `storage/postgres.ts`**

Both files declare module-level `let Kysely`, `let PostgresDialect`, `let sql`, `let pgModule` and both call `loadPostgresDeps()` in `initialize()`. This cross-file duplication of boilerplate means any change to the lazy-loading pattern (e.g., adding a new exported symbol) must be applied in two places.

*Suggested fix:* Centralize the Kysely instantiation in `utils/postgres-deps.ts` and return a ready-to-use `Kysely` instance, rather than returning the constructor for callers to instantiate manually.

---

## Refactoring Candidates

**1. Consolidate dual storage interfaces (`StorageAdapter` / `WorkflowStorage`)**

- **Location:** `src/storage/types.ts`, `src/storage/postgres.ts`
- **Problem:** Two overlapping interface families with near-duplicate type definitions, status enums that differ by one or two values, and two sets of CRUD methods in `PostgresStorageAdapter`. Every schema or status change requires dual edits.
- **Suggested approach:** Choose `WorkflowStorage` as the single target. Introduce a `LegacyStorageAdapterBridge` shim that wraps a `WorkflowStorage` into the `StorageAdapter` shape for backward compatibility. Unify `RunStatus` to include `'timeout'`; unify step status terminology to `'succeeded'`. Remove `Extended*` type aliases.
- **Effort:** Large

**2. Extract step execution helpers from `orchestrator.ts:executeStep`**

- **Location:** `src/core/orchestrator.ts:296–479`
- **Problem:** The `executeStep` function is a 183-line `while(true)` loop combining timeout handling, cancellation, hook invocation, event emission, and three error recovery strategies. High cyclomatic complexity makes it difficult to unit-test individual error paths.
- **Suggested approach:** Extract `executeStepHandler(step, context, abortController)` (pure execution + timeout), `handleStepSuccess(stepRecord, ...)`, and `handleStepError(step, error, attempt, strategy, ...)` (retry/skip/fail branching). `executeStep` becomes a thin coordinator.
- **Effort:** Medium

**3. Merge `isBlockedHost` and `isBlockedIp` into one utility**

- **Location:** `src/events/webhook.ts:487–555`
- **Problem:** Two functions with near-identical IPv4-range checks. A missed range in one is a security regression.
- **Suggested approach:** Consolidate into `isBlockedAddress(address: string): boolean` operating on dotted-decimal IPv4 or hostname strings. Call it from both `validateWebhookUrl` and `validateResolvedHost`.
- **Effort:** Small

**4. Extract a `parseJsonColumn` helper for storage mappers**

- **Location:** `src/storage/postgres.ts:861–940`, `src/storage/sqlite.ts`
- **Problem:** The pattern `typeof col === 'string' ? JSON.parse(col) : col` appears 10+ times across `mapRunRow`, `mapExtendedRunRow`, `mapStepRow`, `mapStepResultRow`, and `mapEventRow` in postgres.ts, and again in sqlite.ts's mapper.
- **Suggested approach:** `function parseJsonColumn<T>(col: string | T | null | undefined, fallback?: T): T | undefined` — extracted to a shared `src/storage/utils.ts`. Eliminates all inline ternaries.
- **Effort:** Small

**5. Replace `createTables` ad-hoc migration with a versioned migration runner**

- **Location:** `src/storage/postgres.ts:314–465`
- **Problem:** The 150-line `createTables` method issues 15+ raw SQL statements and silently swallows `ALTER TABLE` errors as idempotency. There is no migration version tracking, so it is impossible to determine the current schema version or safely evolve the schema.
- **Suggested approach:** Introduce a `schema_migrations` table tracking applied versions. Replace the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` hack with numbered migration files applied sequentially. This also enables rollback logic.
- **Effort:** Large

**6. Refactor `WorkflowEngine` queue management into a `RunQueue` class**

- **Location:** `src/core/engine.ts:112–399`
- **Problem:** `WorkflowEngine` mixes run-lifecycle concerns (start, cancel, resume, wait) with an in-memory priority queue implementation (`queueRun`, `processQueue`, `hasCapacity`, `runQueue` array, `activeRuns` map). As concurrency features grow, this class will accumulate more queue-specific logic.
- **Suggested approach:** Extract a `RunQueue` class that owns `runQueue`, `activeRuns`, `hasCapacity`, `queueRun`, `processQueue`, and the `QueuedRun` interface. `WorkflowEngine` delegates to it.
- **Effort:** Medium

**7. Centralize Kysely lazy-loading in `utils/postgres-deps.ts`**

- **Location:** `src/utils/postgres-deps.ts`, `src/storage/postgres.ts:13–16`, `src/scheduler/postgres-persistence.ts:12–15`
- **Problem:** Module-level `let Kysely`, `let PostgresDialect`, `let sql`, `let pgModule` declarations and `loadPostgresDeps()` calls are copy-pasted into two different files, and the callers then call `new Kysely(...)` themselves.
- **Suggested approach:** Have `loadPostgresDeps` return an already-constructed `Kysely<any>` factory or a `buildKysely(pool)` helper. Callers receive a usable query builder, not raw constructors.
- **Effort:** Small

**8. Add a `retryUntilAbort` helper to eliminate duplicated sleep-abort patterns**

- **Location:** `src/core/orchestrator.ts:462–473`, `src/utils/retry.ts`
- **Problem:** The `sleep(delay, abortController.signal)` call inside the retry loop is followed by a catch that checks `WorkflowCanceledError` and updates the step record — a pattern that will be repeated if a second retry site is ever added.
- **Suggested approach:** Provide a `sleepWithAbort(ms, signal, onAbort?)` utility in `src/utils/retry.ts` that handles the cancellation check and throws consistently, removing the need for a catch at the call site.
- **Effort:** Small