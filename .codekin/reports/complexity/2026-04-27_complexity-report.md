# Complexity Report: stepflow

**Date**: 2026-04-27T09:45:14.296Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: e85f967a-c1b7-4c75-b2b4-8fea5d5375f4
**Session**: 44d5d22b-759d-452d-ac22-65cebcc01c3e

---

Now I have enough data to write the full report.

## Summary

**Overall Complexity Rating: Medium-High**

The stepflow codebase (~4,000 lines of source, ~11,000 total with tests) is a TypeScript workflow orchestration library. It is generally well-structured, but carries notable complexity in its storage adapters and core execution logic. The most pressing issues are preventable duplication (two near-identical storage classes, two identical condition-evaluators), a 225-line monolithic `executeWorkflow` function, and a `WorkflowEngine` class that takes on too many responsibilities.

| Metric | Value |
|---|---|
| Largest source file | `storage/postgres.ts` — 1,408 lines |
| Largest function | `executeWorkflow()` in `orchestrator.ts` — ~225 lines |
| Most complex function | `executeStep()` in `orchestrator.ts` — 5+ nesting levels, 7 error paths |
| Deepest nesting observed | 5+ levels (`executeWorkflow`, `executeStep`) |
| Most significant duplication | `evaluateCondition()` — 62-line function copied verbatim in `planner.ts` and `registry.ts` |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `src/storage/postgres.ts` | 1,408 | PostgreSQL storage adapter (two near-duplicate classes) | **High** |
| `src/core/engine.test.ts` | 1,365 | Engine integration tests | Low (test file) |
| `src/planning/planning.test.ts` | 727 | Planning system tests | Low (test file) |
| `src/core/engine.ts` | 719 | WorkflowEngine orchestration & concurrency | **High** |
| `src/events/webhook.test.ts` | 657 | Webhook transport tests | Low (test file) |
| `src/storage/sqlite.ts` | 639 | SQLite storage adapter | Medium |
| `src/planning/planner.ts` | 576 | Recipe selection and plan generation | Medium |
| `src/core/orchestrator.ts` | 571 | Workflow step execution loop | **High** |
| `src/planning/types.ts` | 566 | Planning type definitions | Low (types only) |
| `src/events/webhook.ts` | 564 | Webhook delivery with SSRF protection | Medium |
| `src/scheduler/postgres-persistence.ts` | 527 | PostgreSQL schedule persistence | Medium |
| `src/scheduler/cron.test.ts` | 479 | Cron scheduler tests | Low (test file) |
| `src/storage/sqlite.test.ts` | 466 | SQLite adapter tests | Low (test file) |
| `src/scheduler/cron.ts` | 438 | Cron scheduling and poll loop | Low |
| `src/planning/registry.ts` | 365 | In-memory recipe/handler registries | Medium |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `orchestrator.ts:executeWorkflow` | Very High — ~225 lines, 5+ nesting levels | Single function handles setup, step-loop, success path, failure path, timeout management, hook calls, and event emission. Two near-identical completion blocks (~80 lines each). | Split into `setupWorkflowExecution`, `runStepLoop`, `handleWorkflowCompletion(success/failure)` — each under 50 lines. |
| `orchestrator.ts:executeStep` | Very High — ~185 lines, 5+ nesting levels, 7 error paths | Retry logic, timeout races, 7 distinct error strategies (skip, retry, fail, timeout, cancel), hook calls in 4 places, state transitions. | Extract `calculateRetryState`, `handleStepError(strategy)`, `runWithRetry` as separate functions. |
| `engine.ts:executeStep / startRun` | High — 64+ lines, 4 nesting levels | Two parallel execution paths (immediate vs. queued) with duplicated setup; AbortController lifecycle manually managed; events emitted in 3 places. | Extract `buildRunContext` and `dispatchRun(immediate/queued)` helpers. |
| `postgres.ts:createTables` | High — 152 lines | 14 SQL statements executed sequentially; hardcoded constraint names; no separation between table creation and index creation. | Split into `createCoreTables`, `createIndexes`, `createTriggers`. |
| `planner.ts:selectRecipe` | High — 83 lines, 4 nesting levels | Five-step fallback chain (forced → preferred → condition-scored → default → first) with multiple early returns obscuring control flow. | Make each fallback a named private method; compose them in `selectRecipe` with explicit ordering. |
| `planner.ts:evaluateCondition` / `registry.ts:evaluateCondition` | High — 62 lines, 10-case switch, duplicated | Identical 10-operator switch statement copied verbatim into two files. Any operator bug must be fixed in two places. | Extract into `src/planning/conditions.ts` and import in both files. |
| `webhook.ts:sendWebhook` | Medium-High — 71 lines, 4 nesting levels | Retry loop wraps try/catch wraps DNS validation wraps fetch; exponential backoff calculated inline; manual concurrency counter. | Extract `buildRetryDelay`, `validateAndFetch`, `acquireConcurrencySlot` as helpers. |
| `webhook.ts:isBlockedHost / isBlockedIp` | Medium — 80% duplicated across two functions | Private IP range validation logic is nearly identical in both functions; CIDR ranges hardcoded as string magic values. | Consolidate into one `isPrivateAddress(ip: string): boolean` with named constants for each RFC range. |
| `postgres.ts:PostgresStorageAdapter vs PostgresTransactionAdapter` | High — ~60% of methods duplicated | Two classes sharing `createRun`, `updateRun`, `listRuns`, `createStep`, `updateStep`, `getStep`, `getStepsForRun`, `saveEvent`, `getEventsForRun`, `mapRunRow`, `mapStepRow` with nearly identical implementations. | Extract shared logic into a `PostgresQueryHelpers` class or set of pure functions; both adapters delegate to it. |
| `engine.ts:WorkflowEngine` (class-level) | Medium-High — 10+ responsibilities | God object: registry, storage, events, run-queue, timers, concurrency control, subscription, resumption, cancellation, shutdown all live in one class. | Separate `RunQueue`, `ConcurrencyLimiter`, and `RunLifecycle` concerns into collaborator objects injected into `WorkflowEngine`. |

