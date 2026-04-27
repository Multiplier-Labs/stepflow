# Comment Assessment: stepflow

**Date**: 2026-04-27T09:47:00.739Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: d5f8f428-b20c-4a1b-9945-5c87995e64a6
**Session**: a65b6bf0-b068-4ac9-859a-dad61a67eaa1

---

Let me read a few key files directly to get accurate line numbers and specific examples.Now I have enough data for a thorough, accurate report.

## Summary

The Stepflow codebase is a TypeScript workflow orchestration engine (~14,400 lines across ~43 source files). Comment coverage is **high — estimated 70–75%** across all types of documentation. The overall quality rating is **8/10 (Good to Excellent)**.

The project's commenting culture is strong: every file opens with a JSDoc module header, virtually all exported interfaces and types carry field-level documentation, and public class methods have JSDoc blocks with `@param`/`@throws`/`@example` annotations. The most impressive aspect is the presence of meaningful "why" comments on non-obvious technical decisions — particularly around memory safety in async code.

The main gaps are confined to: a few private/internal methods without JSDoc; one structurally misplaced interface; duplicated logic between `planner.ts` and `registry.ts` with partial cross-referencing; and the `ScheduleRow` internal type which goes entirely undocumented.

---

## Well-Documented Areas

### `src/core/orchestrator.ts` — `executeWithTimeout` and `raceWithAbort`

Lines 489–559 contain two of the best-commented functions in the codebase. Each explains not just what it does but *why* the `finally` cleanup block is mandatory — memory-leak prevention from dangling Promise listeners across high-volume step execution:

```typescript
/**
 * Uses Promise.race to resolve as soon as either the function completes, the
 * timeout fires, or the abort signal triggers. The `finally` block is critical:
 * without it, the losing promise's timer/listener would remain active, leaking
 * memory — especially problematic in long-running engines processing many steps.
 */
```

### `src/planning/planner.ts` — `scoreConditions` algorithm

Lines 132–134 explain the non-obvious scoring arithmetic — why the base score is 50, why 10 points per condition, why the cap is 100 — directly inline with the code it governs:

```typescript
// Base score 50 ensures condition-matched recipes beat unconditional defaults (score 10).
// Each additional condition adds 10 points, capped at 100 so forced recipes (100) still win.
return Math.min(100, 50 + conditions.length * 10);
```

### `src/core/engine.ts` — Full public API

All public methods on `WorkflowEngine` carry complete JSDoc including `@param`, `@returns`, `@throws`, and `@example`. Section headers (`// ====...====`) divide the 719-line file into logical groups (Registration, Run Management, Resume Support, Events, Storage, Lifecycle). The class-level `@example` block (lines 86–108) gives a complete working usage pattern.

### `src/utils/errors.ts`

All seven error classes are individually documented with purpose-explaining JSDoc. The `WorkflowEngineError.fromError` static factory (line 35) is well-described. The class hierarchy maps cleanly to its documentation.

### `src/utils/logger.ts`

`LOG_LEVEL_PRIORITY` is explained in context via the type alias comment (line 7: "Levels are ordered: debug < info < warn < error"). `sanitizeErrorForStorage` (line 68) explains the security rationale ("Stack traces expose internal file paths and should be kept in logs only"). `createScopedLogger` clearly documents its contextual prefix behaviour.

### `src/scheduler/sqlite-persistence.ts` — Schema documentation

The `initializeDatabase` method (lines 72–155) includes an inline schema legend (lines 74–86) listing every column with its purpose and type semantics, plus a note about the absence of a migration strategy. This is the most thorough inline schema comment in the project.

### `src/planning/registry.ts` — `getDefault` cross-reference

Lines 185–188 explicitly cross-reference the inverse priority semantics between `getDefault` (ascending = highest precedence) and `RuleBasedPlanner.selectRecipe` (descending), preventing a subtle maintenance pitfall.

---

## Underdocumented Areas

