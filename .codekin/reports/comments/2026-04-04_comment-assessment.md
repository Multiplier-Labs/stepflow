# Comment Assessment: stepflow

**Date**: 2026-04-04T06:59:29.464Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: c4721f8a-9287-4e91-b3a7-17151c71b861
**Session**: 0bf68b75-f778-4c55-9c9d-a011d10130be

---

Now I have a thorough picture of the codebase. Let me produce the final report.

## Summary

**Language**: TypeScript (strict mode) | **Files**: 43 source files (~14,000 LoC) | **Modules**: core, storage, events, scheduler, planning, utils

Overall comment coverage is **high** — approximately **90%** of public API surface is documented, and ~70% of complex logic has inline explanation. The codebase demonstrates professional-grade JSDoc discipline: every exported type, interface, config object, and error class carries a doc comment. File-level module comments are present on nearly every file. The main gaps are a duplicated/misplaced JSDoc block in `postgres.ts`, thin coverage on a handful of `StorageAdapter` implementation methods, and the absence of `@param`/`@returns` tags on several private helpers. Test files are undocumented, which is standard practice but leaves intent implicit for complex scenarios.

**Overall rating: 8.5 / 10**

---

## Well-Documented Areas

### `src/core/orchestrator.ts`
Exemplary documentation. The two private helpers `executeWithTimeout` and `raceWithAbort` carry unusually thorough comments explaining *why* the `finally` cleanup blocks exist (memory-leak prevention, listener accumulation). The module-level JSDoc accurately describes the file's role. Inline comments mark every logical phase of `executeWorkflow` and `executeStep` (checkpoint resume, cancellation checks, error strategy branching).

```typescript
/**
 * Execute a function with a timeout.
 *
 * Uses Promise.race to resolve as soon as either the function completes, the
 * timeout fires, or the abort signal triggers. The `finally` block is critical:
 * without it, the losing promise's timer/listener would remain active, leaking
 * memory — especially problematic in long-running engines processing many steps.
 */
```

### `src/utils/retry.ts`
Every exported symbol has full JSDoc with `@param`, `@returns`, and `@throws` tags. The `sleep` function documents its cancellation contract. `DEFAULT_RETRY_OPTIONS` is explicitly exported and described. A closing comment on the unreachable branch (`// This should never be reached, but TypeScript needs it`) is an honest and useful annotation.

### `src/core/types.ts`
All foundational types are documented. `StepErrorStrategy` includes inline prose describing the effect of each union member:
```typescript
/**
 * - 'fail': Stop the workflow immediately
 * - 'retry': Retry the step up to maxRetries times
 * - 'skip': Mark as skipped and continue to next step
 */
```

### `src/utils/errors.ts`
Each of the eight custom error classes has a one-line JSDoc that clearly states the triggering condition. `WorkflowEngineError.fromError` documents its fallback behavior.

### `src/storage/postgres.ts` — configuration and schema sections
`PostgresStorageConfig` has `@example` blocks for both the basic and shared-pool cases. Kysely row types (`WorkflowRunsTable`, `WorkflowRunStepsTable`, etc.) document every column inline, including semantic meaning, units, and null semantics. The `qb` getter explains the schema-scoping invariant.

### `src/utils/postgres-deps.ts`
The lazy-loader pattern is precisely explained in the file-level comment, and the `@throws` tags on `loadPostgresDeps` enumerate both failure modes. The `// any is intentional here` comment pre-empts reviewer questions about the `PostgresDeps` interface.

### `src/events/socketio.ts`
`setupClientHandlers` includes a full `@example` block showing correct usage including the authorization callback pattern. The `close()` method clarifies that the underlying Socket.IO socket lifecycle is the caller's responsibility.

### `src/planning/planner.ts` — `scoreConditions`
The scoring formula comment is unusually transparent:
```typescript
// Base score 50 ensures condition-matched recipes beat unconditional defaults (score 10).
// Each additional condition adds 10 points, capped at 100 so forced recipes (100) still win.
```

### `src/utils/id.ts`
Despite being a single exported function, it documents the ID format, design rationale (time-ordering, collision resistance, URL safety), and the approximate output length.

---

## Underdocumented Areas

