# Complexity Report: stepflow

**Date**: 2026-03-19T10:27:58.846Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: efad0d4f-9f79-4851-aa79-0ce59637c13c
**Session**: 4ccf7d68-575b-40fe-9387-43f7705d09bf

---

## Summary

**Overall Complexity Rating: Medium-High**

Key metrics:
- Largest file: `src/storage/postgres.ts` (1,354 lines)
- Most complex function: `orchestrator.ts:executeStep()` (~159 lines, cyclomatic complexity ~15)
- Deepest nesting: `orchestrator.ts:executeStep()` (5–6 levels)
- Total LOC (excluding test files and generated code): ~8,000

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|----------------------|-------------------|
| `src/core/engine.test.ts` | 1,364 | Engine integration tests | Low (test file) |
| `src/storage/postgres.ts` | 1,354 | PostgreSQL storage adapter | **High** |
| `src/planning/planning.test.ts` | 727 | Planning rule tests | Low (test file) |
| `src/core/engine.ts` | 692 | Workflow engine & concurrency | **High** |
| `src/storage/sqlite.ts` | 635 | SQLite storage adapter | **High** |
| `src/planning/planner.ts` | 576 | Rule-based workflow planner | **High** |
| `src/planning/types.ts` | 566 | Planning type definitions | Low (types only) |
| `src/events/webhook.test.ts` | 557 | Webhook event tests | Low (test file) |
| `src/core/orchestrator.ts` | 538 | Workflow execution orchestration | **Critical** |
| `src/scheduler/cron.ts` | 414 | Cron-based workflow scheduling | Medium |
| `src/events/webhook.ts` | 414 | Webhook event handler | Low |
| `src/storage/memory.ts` | ~350 | In-memory storage adapter | Medium |
| `src/core/types.ts` | ~320 | Core type definitions | Low (types only) |
| `src/scheduler/cron.test.ts` | ~300 | Cron scheduler tests | Low (test file) |
| `src/index.ts` | ~150 | Public API surface | Low |

---

## Most Complex Functions

| File:Function | Est. Complexity | Issue Description | Refactor Suggestion |
|---------------|-----------------|-------------------|---------------------|
| `orchestrator.ts:executeStep()` | CC ~15, 159 lines, 5-level nesting | Combines retry loop, per-attempt timeout, hook invocations, and multi-path error handling in a single `while` loop. Promise.race with manual listener cleanup nested inside try/catch inside while. | Extract into `runStepAttempt()`, `applyRetryPolicy()`, and `invokeStepHooks()`. Each concern tested independently. |
| `orchestrator.ts:executeWorkflow()` | CC ~12, 218 lines, 4-level nesting | Mixes checkpoint/resume init, step loop, hook calls, timeout teardown, and multiple event emissions. Timeout cleanup logic appears in two separate places (lines ~195 and ~230). | Split into `initializeRun()`, `runStepLoop()`, and `finalizeRun()`. Pass a shared run-state object. |
| `planner.ts:selectRecipe()` | CC ~8, 83 lines, 5-level nesting | Six distinct selection paths (forced recipe → preferred variant → best match → default → first → error) expressed as nested if-else without explicit priority ordering, making intent hard to follow. | Flatten into early-return chain with named helper predicates. |
| `planner.ts:evaluateCondition()` | CC ~11, 61 lines | Switch with 10 operator cases, each doing ad-hoc `typeof` type guards before comparison. No abstraction for type-specific logic. | Operator registry (`Map<string, (a, b) => boolean>`), each entry handles its own type checking. |
| `planner.ts:generatePlan()` | CC ~7, 67 lines, 4-level nesting | Hint application (nested loop over steps × hints) mixed with constraint application and resource estimation in the same function. | Separate `applyHints()` and `applyConstraints()` as pipeline stages called from `generatePlan()`. |
| `engine.ts:waitForRun()` | CC ~6, 48 lines, 4-level nesting | Manual timeout + event-listener lifecycle management with a race condition: storage check happens before event subscription, so a completion between those two points is missed. | Subscribe first, then check storage; cancel subscription if already done. Use `AbortSignal` for cleanup. |
| `engine.ts:startRun()` | CC ~5, 64 lines | Mixed validation, queue-vs-capacity branching, state mutation, and event emission. Returning different things depending on path makes call sites complex. | Extract `validateRunInput()` and `dispatchOrQueue()` helpers. |
| `engine.ts:queueRun()` | CC ~3, 14 lines | O(n) linear scan + `Array.splice()` for priority insertion — O(n²) worst case under load. | Replace `runQueue: QueuedRun[]` with a min-heap priority queue. |
| `postgres.ts:PostgresTransactionAdapter` | CC ~1 per method, 241 lines total | Full duplication of `mapRunRow()`, `mapStepRow()`, `mapEventRow()`, and all CRUD methods from the parent class, with no behavioral difference. | Extract row-mapping helpers into a module-level namespace; compose `PostgresTransactionAdapter` with the adapter rather than duplicating it. |
| `sqlite.ts:transaction()` | CC ~3, 21 lines | Synchronously inspects a `Promise` that was never awaited to simulate sync execution of an async callback. This violates `async/await` semantics and contains a latent race condition. | Remove the async facade. Expose `transactionSync()` directly on the public interface and document the sync-only constraint. |

