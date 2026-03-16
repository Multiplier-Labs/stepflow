# Documentation Audit: stepflow

**Date**: 2026-03-23T02:19:27.692Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 3914c480-3cf0-4d21-b38d-9ef74390eac4
**Session**: c54db08d-85ab-4e97-851c-06ac6935adb7

---

Now I have all the information needed to produce the report.

## Summary

This repository contains **3 project documentation files** (excluding node_modules and tooling reports). The docs are generally well-structured with a clear role separation, but contain **5 accuracy issues of varying severity**, including one critical omission introduced by a security breaking change that was not reflected in the docs.

**Health rating: Needs Cleanup** — the core structure is sound, but the security breaking change to `setupClientHandlers()` makes two examples produce insecure code, and several smaller inaccuracies need correction.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|---------------|---------|--------|
| `README.md` | 406 | 2026-03-16 | User-facing overview: installation, quick start, core concepts, storage, events, scheduling, planning | **Stale (partial)** |
| `docs/stepflow-api-reference.md` | 1,660 | 2026-03-19 | Complete API reference: all classes, interfaces, config options, schema, integration patterns | **Stale (partial)** |
| `docs/github-packages-setup.md` | 97 | 2026-01-25 | Ops/maintainer runbook for publishing to and installing from GitHub Packages | Current |

---

## Staleness Findings

### `README.md` — last modified 2026-03-16

**1. Planning System example uses wrong return shape from `createRegistry()`**
The README (lines 390–395) reads:
```typescript
const { recipeRegistry, stepHandlerRegistry } = createRegistry();
const planner = new RuleBasedPlanner({ recipeRegistry, stepHandlerRegistry });
const plan = await planner.plan({ goal: 'process-order', context: { orderId: '123' } });
```
Actual source (`src/planning/registry.ts:352–368`):
```typescript
// createRegistry() returns { recipes, handlers } — not { recipeRegistry, stepHandlerRegistry }
export interface CombinedRegistry {
  recipes: MemoryRecipeRegistry;
  handlers: MemoryStepHandlerRegistry;
}
```
Actual planner config (`src/planning/planner.ts:144`): field is `handlerRegistry`, not `stepHandlerRegistry`.
Actual `planner.plan()` signature (`src/planning/planner.ts:349`): `plan(workflowKind, input, context?)` — not an object argument.

All three lines in this code block would produce TypeScript compilation errors.

**2. `scheduler.start()` missing `await`**
README line 341: `scheduler.start()` — but `CronScheduler.start()` is `async` (`src/scheduler/cron.ts:114`). Missing `await` means scheduling errors are silently swallowed.

**3. `setupClientHandlers()` missing required `authorize` parameter**
README line 277:
```typescript
events.setupClientHandlers(socket);
```
After security commit `d61858c` (2026-03-19 — three days *after* the README was last updated), the `authorize` callback became **required**. Correct call signature (`src/events/socketio.ts:201`):
```typescript
events.setupClientHandlers(socket, async (runId, socket) => {
  return /* authorization check */;
});
```
Code following the README example compiles but allows any connected client to subscribe to any run's events.

---

### `docs/stepflow-api-reference.md` — last modified 2026-03-19

**4. `setupClientHandlers()` missing required `authorize` parameter**
Line 406: `events.setupClientHandlers(socket);` — same issue as README. The security fix (`d61858c`) changed this to require an `authorize` argument, but the docs were not updated. The commit touched only `src/events/socketio.ts` and `src/events/webhook.ts`, not the docs.

**5. `StepStatus` type is incomplete**
Line 661 documents:
```typescript
status: StepStatus;  // 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
```
Actual type (`src/core/types.ts:24`):
```typescript
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled';
```
`'canceled'` was added as part of the abort/cancel status fixes (commits `f69b20a`, `b83b1db`).

