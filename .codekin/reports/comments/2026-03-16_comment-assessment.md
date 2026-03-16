# Comment Assessment: stepflow

**Date**: 2026-03-16T14:55:03.515Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 66116343-5898-4208-9ad3-fc083fd3a15c
**Session**: f6f9790e-7b35-452e-b6e3-7ff111916e80

---

Now let me check a few more files for completeness:Now I have enough data to produce the full assessment report.

## Summary

**Overall comment coverage: ~87%** — The stepflow codebase is written in TypeScript (strict mode, ESM) and demonstrates consistently high documentation discipline. Module-level JSDoc is present on every source file. All foundational type definitions (`core/types.ts`, `storage/types.ts`, `events/types.ts`, `planning/types.ts`) document every field. Core algorithm files (`engine.ts`, `orchestrator.ts`) have thorough inline prose explaining non-obvious decisions. The main gaps are concentrated in implementation-class public method signatures and internal Kysely schema interfaces, plus one stale comment that actively misrepresents the scheduler's implementation state.

**Quality rating: 4.2 / 5** — Documentation is accurate, JSDoc conventions are consistent throughout, and where complexity exists (orchestrator timeout races, webhook SSRF validation, retry backoff math) the "why" is always explained. The primary weaknesses are the underdocumented public methods on `MemoryStorageAdapter` and both registry classes.

---

## Well-Documented Areas

### `src/core/orchestrator.ts`
The execution engine's most complex file. Every non-obvious decision is explained in prose:
```typescript
// We must remove the abort listener BEFORE resolving/rejecting the outer promise.
// If we don't, a second abort signal (e.g. from a timeout racing with a cancel) would
// fire the listener on an already-settled promise, causing a memory leak.
```
The `raceWithAbort` helper, timeout-via-`AbortController` pattern, and resume-checkpoint logic are all narrated step by step.

### `src/core/types.ts`
All 14 exported types/interfaces have full field-level JSDoc. The `WorkflowContext` interface documents subtle constraints (`stepId` is `''` between steps, `spawnChild` propagates the abort signal automatically). `WorkflowHooks` documents ordering guarantees (`beforeStep` fires before each attempt, `afterStep` only on the final outcome).

### `src/core/engine.ts`
Every public method carries `@param`, `@returns`, and `@throws` tags. Concurrency queue behaviour and priority-bump logic for `resumeAllInterrupted` are explained inline.

### `src/events/webhook.ts`
Complete end-to-end documentation: config fields with defaults, `@example` with realistic URLs, security comment on `validateWebhookUrl`, SSRF blocklist rationale inline in `isBlockedHost`, and payload signing algorithm name (`HMAC-SHA256`) stated explicitly in the JSDoc.

### `src/storage/sqlite.ts`
The multi-status `listRuns` prepared statement includes a comment explaining the `json_each()` trick required to filter JSON arrays in SQLite. The `@deprecated` marker on `transaction()` is present and accurate. Prepared-statement strategy is explained in the constructor JSDoc.

### `src/planning/types.ts`
The most thoroughly documented file in the repo. `PlanningConstraints`, `PlanningHints`, `PlanningContext`, `RecipeCondition` operators, and scoring semantics are all field-documented. The `RecipeSelectionResult` interface documents the 0–100 scoring scale and the fallback chain.

### `src/utils/id.ts`
The short `generateId` function is documented with three design rationale bullets (time-ordering, collision resistance, URL safety) despite being only 3 lines of implementation — an example of "explain the why" done well.

### `src/scheduler/postgres-persistence.ts`
The `updateSchedule` method (lines 316–374) has an unusually clear inline comment explaining the fetch-merge-write pattern and a self-documenting `fieldMappings` data structure with a comment explaining its purpose.

---

## Underdocumented Areas