| File | Issue | Severity |
|---|---|---|
| `src/storage/postgres.ts:563–565` | Two JSDoc blocks stacked immediately on top of each other (`listRuns` doc + `applyRunsFilters` doc) with no actual method between them; the `listRuns` method itself gets the private helper's comment, and `listRuns` is effectively undocumented | High |
| `src/storage/postgres.ts:516–524` | `getRun`, `createStep`, `getStep`, `updateStep`, `getSteps`, `createEvent`, `listEvents` — none have JSDoc; only `createRun`, `updateRun`, and `listRuns` are documented | High |
| `src/core/engine.ts:109–119` | `QueuedRun` interface is documented but the `WorkflowEngine` class declaration at line 121 has no JSDoc block (the preceding `@example` block belongs to a dangling doc comment from the closing `*/` of the example at line 107, making it visually orphaned) | High |
| `src/storage/types.ts:80–200` | `WorkflowEventRecord`, `StepResult`, `StepRecord`, `CreateRunInput`, `UpdateRunInput`, `StorageAdapter` interface and all its method signatures lack individual JSDoc; only the top-level record types are documented | Medium |
| `src/scheduler/cron.ts` (internal methods) | Private methods `checkAndTriggerSchedules`, `handleWorkflowCompletionTriggers`, `calculateNextRun` have no JSDoc; the polling and event-subscription architecture is not explained | Medium |
| `src/core/engine.ts:324–332` | `executeRun` is documented as "Execute a run (internal method)" with no detail; it is a thin wrapper that calls `launchRun` — the indirection is unexplained | Medium |
| `src/storage/sqlite.ts` | `createStep`, `updateStep`, `getSteps`, `createEvent`, `listEvents` methods lack JSDoc; only configuration types are documented | Medium |
| `src/planning/registry.ts` | `MemoryStepHandlerRegistry` and `MemoryRecipeRegistry` class-level JSDoc is absent; method comments are single-line but several complex query methods (e.g., `getByKind`, `getVariant`) have no parameter documentation | Medium |
| `src/events/webhook.ts` | `WebhookEventTransport` class body is not visible in sampling; retry/backoff logic for failed webhook deliveries is expected to lack inline explanation based on surrounding pattern | Medium |
| `src/storage/memory.ts:67–200` | `listRuns` filter/sort/pagination logic has inline `// Filter by X` headers but no explanation of sort stability guarantees or edge-case behaviour (e.g., null `startedAt`) | Low |
| `src/scheduler/sqlite-persistence.ts` | Prepared-statement initialization pattern (using `stmts` nullable object) is not commented; the reason for lazy initialization vs. constructor setup is implicit | Low |
| `src/utils/logger.ts` | `sanitizeErrorForStorage` is exported but has no JSDoc — its role (stripping sensitive fields before DB writes) is non-obvious from the name alone | Low |
| `src/core/engine.ts` (test files) | `src/core/engine.test.ts` has no describe-level comments explaining what scenario each test group targets; complex concurrency and resume tests lack rationale comments | Low |
| `src/storage/types.ts` | `ExtendedRunStatus` and `ExtendedStepStatus` comment says "New" but those are likely legacy designations now; no explanation of when to use extended vs. core status types | Low |
| `src/planning/types.ts` | `PlanModificationType` union values (`'add_step'`, `'remove_step'`, `'modify_step'`, `'set_default'`) are not individually annotated with their intended semantics | Low |

---

## Comment Quality Issues

**1. Stacked / orphaned JSDoc block — `src/storage/postgres.ts:563–568`**

```typescript
  /**
   * List workflow runs with filtering and pagination.
   */
  /**
   * Apply common run filters to a Kysely query builder.
   * Used by both the data query and count query in listRuns to avoid duplication.
   */
  private applyRunsFilters<T ...>(
```

Two `/** */` blocks appear consecutively. TypeScript/JSDoc tooling attaches the *last* block to the declaration, meaning `listRuns` (a public method) loses its documentation entirely and only the private helper `applyRunsFilters` gets a comment. The public method's JSDoc is silently discarded. This is a bug in the comment structure.

**2. `WorkflowEngine` class body starts without a JSDoc — `src/core/engine.ts:109–121`**

The `@example` closing marker at line 107 (`*/`) is followed by the undocumented `QueuedRun` interface, then the `export class WorkflowEngine` at line 121 with no doc comment of its own. The intended class-level JSDoc (lines 83–108) is rendered as a freestanding comment, not as attached JSDoc for `WorkflowEngine`. IDEs will not show hover documentation for the class constructor.

**3. `StorageAdapter.listRuns` — `src/storage/types.ts` (approximately line 130–160)**

The `StorageAdapter` interface lists all method signatures but provides no per-method JSDoc. A consumer implementing the interface receives no guidance on whether `listRuns` should be transactional, whether filters are AND- or OR-combined, or what an empty result looks like.

**4. `cancelRun` comment inaccuracy — `src/core/engine.ts:444`**

```typescript
// Update status in storage (the orchestrator will also update on completion)
await this.storage.updateRun(runId, { status: 'canceled', finishedAt: new Date() });
```

The comment says "the orchestrator will also update on completion" but when `cancelRun` is called, the orchestrator may not be running (if the run was still queued). The comment implies a double-write that is only sometimes true, which could mislead a reader investigating status inconsistencies.

**5. `ensureInitialized` — `src/storage/postgres.ts:246`**

This private guard method has no JSDoc. Since it throws on un-initialized state, documenting the throw condition would aid callers implementing `StorageAdapter`.

**6. `ExtendedRunStatus` comment — `src/storage/types.ts:12–23`**