---

## Coupling & Cohesion Issues

**1. `postgres.ts` and `sqlite.ts` — Duplicated row-mapping logic**
Both adapters independently implement `mapRunRow()`, `mapStepRow()`, and `mapEventRow()` with an identical pattern: `typeof col === 'string' ? JSON.parse(col) : col`. The conditional exists ~5 times per file (~30 duplicated lines per adapter). Any schema change (e.g., adding a new JSON column) must be made in four places.
*Fix:* Extract a `parseJsonColumn(value: unknown): unknown` utility and a `mapRunRow(row)` pure function into a shared `src/storage/row-mappers.ts` module imported by both adapters.

**2. `orchestrator.ts` — Tight coupling to storage and engine internals**
`executeWorkflow()` calls storage directly for checkpointing, run-status updates, step persistence, and event emission — roughly 8–10 distinct storage operations. It also references `Engine`-level concurrency state indirectly via callbacks. Any storage schema change ripples directly into orchestration logic.
*Fix:* Introduce a `RunContext` or `RunSession` object that owns all storage interactions for a single run, keeping `orchestrator.ts` orchestration-only.

**3. `engine.ts` — Dual responsibility: concurrency manager + public API**
`Engine` manages the run queue, concurrency slots, and in-flight `AbortController` map **and** exposes the public `startRun()`, `waitForRun()`, `cancelRun()`, and `resumeAllInterrupted()` API. Changes to concurrency internals risk breaking the public interface.
*Fix:* Extract `ConcurrencyManager` (queue + slots + abort map) as a private collaborator composed into `Engine`.

**4. `planner.ts` — `evaluateCondition()` coupled to operator string literals**
Condition operator names (e.g., `"equals"`, `"contains"`, `"greaterThan"`) are scattered as raw strings in both `evaluateCondition()` and the `types.ts` discriminated union. Adding a new operator requires modifying the switch statement, the type union, and any tests — three coordinated edits.
*Fix:* Define operators as a `const` enum or string-literal union with a matching registry, so adding an operator is a single-point change.

**5. `cron.ts` — Cron expression validation duplicated in `addSchedule()` and `updateSchedule()`**
Both methods independently call `CronExpressionParser.parse()` in a try/catch to validate the expression, with identical error-handling logic (~10 lines each). Divergence is possible.
*Fix:* Extract `validateCronExpression(expr: string): void` and call it from both methods.

**6. Large import fan-out in `orchestrator.ts`**
`orchestrator.ts` imports from `../core/types`, `../storage/types`, `../events/types`, `../scheduler/types`, plus the engine itself. This broad import surface indicates the module is a cross-cutting dependency sink rather than a focused concern.
*Fix:* Align with the `RunContext` refactor above; most storage/event imports would move into that object.

---

## Refactoring Candidates

**1. Extract shared row-mapper utilities (`src/storage/row-mappers.ts`)**
- **Location:** `src/storage/postgres.ts` (lines 861–899), `src/storage/sqlite.ts` (lines 345–457)
- **Problem:** ~80 lines of identical `typeof col === 'string' ? JSON.parse(col) : col` logic duplicated across two adapters, repeated for every JSON column. Bug fixes and schema changes must be applied in four separate methods.
- **Approach:** Create `src/storage/row-mappers.ts` with pure functions `mapRunRow()`, `mapStepRow()`, `mapEventRow()`. Both adapters import and call them.
- **Effort:** Small

**2. Break apart `orchestrator.ts:executeStep()` into single-responsibility helpers**
- **Location:** `src/core/orchestrator.ts` lines ~296–454
- **Problem:** 159-line function at cyclomatic complexity ~15, combining retry loop, per-attempt timeout setup, hook invocations, step-status persistence, and error classification. Extremely difficult to unit-test any one path.
- **Approach:** Extract `runAttempt(step, context, signal)` → `applyStepTimeout(promise, ms, signal)` → `recordStepResult(stepId, result)` → `invokeStepHooks(event, data)`. The `executeStep()` wrapper becomes a clean retry loop calling these helpers.
- **Effort:** Medium