| File | Issue | Severity |
|------|-------|----------|
| `src/scheduler/types.ts` | Module comment (lines 1–5) states "Phase 3 / future implementation" but `CronScheduler`, `SQLiteSchedulePersistence`, and `PostgresSchedulePersistence` are all fully implemented and shipped | **High** |
| `src/storage/memory.ts` | 11 public interface methods (`createRun`, `getRun`, `updateRun`, `listRuns`, `createStep`, `getStep`, `updateStep`, `getStepsForRun`, `saveEvent`, `getEventsForRun`, `deleteOldRuns`) have no JSDoc whatsoever | **Medium** |
| `src/planning/registry.ts` | `MemoryStepHandlerRegistry`: `register`, `get`, `has`, `list`, `listByTag` (lines 28–67) have no JSDoc. `MemoryRecipeRegistry`: `register`, `registerAll`, `get`, `has`, `getByKind`, `getVariant`, `getDefault`, `listVariants`, `query`, `list` (lines 100–213) have no JSDoc | **Medium** |
| `src/scheduler/types.ts` | `WorkflowSchedule` interface fields (lines 17–39) use `// For cron triggers` section comments instead of per-field JSDoc, inconsistent with every other interface in the codebase | **Low** |
| `src/storage/postgres.ts` | Internal Kysely schema interfaces (`WorkflowRunsTable`, `WorkflowRunStepsTable`, `WorkflowEventsTable`) have no field-level JSDoc, unlike the parallel public types in `storage/types.ts` | **Low** |
| `src/scheduler/postgres-persistence.ts` | Internal Kysely schema interface `WorkflowSchedulesTable` (lines 23–39) has no field-level JSDoc | **Low** |
| `src/utils/postgres-deps.ts` | `loadPostgresDeps()` function (line 19) lacks a JSDoc comment — no `@returns` documenting the `PostgresDeps` shape, no `@throws` documenting the two peer-dependency error messages | **Low** |
| `src/events/webhook.ts` | `WebhookPayload` interface (lines 87–91) has no field-level JSDoc; `timestamp` type change to `string` (from `Date`) deserves a comment explaining the ISO serialization reason | **Low** |
| `src/planning/registry.ts` | `MemoryRecipeRegistry.getDefault` fallback logic (lines 163–177): falls back to "lowest priority number" but the `priority` semantics (lower = higher precedence?) are not documented | **Low** |
| `src/utils/logger.ts` | `ConsoleLogger` individual methods (`debug`, `info`, `warn`, `error`) have no JSDoc; minor since names are self-explanatory, but inconsistent with how other classes document their methods | **Low** |

---

## Comment Quality Issues

### 1. Stale "Phase 3 / future" module comment — `src/scheduler/types.ts` lines 1–5
```typescript
/**
 * Scheduler types for the workflow engine.
 * Note: The full scheduler implementation is in Phase 3.
 * This file defines the interfaces for future implementation.
 */
```
**Issue:** The scheduler is fully implemented. `CronScheduler` (cron.ts), `SQLiteSchedulePersistence`, and `PostgresSchedulePersistence` are all production-ready and exported. The comment is actively misleading — a developer reading this file might think the scheduler is a stub or WIP when it is not.

### 2. `WorkflowSchedule` fields use inconsistent comment style — `src/scheduler/types.ts` lines 22–38
```typescript
// For cron triggers
cronExpression?: string;
timezone?: string;

// For workflow completion triggers
triggerOnWorkflowKind?: WorkflowKind;
```
**Issue:** Every other exported interface in the codebase uses `/** per-field JSDoc */`. These fields use plain inline `//` section comments, which are not picked up by IDEs or documentation generators (e.g. TypeDoc). Hovering over `cronExpression` in an IDE will show no tooltip.

### 3. `WebhookPayload.timestamp` type change undocumented — `src/events/webhook.ts` lines 87–91
```typescript
export interface WebhookPayload {
  event: Omit<WorkflowEvent, 'timestamp'> & { timestamp: string };
  deliveredAt: string;
  webhookId: string;
}
```
**Issue:** The `timestamp` field is re-typed from `Date` to `string` via an intersection. No comment explains why (JSON serialization). A developer extending this type may be confused by the override pattern.

### 4. Missing `@throws` on `loadPostgresDeps` — `src/utils/postgres-deps.ts` line 19
**Issue:** The function throws two distinct errors (missing `kysely`, missing `pg`) documented only inside the `catch` blocks. These should be surfaced as `@throws` tags so callers know what to expect without reading the implementation.

### 5. `MemoryRecipeRegistry.getDefault` priority semantics ambiguous — `src/planning/registry.ts` lines 163–177
```typescript
// Fall back to the first recipe with priority 0 or lowest priority
const recipes = this.getByKind(workflowKind);
return recipes.reduce((lowest, current) => {
  const currentPriority = current.priority ?? 0;
  const lowestPriority = lowest.priority ?? 0;
  return currentPriority < lowestPriority ? current : lowest;
});
```
**Issue:** The comment says "lowest priority" but the code returns the recipe with the *smallest numeric priority value*. The `Recipe.priority` field docs in `planning/types.ts` describe it as a scoring preference but do not define the direction (is `0` highest or lowest precedence?). The fallback logic in `getDefault` and the selection logic in `planner.ts` use priority in opposite senses — `planner.ts` picks the *highest* scoring recipe while `getDefault` picks the *lowest* numeric priority, which is inconsistent and undocumented.