---

## Coupling & Cohesion Issues

**1. `postgres.ts` — Two near-duplicate adapter classes in one file**
`PostgresStorageAdapter` (lines 217–1135) and `PostgresTransactionAdapter` (lines 1136–1408) implement the same `StorageAdapter` interface. Approximately 60% of their methods are copy-pastes of each other, including `mapRunRow`, `mapStepRow`, `createRun`, `updateRun`, `listRuns`, and all event/step accessors. Any schema change must be applied in two places.
_Suggested fix:_ Extract a `PostgresQueryHelpers` module of pure functions (`mapRunRow(row)`, `applyRunsFilters(qb, filters)`, etc.) and have both adapters delegate to it.

**2. `planner.ts` and `registry.ts` — Duplicated `evaluateCondition` logic**
Both files contain a 62-line `evaluateCondition` function implementing the same 10-operator switch (eq, neq, gt, gte, lt, lte, contains, matches, exists, notExists). A bug or new operator must be added in both places.
_Suggested fix:_ Create `src/planning/conditions.ts` exporting `evaluateCondition` and `evaluateConditions`; import it in both modules.

**3. `engine.ts` — God object with implicit coupling to orchestrator**
`WorkflowEngine` calls `executeWorkflow` from `orchestrator.ts` and shares its own internal Maps (`activeRuns`, `timerHandles`) with orchestrator callbacks passed as closures. The two modules are tightly coupled without a formal interface between them.
_Suggested fix:_ Define an `ExecutionContext` interface that `orchestrator.ts` receives; pass it explicitly rather than closing over engine internals.

**4. `webhook.ts` — Manual concurrency queue reinvents a wheel**
The file implements its own `activeRequests` counter + `requestQueue` array to limit concurrent HTTP calls. This is standard async-pool behavior repeated from scratch, and must be carefully managed to avoid starvation or memory leaks.
_Suggested fix:_ Replace with a small generic `AsyncPool` or `AsyncSemaphore` utility; the webhook module should not own concurrency management logic.

**5. `scheduler/postgres-persistence.ts` — Near-duplicate of storage postgres adapter structure**
The scheduler persistence module repeats the same patterns as the storage adapter: lazy dependency loading, runtime schema validation, pool management, and field-level serialization. There is no shared base or utility for PostgreSQL connection management.
_Suggested fix:_ Extract a `PostgresConnectionManager` utility (lazy load, pool init, health check) shared by both persistence layers.

**6. `storage/sqlite.ts` — Fragile positional parameter ordering**
SQLite prepared statements use `.run(p1, p2, p3, ...)` with 7–12 positional arguments. The correctness depends entirely on parameter ordering matching the SQL template. There are no names, types, or structural checks.
_Suggested fix:_ Use named parameters (`:fieldName`) and pass an object, which `better-sqlite3` supports natively.

---

## Refactoring Candidates

**1. Extract shared `evaluateCondition` utility**
- **Location:** `src/planning/planner.ts:44–104` and `src/planning/registry.ts:281–342`
- **Problem:** Identical 62-line function duplicated verbatim; any operator change or bug fix must be applied twice.
- **Suggested approach:** Create `src/planning/conditions.ts` with exported `evaluateCondition` and `evaluateConditions`; update both call sites to import from there.
- **Effort:** Small

**2. Split `executeWorkflow` into composable phases**
- **Location:** `src/core/orchestrator.ts:63–287`
- **Problem:** 225-line function combining setup, step-loop, dual completion paths (~80 lines each with duplicated hook/event/storage patterns), and timeout management. Extremely difficult to test individual phases in isolation.
- **Suggested approach:** Extract `initializeWorkflowRun`, `runStepExecutionLoop`, and `finalizeWorkflowRun(outcome)` as separate functions. `executeWorkflow` becomes a ~30-line coordinator.
- **Effort:** Medium