**6. `SQLiteStorageAdapter.tablePrefix` documented as deprecated/ignored but is still active**
Line 778:
```typescript
// tablePrefix: 'workflow', // @deprecated - ignored, always uses 'workflow_' prefix
```
Actual `src/storage/sqlite.ts:161`:
```typescript
this.prefix = config.tablePrefix ?? 'workflow';
```
The option is still read and applied. The deprecation claim is incorrect, and the comment about `'workflow_'` being forced is wrong — the default is `'workflow'` (which becomes `workflow_runs`, `workflow_run_steps`, `workflow_events` via string concatenation).

**7. `WaitForRunTimeoutError` missing from Error Classes documentation**
The error class is exported from `src/index.ts` and defined in `src/utils/errors.ts:134`, but is absent from:
- The import example in the Error Handling section (lines 1237–1246)
- The TypeScript Types Reference class list (lines 1412–1428)

---

## Accuracy Issues

| File | Line(s) | Issue | Correct Value |
|------|---------|-------|---------------|
| `README.md` | 277 | `setupClientHandlers(socket)` — missing required `authorize` arg | `setupClientHandlers(socket, authorizeFn)` |
| `README.md` | 391 | `createRegistry()` destructuring uses wrong field names | Returns `{ recipes, handlers }` |
| `README.md` | 394 | `RuleBasedPlanner` config uses `stepHandlerRegistry` | Field is named `handlerRegistry` |
| `README.md` | 395 | `planner.plan({ goal, context })` — wrong signature | `planner.plan(workflowKind, input, context?)` |
| `README.md` | 341 | `scheduler.start()` — missing `await` | `await scheduler.start()` |
| `docs/stepflow-api-reference.md` | 406 | `setupClientHandlers(socket)` — missing required `authorize` arg | `setupClientHandlers(socket, authorizeFn)` |
| `docs/stepflow-api-reference.md` | 661 | `StepStatus` missing `'canceled'` | Add `\| 'canceled'` to the inline comment |
| `docs/stepflow-api-reference.md` | 778 | `tablePrefix` marked `@deprecated - ignored` | Option is still active; default is `'workflow'` |
| `docs/stepflow-api-reference.md` | 1237–1246 | `WaitForRunTimeoutError` absent from error import example | Add to import and class table |

---

## Overlap & Redundancy

The three documentation files have a clear division of purpose with limited redundancy, but two sections are nearly duplicated:

**Quick Start**
Both `README.md` (lines 24–75) and `docs/stepflow-api-reference.md` (lines 63–104) contain a "Quick Start" section with a different example workflow but identical structural purpose. Neither is wrong, but readers may be confused about which is canonical.

**Storage, Events, Scheduling overviews**
`README.md` contains mid-depth prose for each subsystem (Storage, Event Transports, Scheduling, Planning). The API reference covers the same subsystems at higher depth. There is no outright duplication, but the README effectively functions as a "quick API reference lite," which risks drift as the API reference is updated independently. The most serious example of this drift is the `setupClientHandlers()` discrepancy, where the security-breaking change was applied in neither doc.

**Recommendation**: The README's Storage, Events, Scheduling, and Planning sections are brief enough to maintain separately, but the Quick Start example in the API reference adds no value that the README's Quick Start doesn't already cover — it could be removed from the API reference or differentiated more clearly (e.g., by labeling it "Minimal Example").

---

## Fragmentation

No fragmentation issues. The three files serve distinct audiences (user overview, developer API reference, ops runbook) and none are candidates for splitting further. No spec or proposal files exist in the docs.

The `.codekin/reports/` directory contains auto-generated audit reports (`docs-audit`, `code-review`, etc.) but these are tooling artifacts, not project documentation, and are correctly excluded from the repo's `.gitignore`-adjacent location.

---

## Action Items

### Delete

