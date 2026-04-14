# Comment Assessment: stepflow

**Date**: 2026-04-11T02:48:00.194Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 98e67949-d200-491e-8d2e-333880bba263
**Session**: 1f4952f0-14a9-4677-a164-d0cd05cc6d35

---

## Summary

**Stepflow** is a TypeScript workflow orchestration library (~43 source files, ~30 non-test). Overall documentation quality is **Good to Excellent**, with approximately **67% of source files** carrying JSDoc/TSDoc comments. Public APIs are thoroughly documented; the core engine and utility modules set a high bar. Test files carry no comments, which is appropriate given self-descriptive `describe`/`it` naming. The most notable gaps are confined to a handful of interface implementation methods in the scheduler persistence layer, and two non-obvious semantic behaviors in the planning module that lack any explanatory comment.

**Rating: 8/10** — above industry average; minor targeted additions would close all meaningful gaps.

---

## Well-Documented Areas

### `src/index.ts`
A 56-line module-level JSDoc block enumerates every major feature (workflow registration, async execution, state management, event system, pluggable storage, retry/error handling) followed by a complete 45-line working code example. Serves as the library's living documentation entry point.

### `src/core/engine.ts` (693 lines)
Every public method includes `@param`, `@returns`, and `@throws` tags. Logical sections are separated by banner dividers (`// ========…`). Example:
```ts
/**
 * Register a workflow definition with the engine.
 * @param definition - The workflow definition to register.
 * @throws {WorkflowEngineError} If a workflow with the same kind is already registered.
 */
registerWorkflow(definition: WorkflowDefinition): void
```

### `src/core/orchestrator.ts` — timeout / memory-leak rationale (lines 482–518)
The `executeWithTimeout` helper explains *why* the `finally` block exists, not just what it does:
```ts
/**
 * …The `finally` block is critical: without it, the losing promise's timer/listener
 * would remain active, leaking memory — especially problematic in long-running engines
 * processing many steps.
 */
```
This is exemplary "why" commenting.

### `src/utils/errors.ts`
Every custom error class carries a one-sentence JSDoc stating its purpose and the specific condition that triggers it.

### `src/utils/retry.ts`
`RetryOptions` fields are individually documented. The exponential backoff formula includes an example showing calculated delays at each attempt.

### `src/core/types.ts`
Every interface field has a one-line `/** … */` doc comment. `WorkflowContext`, `WorkflowDefinition`, `WorkflowHooks`, `RunStatus`, and `StepStatus` are all self-contained.

### `src/storage/postgres.ts` — schema type docs (lines 46–128)
Kysely row-type interfaces (`WorkflowRunsTable`, `WorkflowRunStepsTable`, etc.) document every column with field-level comments explaining nullability, units, and JSON encoding:
```ts
/** JSON-serialized output payload, null until run completes. */
output_json: string | null;
/** Execution priority (lower number = higher precedence). */
priority: number;
```

### `src/scheduler/postgres-persistence.ts` — class-level JSDoc with two `@example` blocks
Includes a basic usage example and a "Sharing connection pool" example, covering the two main integration patterns.

---

## Underdocumented Areas