**3. Deduplicate PostgreSQL adapter implementations**
- **Location:** `src/storage/postgres.ts:475–1408` (two classes with 60% shared methods)
- **Problem:** `PostgresStorageAdapter` and `PostgresTransactionAdapter` each define their own `mapRunRow`, `mapStepRow`, `createRun`, `updateRun`, `listRuns`, and all step/event accessors.
- **Suggested approach:** Extract `mapRunRow`, `mapStepRow`, `applyRunsFilters`, and similar pure functions into a `postgres-helpers.ts` module; both classes import and delegate to them.
- **Effort:** Medium

**4. Break `WorkflowEngine` god object into focused collaborators**
- **Location:** `src/core/engine.ts` — `WorkflowEngine` class (~720 lines total)
- **Problem:** One class owns 10+ responsibilities; hard to test individual concerns without spinning up the full engine.
- **Suggested approach:** Extract `RunQueue` (queue, concurrency limits), `RunTracker` (activeRuns Map, timerHandles Map), and `SubscriptionManager` (event subscriptions, waitForRun). `WorkflowEngine` becomes a thin coordinator.
- **Effort:** Large

**5. Consolidate SSRF/IP validation in webhook transport**
- **Location:** `src/events/webhook.ts:494–564` (`isBlockedHost`, `isBlockedIp`)
- **Problem:** Two functions with ~80% overlapping logic; private RFC IP ranges hardcoded as string magic values scattered across both.
- **Suggested approach:** Define named constants for each RFC range (`RFC_1918_10`, `RFC_1918_172`, etc.) and merge both functions into a single `isBlockedAddress(ip: string): boolean`.
- **Effort:** Small

**6. Replace SQLite positional parameters with named parameters**
- **Location:** `src/storage/sqlite.ts:282–350` (`createRun`, `updateRun`, `listRuns` and their prepared statements)
- **Problem:** `.run(a, b, c, d, e, f, g)` with 7–12 positional args is fragile; argument order is the only thing preventing silent data corruption.
- **Suggested approach:** Rewrite prepared statements with `:fieldName` named params and pass structured objects to `.run({})`. `better-sqlite3` supports this natively.
- **Effort:** Small

**7. Refactor `selectRecipe` fallback chain**
- **Location:** `src/planning/planner.ts:191–273`
- **Problem:** 83-line function with five nested fallback strategies expressed as deeply nested if-blocks with multiple early returns; adding a new selection strategy requires understanding the full control flow.
- **Suggested approach:** Model each strategy as a named private method returning `Recipe | null`; compose them in `selectRecipe` as an ordered pipeline: `const strategies = [tryForced, tryPreferred, tryConditionScored, tryDefault, tryFirst]; return strategies.reduce((acc, s) => acc ?? s(candidates, context), null)`.
- **Effort:** Small

**8. Extract PostgreSQL connection management into a shared utility**
- **Location:** `src/storage/postgres.ts` and `src/scheduler/postgres-persistence.ts` — both implement lazy dep loading, pool initialization, and `initialize()` lifecycle
- **Problem:** Each persistence layer independently manages Kysely + pg driver loading, pool creation, and schema initialization with similar patterns but no shared code.
- **Suggested approach:** Create `src/utils/postgres-pool.ts` exporting `createKyselyPool(config)` and `ensureInitialized(pool, createTables)` helpers.
- **Effort:** Medium

**9. Extract `executeStep` retry/error-strategy logic**
- **Location:** `src/core/orchestrator.ts` — `executeStep` function (~185 lines)
- **Problem:** Seven distinct error-handling strategies (skip, retry with backoff, fail, timeout, cancel, max-retries-exceeded) are all inline within a single deeply nested while-loop; unit testing one strategy requires simulating the entire function.
- **Suggested approach:** Extract `resolveStepErrorAction(error, step, attemptCount): StepAction` and `applyStepAction(action, context): StepOutcome`; the main loop calls them without knowing the strategy details.
- **Effort:** Medium

**10. Replace magic numbers/strings with named constants across planning system**
- **Location:** `src/planning/planner.ts` (scoring values 10, 50, 90, 100; timeouts 30000ms), `src/events/webhook.ts` (IP ranges, retry counts), `src/storage/postgres.ts` (default limit 1000, page size 50)
- **Problem:** Behavior-determining numbers appear without explanation; changing a retry count or scoring weight requires understanding context before editing.
- **Suggested approach:** Introduce a `DEFAULTS` or `CONSTANTS` object at the top of each module (or a shared `src/utils/constants.ts`) with explanatory names.
- **Effort:** Small