**3. Break apart `orchestrator.ts:executeWorkflow()` into init / loop / finalize**
- **Location:** `src/core/orchestrator.ts` lines ~63–280
- **Problem:** 218-line function mixing checkpoint restoration, the step-execution loop, hook dispatch, event emission, and timeout teardown. Multiple concerns at 4-level nesting make reasoning about control flow error-prone.
- **Approach:** Decompose into `initializeRun()`, `runStepLoop()`, and `finalizeRun(result|error)`. Introduce a `RunState` value object threaded through all three to avoid reliance on closure captures.
- **Effort:** Large

**4. Replace `engine.ts:runQueue` linear insertion with a priority queue**
- **Location:** `src/core/engine.ts` lines ~306–319 (`queueRun()`)
- **Problem:** `Array.splice()` into a sorted array is O(n) per insert and O(n²) under continuous load (e.g., many concurrent workflow triggers). This is a latent performance cliff.
- **Approach:** Replace the `QueuedRun[]` array with a binary min-heap keyed on `priority`. Alternatively, adopt a lightweight dependency like `tinyqueue` (already MIT, no transitive deps).
- **Effort:** Small

**5. Fix the race condition in `engine.ts:waitForRun()`**
- **Location:** `src/core/engine.ts` lines ~480–527
- **Problem:** The method reads run status from storage, then subscribes to the completion event. A run that completes between those two operations is silently dropped, causing `waitForRun()` to hang until its optional timeout fires.
- **Approach:** Subscribe to the event **first**, then check storage. If storage already shows completion, resolve immediately and cancel the subscription. Use `AbortSignal` for uniform cleanup.
- **Effort:** Small

**6. Refactor `planner.ts:evaluateCondition()` switch to an operator registry**
- **Location:** `src/planning/planner.ts` lines ~44–104
- **Problem:** 10-case switch with ad-hoc `typeof` guards in each arm. Adding an operator requires modifying the switch, the type definition, and tests — three coordinated edits with no compile-time safety net.
- **Approach:** Define `type Operator = 'equals' | 'contains' | ...` and `const OPERATORS: Record<Operator, (field: unknown, value: unknown) => boolean> = {...}`. `evaluateCondition()` becomes a two-line lookup.
- **Effort:** Small

**7. Remove `postgres.ts:PostgresTransactionAdapter` duplication via composition**
- **Location:** `src/storage/postgres.ts` lines ~1109–1350
- **Problem:** `PostgresTransactionAdapter` duplicates all CRUD methods and all row-mapping helpers (241 lines) from the parent `PostgresStorageAdapter`. Any behavioural fix in one must be manually replicated in the other.
- **Approach:** After extracting row-mappers (#1), factor CRUD query builders into standalone functions parameterised by a `Kysely<DB>` instance. Both the main adapter and the transaction adapter call the same query builders.
- **Effort:** Medium

**8. Enforce sync-only semantics in `sqlite.ts:transaction()`**
- **Location:** `src/storage/sqlite.ts` lines ~440–460
- **Problem:** The current `async transaction()` facade synchronously inspects an unawaited `Promise` to work around `better-sqlite3`'s sync-only driver. This is undefined behaviour — the promise's `.then()` callbacks are always microtasks and will never have run by the time the synchronous check executes.
- **Approach:** Remove `async transaction()`. Expose `transactionSync()` on the `StorageAdapter` interface for the SQLite implementation, or make the SQLite adapter's `transaction()` throw with a clear `UnsupportedOperationError`. Document the constraint in the class docblock.
- **Effort:** Small

**9. Flatten `planner.ts:selectRecipe()` nested fallback chain**
- **Location:** `src/planning/planner.ts` lines ~191–273
- **Problem:** Six distinct selection paths expressed as deeply nested if-else (5 levels) without explicit priority documentation, making the tie-breaking rules invisible to maintainers.
- **Approach:** Convert to an early-return chain with one labeled comment per path (e.g., `// 1. Forced recipe`, `// 2. Preferred variant`). Extract named predicate helpers like `matchesPreferredVariant()` to make each condition self-documenting.
- **Effort:** Small

**10. Extract `ConcurrencyManager` from `engine.ts`**
- **Location:** `src/core/engine.ts`
- **Problem:** `Engine` simultaneously owns the run queue, concurrency slots, abort controllers, and the public workflow API. The concurrency internals (`runQueue`, `activeRuns`, `maxConcurrentRuns`, `queueRun()`, `processQueue()`) are unrelated to the public interface and bloat the class.
- **Approach:** Extract `class ConcurrencyManager { enqueue(), dequeue(), hasCapacity(), abort() }` and compose it into `Engine`. This also makes concurrency logic independently testable without standing up a full engine.
- **Effort:** Medium