| File | Issue | Severity |
|------|-------|----------|
| `src/planning/planner.ts` | `evaluateCondition()` (line 44): uses `RE2` instead of native `RegExp` for ReDoS safety — security-relevant choice is entirely uncommented | **High** |
| `src/planning/planner.ts` | `exists`/`notExists` operators (lines 95–99): treat empty string `''` as non-existent — opinionated semantic behaviour with no comment | **High** |
| `src/scheduler/postgres-persistence.ts` | `loadSchedules()` (line 306), `saveSchedule()` (line 316), `updateSchedule()` (line 340), `deleteSchedule()` (line 402): public interface methods with no JSDoc | **Medium** |
| `src/planning/planner.ts` | `applyConstraints()` (line 466): `perStepTimeout = maxDuration / steps.length` — evenly distributes budget across steps without noting the equal-duration assumption | **Medium** |
| `src/planning/planner.ts` | `RuleBasedPlanner` class (line 170): single-line class JSDoc; scoring algorithm overview (condition-score vs priority-score vs forced/preferred-variant paths) not explained | **Medium** |
| `src/scheduler/postgres-persistence.ts` | `rowToSchedule()` (line 480): dual JSON.parse path (`typeof … === 'string'` guard) is non-obvious with no comment explaining why it handles both string and pre-parsed JSONB | **Medium** |
| `src/storage/postgres.ts` | `StepflowDatabase` interface (line 130): no doc comment explaining that this is the Kysely schema map tying table names to row types | **Low** |
| `src/scheduler/postgres-persistence.ts` | `ensureInitialized()` (line 166): private guard method with no doc comment | **Low** |
| `src/planning/planner.ts` | `scoreConditions()` scoring formula (lines 127–134) has inline comments but no JSDoc — callers of the public `RuleBasedPlanner` API cannot understand selection scoring from public docs alone | **Low** |
| `src/storage/postgres.ts` | `stripStack()` helper (line 37): has a one-liner but does not explain *why* `stack` is stripped (prevent large stack strings from bloating persisted JSON) | **Low** |
| `src/utils/id.ts` | `generateId()` explains ULID advantages but omits the practical consequence: IDs are lexicographically sortable by creation time | **Low** |
| `src/events/memory.ts` | Channel naming convention explained in code (lines 34–41) but not in any exported type or JSDoc for consumers building custom transports | **Low** |
| `src/scheduler/sqlite-persistence.ts` | `createTables()` has schema comments; `loadSchedules()`, `saveSchedule()`, `deleteSchedule()` interface methods have no JSDoc (same gap as postgres counterpart) | **Low** |
| `src/planning/registry.ts` | `MemoryRecipeRegistry` class has no class-level JSDoc; only individual methods are commented | **Low** |
| `src/core/orchestrator.ts` | `WorkflowCheckpoint` interface is documented, but no comment explains when/why checkpoints are created (only on step completion, not at arbitrary points) | **Low** |

---

## Comment Quality Issues

No clearly **inaccurate** or **misleading** comments were found. The following are cases where comments exist but create a gap between stated and actual behaviour:

### 1. `src/planning/planner.ts:95–99` — `exists`/`notExists` undocumented empty-string treatment
```ts
case 'exists':
  return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';

case 'notExists':
  return fieldValue === undefined || fieldValue === null || fieldValue === '';
```
The corresponding type definition in `src/planning/types.ts` describes `exists` as "field exists and is non-null." It does not mention that `''` is also treated as absent. A consumer who stores an empty string legitimately would get a surprising false from `exists`. No comment at either the operator definition or the implementation site flags this.

### 2. `src/planning/planner.ts:85–93` — RE2 usage is silent
```ts
case 'matches':
  if (typeof fieldValue === 'string' && typeof conditionValue === 'string') {
    try {
      return new RE2(conditionValue).test(fieldValue);
    } catch {
      return false;
    }
  }
```
`RE2` is a linear-time regex engine that prevents ReDoS attacks — a meaningful security property. The comment on `evaluateCondition` (line 42) says only "Evaluate a single condition against a value." Callers writing user-supplied patterns need to know RE2 syntax differs from ECMA regex (e.g., no lookaheads), and security-conscious reviewers need to know the DoS protection is intentional.

### 3. `src/scheduler/postgres-persistence.ts:387` — condition always true for `domainKey`
```ts
if (updates[domainKey] !== undefined || merged[domainKey] !== undefined) {
```
Because `merged` is `{ ...existing, ...updates }`, `merged[domainKey]` is always defined for fields present in the existing row. The inline comment above (lines 342–345) correctly describes intent ("only included if explicitly provided"), but the condition as written effectively includes every field on every update. The comment describes the goal, not the actual behaviour — a subtle mislead.