---

## Recommendations

1. **Fix the stale "Phase 3" comment in `src/scheduler/types.ts` (lines 1–5).**
   Replace the module doc with a description of what is actually present: the type contracts for the fully-implemented cron/completion-trigger scheduler. This is the only actively misleading comment in the codebase and the highest priority fix.

2. **Convert `WorkflowSchedule` field comments to per-field JSDoc (`src/scheduler/types.ts` lines 17–39).**
   Change `// For cron triggers` section headers to `/** @see CronScheduler */` field-level JSDoc on each property. This makes field descriptions visible in IDE tooltips and picked up by TypeDoc, consistent with every other interface in the project.

3. **Add JSDoc to all public methods of `MemoryStorageAdapter` (`src/storage/memory.ts` lines 30–178).**
   The 11 interface-implementing methods currently have no documentation. Even a one-line `/** Creates and persists a new workflow run record. */` per method brings it in line with `SQLiteStorageAdapter` and `PostgresStorageAdapter`, which document the same methods. This matters because `MemoryStorageAdapter` is a common starting point for new users.

4. **Add JSDoc to the public methods of both registry classes (`src/planning/registry.ts`).**
   `MemoryStepHandlerRegistry.register`, `get`, `has`, `list`, `listByTag` and `MemoryRecipeRegistry.register`, `registerAll`, `get`, `has`, `getByKind`, `getVariant`, `getDefault`, `listVariants`, `query`, `list` are all exported and part of the public API surface but have no JSDoc. These are called directly by consumers building planning pipelines.

5. **Clarify priority semantics across `Recipe.priority`, `MemoryRecipeRegistry.getDefault`, and `RuleBasedPlanner` (`src/planning/types.ts`, `src/planning/registry.ts`, `src/planning/planner.ts`).**
   Add a `@remarks` or inline comment to `Recipe.priority` stating the direction convention ("lower number = higher precedence" or vice versa) and note that `getDefault` and the scoring-based selection in `RuleBasedPlanner` use different selection axes (numeric priority vs computed score). This prevents silent bugs when users register multiple recipes.

6. **Add `@throws` documentation to `loadPostgresDeps` (`src/utils/postgres-deps.ts` line 19).**
   ```typescript
   /**
    * @throws {Error} If the `kysely` optional peer dependency is not installed.
    * @throws {Error} If the `pg` optional peer dependency is not installed.
    */
   ```
   This is especially useful for library consumers who see only the compiled `.d.ts`.

7. **Document the `WebhookPayload.timestamp` type override (`src/events/webhook.ts` lines 87–91).**
   Add a field-level comment: `/** ISO 8601 string; Date is serialized before delivery so JSON consumers receive a string. */`. This makes the intentional type narrowing legible without requiring developers to trace the intersection type.

8. **Add field-level JSDoc to internal Kysely schema interfaces (`src/storage/postgres.ts` lines 46+, `src/scheduler/postgres-persistence.ts` lines 23–43).**
   While these are internal types, they serve as the authoritative DB-column-to-TypeScript mapping. Adding comments like `/** JSON-serialized input payload */` for `input_json` columns aids future maintainers running schema migrations and helps correlate columns to their domain-type counterparts in `storage/types.ts`.

9. **Add an `@example` block to `MemoryStorageAdapter` (`src/storage/memory.ts` class line 21).**
   All other adapters (`SQLiteStorageAdapter`, `PostgresStorageAdapter`) have `@example` blocks showing construction and engine wiring. `MemoryStorageAdapter` — which is the simplest and most commonly used entry point for new users — is the only adapter without one.

10. **Add a `@deprecated` notice or remove the `transaction()` method from the public-facing `StorageAdapter` interface documentation.**
    `src/storage/sqlite.ts` marks `transaction()` as `@deprecated` on the implementation. If this method is also present on the `StorageAdapter` interface in `storage/types.ts`, the deprecation should be mirrored there so IDEs surface the warning at call sites regardless of which concrete adapter is in use.