| File | Issue | Severity |
|------|-------|----------|
| `src/core/engine.ts:109–119` | `QueuedRun` interface is placed *between* the `WorkflowEngine` class JSDoc block and the class declaration, making it appear part of the engine description; it has its own short comment but the structural position is misleading | High |
| `src/core/engine.ts:424–431` | `cancelRun` hardcodes terminal statuses as `['succeeded', 'failed', 'canceled', 'timeout']` inline rather than referencing the `TERMINAL_STATUSES` static property defined at line 471; no comment explains the duplication | High |
| `src/scheduler/sqlite-persistence.ts:258–274` | `ScheduleRow` internal interface has no JSDoc at all — field names are self-descriptive but types and nullability semantics go unexplained | Medium |
| `src/scheduler/sqlite-persistence.ts:221–231` | `safeJsonParse` private method has no JSDoc; the `fallback` parameter semantics and the re-throw behaviour on non-`SyntaxError` are invisible from the call sites | Medium |
| `src/scheduler/sqlite-persistence.ts:233–251` | `rowToSchedule` private method has no JSDoc; the SQLite `enabled INTEGER` → boolean conversion (line 246) is non-obvious and undocumented | Medium |
| `src/planning/registry.ts:252–264` | `evaluateConditions` private method notes it "intentionally mirrors" planner.ts but doesn't explain why the duplication is preferable to sharing a utility — the trade-off is invisible | Medium |
| `src/core/orchestrator.ts:100–101` | `stepId: ''` initialised to empty string with comment "Will be set for each step" — doesn't explain why empty string rather than `undefined` (TypeScript type may require it, but no note) | Low |
| `src/core/engine.ts:322–333` | `executeRun` is a one-line delegation to `launchRun` with its own JSDoc; the reason this indirection exists (allowing `launchRun` to be shared with `resumeRun`) is documented on `launchRun` but not on `executeRun` | Low |
| `src/storage/memory.ts:42–60` | Method-level comments are single-line inline tags (`/** Create and persist... */`) rather than full JSDoc blocks; no `@param`, `@returns`, or `@throws` annotations | Low |
| `src/scheduler/cron.ts:141–159` | The try/catch guard on invalid persisted cron expressions has a good inline comment, but the `schedule.enabled = false` mutation side effect (line 156) is not mentioned in any method-level doc | Low |
| `src/planning/planner.ts:461–515` | `applyConstraints` JSDoc doesn't document the return type shape (`{ steps, modifications }`), making it harder to understand the output contract without reading the body | Low |
| `src/utils/retry.ts:36–63` | `sleep` function has no `@param` annotations; the `signal`-cancellation contract (rejects with `WorkflowCanceledError`) is only discoverable by reading the implementation | Low |
| `src/storage/postgres.ts:13–15` | `let Kysely: any`, `let PostgresDialect: any`, `let sql: any` lazy-load globals have no comment explaining *when* they're populated or what happens if used before `initialize()` | Low |
| `src/events/socketio.ts:43–62` | `SocketIOEventTransportConfig` fields are documented but the interaction between `broadcastGlobal`, `globalRoom`, and per-run rooms is not explained as a whole | Low |
| `src/core/engine.ts:167–172` | `hasCapacity()` has a clear inline comment `// No limit` but the `maxConcurrency <= 0` edge case is treated identically to `undefined` without explanation | Low |

---

## Comment Quality Issues

**1. Misplaced interface JSDoc — `src/core/engine.ts:109–119`**

The `WorkflowEngine` class-level `@example` block ends at line 108. Lines 109–119 immediately open a JSDoc for `QueuedRun` followed by its interface body, then the `WorkflowEngine` class opens at line 121. A reader skimming the file sees the class example JSDoc, then a floating `QueuedRun` comment, then the class — making it appear that `QueuedRun` is somehow the subject of the preceding class doc. The interface should appear after the class opening or be moved to a private type section.

**2. Duplicated terminal status list — `src/core/engine.ts:431` vs `engine.ts:471`**

```typescript
// line 431 — inside cancelRun
if (['succeeded', 'failed', 'canceled', 'timeout'].includes(run.status)) {

// line 471 — static property
private static readonly TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled', 'timeout'];
```

`cancelRun` was written (or edited) independently of the static constant. If a new terminal status is added to `TERMINAL_STATUSES`, `cancelRun` will silently miss it. There is no comment warning about this.

**3. Priority-ordering inversion without full explanation — `src/planning/registry.ts:185–196`**

The comment at line 185 reads: *"lower number = higher precedence"* and cross-references `RuleBasedPlanner.selectRecipe`. However, in `selectRecipe` (planner.ts:238–242), sort is *descending* — higher priority number wins. The note is accurate but the contrast ("this ascending order is the inverse") is dense; without reading both methods together, the semantics of `priority` remain ambiguous.