| File | Reason |
|------|--------|
| _(none)_ | All three files serve active purposes and have no superseded equivalents. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|--------------|-------------|---------------------|
| `README.md` Quick Start + `docs/stepflow-api-reference.md` Quick Start | `docs/stepflow-api-reference.md` | Keep the README Quick Start (more representative, used by GitHub landing page). In the API reference, rename the duplicate to "Minimal Example" or drop it in favour of a cross-reference. |

### Update

| File | Section | What Changed in Code |
|------|---------|----------------------|
| `README.md` | Socket.IO Events (line 277) | `setupClientHandlers(socket)` → requires second `authorize: SocketIOAuthorizeFn` argument since commit `d61858c` |
| `README.md` | Planning System (lines 390–396) | `createRegistry()` returns `{ recipes, handlers }`; planner config field is `handlerRegistry`; `planner.plan()` takes positional args `(workflowKind, input, context?)` |
| `README.md` | Scheduling (line 341) | `scheduler.start()` is async — needs `await` |
| `docs/stepflow-api-reference.md` | SocketIOEventTransport (line 406) | Same `setupClientHandlers` breaking change as README; add `authorize` param and `SocketIOAuthorizeFn` type explanation |
| `docs/stepflow-api-reference.md` | Core Record Types (line 661) | `StepStatus` inline comment missing `\| 'canceled'` (added in abort-fix PRs) |
| `docs/stepflow-api-reference.md` | SQLiteStorageAdapter (line 778) | Remove `@deprecated - ignored` annotation from `tablePrefix`; correct default to `'workflow'` |
| `docs/stepflow-api-reference.md` | Error Handling (lines 1237–1246, 1412–1428) | Add `WaitForRunTimeoutError` to import example and class table |

---

## Recommendations

1. **Fix `setupClientHandlers()` in both docs immediately (security).** The current examples show a one-argument call that produces an insecure configuration — any subscriber can receive events for any run. This is the highest-priority fix because it actively misleads developers about a security contract.

2. **Fix the Planning System example in README.md.** All three lines of the planner snippet are wrong (`createRegistry` field names, `RuleBasedPlanner` config key, `planner.plan` signature). This is a type-error that would surface immediately at compile time, but it erodes trust in the README.

3. **Add `await` to `scheduler.start()` in README.md.** Async errors from start-up would be silently unhandled without it.

4. **Correct `StepStatus` in the API reference.** The missing `'canceled'` value was added in active PRs and is part of the public type; omitting it means consumers who pattern-match on step statuses may have unreachable branches.

5. **Fix the `tablePrefix` deprecation comment.** The comment is factually incorrect in both directions: the option is still honoured, and the "always `workflow_`" claim is wrong. This could cause a consumer to either pass a prefix believing it's ignored, or hardcode `workflow_` in a query, both of which are incorrect.

6. **Add `WaitForRunTimeoutError` to the Error Handling section.** It is exported from the public API but undocumented. Consumers who want to distinguish `waitForRun` timeouts from step timeouts have no doc to reference.

7. **Establish a doc-update checklist in the PR template.** Three of the five issues above stem from code changes (security fix, abort-status fix, cancel-status fix) that updated source and tests but not the docs. A simple checkbox in `.github/pull_request_template.md` — "Did you update `docs/` for API changes?" — would catch most of these.

8. **Remove or differentiate the duplicate Quick Start in the API reference.** It adds navigation noise without extra information. A single cross-reference to the README Quick Start is sufficient.

9. **Bump `docs/github-packages-setup.md` last-modified signal.** The file is functionally accurate (workflow file matches, PAT steps are correct), but at 57 days old it will accumulate false "stale" flags in future audits. A minor factual touch (e.g., noting the current version number) on the next release cycle would reset the staleness clock without requiring content changes.

10. **Consider adding a CONTRIBUTING doc note about the dual-interface design.** The `StorageAdapter` vs `WorkflowStorage` split is a significant footgun for contributors — the API reference explains it well, but the README is silent on it. Adding a one-paragraph pointer in the README's Storage section would reduce the number of issues filed against it.