---

## Recommendations

1. **`src/planning/planner.ts:85–93` — Document RE2's ReDoS safety in `evaluateCondition`**
   Add to the `matches` case a brief comment: `// RE2 provides linear-time matching, preventing ReDoS attacks from user-supplied patterns.` Also note in the `evaluateCondition` JSDoc that RE2 syntax is used (no lookaheads, no backreferences), so callers know pattern compatibility constraints.

2. **`src/planning/planner.ts:95–99` and `src/planning/types.ts` — Align `exists` docs with empty-string behaviour**
   Either update the `ConditionOperator` type definition to read "field is non-null and non-empty-string," or add a `// NOTE:` inline explaining the empty-string-as-absent convention. Doing both ensures consumers reading either the type or the implementation get consistent expectations.

3. **`src/scheduler/postgres-persistence.ts:306–408` — Add JSDoc to all four public `SchedulePersistence` interface methods**
   `loadSchedules`, `saveSchedule`, `updateSchedule`, and `deleteSchedule` are part of the persistence contract but have no documentation. At minimum add `@returns` and `@throws` tags to match the documented `getSchedule`, `getDueSchedules`, and `getCompletionTriggers` below them. Apply the same fix to `src/scheduler/sqlite-persistence.ts` for consistency.

4. **`src/planning/planner.ts:170` — Expand `RuleBasedPlanner` class JSDoc**
   The current one-line class comment ("Rule-based planner that selects recipes based on condition matching") does not explain the selection algorithm. Add a paragraph describing the scoring hierarchy: forced recipe → preferred variant → condition scoring (50 + 10×N conditions, capped at 100) → default recipe → first available. This allows users to understand and predict selection without reading the source.

5. **`src/planning/planner.ts:462–468` — Document the per-step timeout distribution assumption**
   ```ts
   const perStepTimeout = constraints.maxDuration
     ? Math.floor(constraints.maxDuration / steps.length)
     : undefined;
   ```
   Add a comment: `// Budget is divided equally across steps; steps with inherently longer durations may time out even if the overall run would complete within maxDuration.` This sets expectations and helps users tune `maxDuration` correctly.

6. **`src/scheduler/postgres-persistence.ts:480` — Document the dual JSON.parse guard in `rowToSchedule`**
   The pattern `typeof row.X === 'string' ? JSON.parse(row.X) : row.X` appears six times without explanation. Add a single comment near the first occurrence: `// Kysely returns JSONB columns pre-parsed in some drivers; guard ensures correct deserialization regardless of driver behaviour.`

7. **`src/planning/types.ts` — Document each `ConditionOperator` value in the enum/union**
   The `ConditionOperator` type has a comment block, but individual values like `'matches'`, `'contains'`, `'exists'` have no per-value docs. Add a TSDoc `@remarks` or switch to a documented string union listing what each operator accepts (e.g., `'matches'` works on strings using RE2 syntax; `'contains'` works on both strings and arrays).

8. **`src/core/orchestrator.ts` — Document when checkpoints are written**
   `WorkflowCheckpoint` is documented, but `executeWorkflow` does not explain that checkpoints capture state only after a step fully completes. Add a note in the `ExecuteOptions.checkpoint` field doc: `// Checkpoint is built incrementally as steps complete; a partially executed step is NOT checkpointed and will re-run on resume.`

9. **`src/storage/postgres.ts:130` — Add JSDoc to `StepflowDatabase`**
   This interface is the Kysely schema map. A one-line comment — `/** Kysely database schema mapping table names to their row types. */` — makes the architectural role immediately clear to contributors adding new tables.

10. **`src/utils/id.ts` — Note sort-by-creation-time property in `generateId` JSDoc**
    The existing comment explains ULID advantages but omits the most practically useful one: generated IDs are lexicographically sortable by creation time, making them suitable as primary keys with implicit time-ordering. Adding this helps consumers decide whether to add a separate `created_at` sort column.