**4. Incomplete `@example` on `WorkflowEngine` — `src/core/engine.ts:83–108`**

The class-level `@example` block demonstrates `registerWorkflow` and `startRun`, but does not show `waitForRun`, `cancelRun`, or error handling — the patterns most users will need after starting a run.

**5. `safeJsonParse` silent fallback — `src/scheduler/sqlite-persistence.ts:221–229`**

The method silently returns a `fallback` value (defaulting to `undefined`) when JSON is malformed, logging only a `console.warn` instead of using the injected logger. The decision to swallow the error is not explained, and callers (e.g., `rowToSchedule` line 242) don't know they may receive `undefined` where they expect a typed value.

**6. `sleep` cancellation contract undocumented — `src/utils/retry.ts:36–63`**

The public `sleep` function has a JSDoc header but no `@param signal` annotation explaining that the signal rejection throws `WorkflowCanceledError` specifically (not a generic `AbortError`). Call sites in `orchestrator.ts:469–479` handle this implicitly, but external users of the utility would not discover the error type without reading the source.

---

## Recommendations

1. **Move `QueuedRun` out of the JSDoc gap in `src/core/engine.ts`** (lines 109–119).  
   Place the interface in the private type section below the class opening brace, or above the class-level JSDoc. This prevents readers from confusing it with the class documentation scope.

2. **Replace the hardcoded terminal-status array in `cancelRun` with the static constant** (`src/core/engine.ts:431`).  
   Change `['succeeded', 'failed', 'canceled', 'timeout'].includes(run.status)` to `WorkflowEngine.TERMINAL_STATUSES.includes(run.status)`. This eliminates a silent maintenance hazard where adding a new terminal status to one place misses the other.

3. **Add JSDoc to `ScheduleRow`, `rowToSchedule`, and `safeJsonParse`** in `src/scheduler/sqlite-persistence.ts` (lines 221, 233, 258).  
   These private members are the data-mapping layer of the persistence adapter. A one-line JSDoc on each — including a note that `safeJsonParse` may return `undefined` on parse failure — makes the error-propagation contract visible to future maintainers.

4. **Document the `sleep` function's cancellation contract** in `src/utils/retry.ts:36`.  
   Add `@param signal - When aborted, rejects with {@link WorkflowCanceledError}` so external users of the utility know the exact error type to catch.

5. **Extend the `@example` on `WorkflowEngine`** (`src/core/engine.ts:83`) to include `waitForRun` and a `cancelRun` snippet.  
   The current example stops at `startRun`. Most integration scenarios require knowing the result. A two-line follow-up showing `await engine.waitForRun(runId)` and result access would make the class immediately actionable.

6. **Add a `@param` / `@returns` annotation to `applyConstraints`** in `src/planning/planner.ts:461`.  
   The return type `{ steps: PlannedStep[]; modifications: PlanModification[] }` is a structured tuple that isn't obvious. A single `@returns` line describing both fields would make the call site at line 323 self-explanatory.

7. **Clarify the priority semantics discrepancy between `getDefault` and `selectRecipe`** more explicitly.  
   The cross-reference comment in `registry.ts:185` is correct but terse. Add a two-sentence note explaining that `priority` is intentionally overloaded: inside the planner, higher number wins in a tie; in `getDefault`, lower number wins because `getDefault` is a last-resort fallback, not a scoring competition.

8. **Add JSDoc to `safeJsonParse` explaining the logging choice** in `src/scheduler/sqlite-persistence.ts:221`.  
   Note that `console.warn` is used rather than the injected logger because this class has no logger dependency, and document that the fallback-to-`undefined` behaviour is intentional (corrupt rows are skipped rather than crashing the scheduler on startup).

9. **Document the `maxConcurrency <= 0` edge case in `hasCapacity`** (`src/core/engine.ts:167`).  
   A one-line comment explaining that `<= 0` is treated as "no limit" (same as `undefined`) documents a deliberate API choice that could otherwise be mistaken for a bug.

10. **Extract condition-evaluation logic into a shared utility** and update comments in `planner.ts` and `registry.ts` to reference the single canonical source.  
    Currently the condition switch-case is copy-pasted across `src/planning/planner.ts:44–104` and `src/planning/registry.ts:281–342`. The existing comment at registry.ts:252 acknowledges this intentionally, but the duplication is a future bug vector. If extraction is deferred, add a `// TODO:` note in both files pointing to the other location so the duplication stays visible.