```typescript
/**
 * Extended status of a workflow run.
 * Adds 'pending' and 'timeout' to the core statuses.
 */
```

`RunStatus` (core) already includes `'queued'` and `'running'`; `ExtendedRunStatus` adds `'pending'` and `'timeout'`. The comment correctly notes the additions, but gives no guidance on *when* a consumer should use `ExtendedRunStatus` vs. `RunStatus` — the distinction between the two parallel type hierarchies is undocumented.

---

## Recommendations

**1. Fix the stacked JSDoc block in `src/storage/postgres.ts:563–568`**
Remove or merge the orphaned `listRuns` JSDoc into a single block placed directly above the `async listRuns(...)` method declaration. The `applyRunsFilters` private helper should retain its own comment, but it should immediately precede that private method, not `listRuns`. This is a correctness issue: as written, `listRuns` is invisible to IDE hover and documentation generators.

**2. Attach the `WorkflowEngine` class-level JSDoc in `src/core/engine.ts`**
The `@example` block (lines 83–107) and the `QueuedRun` interface (lines 109–119) currently sit between the intended class doc and the class declaration. Move `QueuedRun` above the class-level JSDoc, or place the class JSDoc immediately before `export class WorkflowEngine` at line 121. Without this fix, TypeScript language servers do not display hover documentation for the class or its constructor.

**3. Add JSDoc to `StorageAdapter` method signatures in `src/storage/types.ts`**
The `StorageAdapter` interface is the primary extension point for library consumers implementing custom backends. Document at minimum: `createRun`, `updateRun`, `listRuns` (note AND semantics for filters), `createStep`, `updateStep`, and `createEvent`. Include `@param` descriptions and `@returns` contracts. This directly impacts third-party adapter authors.

**4. Document `sanitizeErrorForStorage` in `src/utils/logger.ts`**
This exported utility performs security-sensitive work (scrubbing error objects before persistence), but it has no JSDoc. A doc comment should state what fields are removed (e.g., `stack`), why (storage size / privacy), and what the return type contract is. Its current name gives no indication it performs sanitization beyond what the type system shows.

**5. Document the `ExtendedRunStatus` / `RunStatus` dual hierarchy in `src/storage/types.ts`**
Add a comment block before `ExtendedRunStatus` explaining when each type should be used (e.g., "Use `RunStatus` for the core engine; use `ExtendedRunStatus` when working with the extended storage schema which includes `pending` and `timeout`"). This prevents consumers from accidentally mixing the two.

**6. Add inline comments to `CronScheduler`'s internal scheduling loop in `src/scheduler/cron.ts`**
The private methods responsible for polling (`checkAndTriggerSchedules`), event-based triggering (`handleWorkflowCompletionTriggers`), and next-run calculation (`calculateNextRun`) contain the most nuanced logic in the scheduler module (timezone handling, cron expression parsing, status matching). Each should have at minimum a one-paragraph JSDoc explaining its role and any non-obvious invariants (e.g., why the poll interval is 1 second by default, how `lastRunAt` prevents double-firing).

**7. Fix the `cancelRun` comment inaccuracy in `src/core/engine.ts:444`**
Replace `// Update status in storage (the orchestrator will also update on completion)` with a comment that accurately reflects the dual-write scenario: the orchestrator updates status when it catches `WorkflowCanceledError`, but this pre-emptive write ensures the status is visible immediately and handles the case where the run was queued (never started). This removes a misleading implication about guaranteed orchestrator involvement.

**8. Add JSDoc to `getRun`, `createStep`, `updateStep`, and `listEvents` in `src/storage/postgres.ts`**
These `StorageAdapter` implementation methods (~lines 516–750) have no doc comments, unlike `createRun`, `updateRun`, and `listRuns`. At minimum, note any PostgreSQL-specific behaviour that differs from the `MemoryStorageAdapter` (e.g., JSON serialization round-trips, `null` vs. `undefined` handling for optional fields).

**9. Annotate `PlanModificationType` union values in `src/planning/types.ts`**
The four modification types (`'add_step'`, `'remove_step'`, `'modify_step'`, `'set_default'`) are used in the planner output to describe what was changed, but their intended semantics are not documented. Add inline comments (or expand the type into a documented discriminated union) so that consumers of `Plan.modifications` know how to interpret and render each modification type.

**10. Add a brief rationale comment in `src/core/engine.ts:568–574` (`resumeRun` checkpoint logic)**
The line `const completedStepKeys = new Set(Object.keys(run.context))` silently encodes a convention: that the `context` object's keys are exactly the completed step keys. This is a non-obvious coupling between the orchestrator's checkpoint-save strategy (`storage.updateRun(runId, { context: { ...context.results } })`) and the resume logic. A one-line comment (`// context keys == completed step keys by orchestrator checkpoint convention`) would make this invariant explicit and prevent it from being accidentally broken.