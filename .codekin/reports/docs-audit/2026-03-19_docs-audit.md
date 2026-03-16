# Documentation Audit: stepflow

**Date**: 2026-03-19T10:29:30.606Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 603713a3-01c7-448b-9ef9-137b94c26aa4
**Session**: 4c240947-830a-4037-81bd-7137556b3b60

---

Now I have all the data needed to produce the report.

## Summary

**Total documentation files:** 3 (2,163 lines, ~60 KB)
**Files needing attention:** 2 (README.md, docs/stepflow-api-reference.md)
**Health rating: Needs cleanup**

The repo is lean with a well-structured three-file doc set. All internal cross-file links resolve correctly. However, two meaningful accuracy defects exist in the README's Planning System example, and the API reference carries a broken subpath-import example and three undocumented public exports. The `github-packages-setup.md` is frozen at January 2025 while the codebase has seen extensive change, though its install instructions remain valid.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|--------------|---------|--------|
| `README.md` | 406 | 2026-03-16 | Project overview, quick start, core concept examples, feature survey | Stale (2 inaccurate examples) |
| `docs/stepflow-api-reference.md` | 1,660 | 2026-03-16 | Complete API reference: classes, interfaces, config, SQL schema, integration patterns | Stale (broken subpath imports, 3 undocumented exports) |
| `docs/github-packages-setup.md` | 97 | 2026-01-25 | GitHub Packages publish/install workflow for maintainers and consumers | Current (process unchanged) |

---

## Staleness Findings

### 1. `README.md` — `createRegistry()` destructuring uses wrong key names (line 391)

```typescript
// Documented (wrong):
const { recipeRegistry, stepHandlerRegistry } = createRegistry();

// Actual return type (CombinedRegistry):
const { recipes, handlers } = createRegistry();
```

`createRegistry()` in `src/planning/registry.ts:360` returns `{ recipes, handlers }`. The names `recipeRegistry` / `stepHandlerRegistry` do not exist on the returned object. The API reference (line 1149) correctly uses `{ recipes, handlers }`, making the README and API reference inconsistent with each other.

**Source changed:** `src/planning/registry.ts` was updated in multiple commits after this README section was first written. The API reference was rewritten on 2026-02-28 and fixed this correctly, but the README was not updated to match.

---

### 2. `README.md` — `planner.plan()` call uses a wrong signature (line 395)

```typescript
// Documented (wrong):
const plan = await planner.plan({ goal: 'process-order', context: { orderId: '123' } });

// Actual signature (src/planning/planner.ts:349):
async plan(workflowKind: WorkflowKind, input: Record<string, unknown>, context?: PlanningContext): Promise<Plan>
```

The README passes a single object argument. The actual method accepts positional arguments `(workflowKind, input, context?)`. This example will throw a TypeScript compile error.

---

### 3. `README.md` — `scheduler.start()` missing `await` (line 342)

```typescript
// Documented:
scheduler.start();

// Actual (src/scheduler/cron.ts:115):
async start(): Promise<void>
```

`CronScheduler.start()` is async. Omitting `await` means scheduling errors are silently swallowed and the scheduler is used before it has finished loading persisted schedules.

---

### 4. `docs/stepflow-api-reference.md` — Subpath exports use wrong package name (lines 1432–1437)

```typescript
// Documented (wrong):
import { ... } from 'stepflow/storage';
import { ... } from 'stepflow/events';
import { ... } from 'stepflow/scheduler';

// Actual package name (package.json):
import { ... } from '@multiplier-labs/stepflow/storage';
import { ... } from '@multiplier-labs/stepflow/events';
import { ... } from '@multiplier-labs/stepflow/scheduler';
```

The subpath exports are defined correctly in `package.json` under `@multiplier-labs/stepflow`, but the API reference references the bare `stepflow` name, which will fail to resolve.

---

### 5. `docs/github-packages-setup.md` — Frozen at 2026-01-25 while codebase evolved significantly

The file has not been touched since the initial package publishing setup. Since then:
- Version bumped to `0.2.6`
- Multiple security fixes, dependency upgrades (`cron-parser v5`, `re2`)
- PostgreSQL support was matured

The install and publish steps themselves remain accurate, but the document contains no mention of optional peer dependencies (`pg`, `kysely`, `better-sqlite3`) that consumers now need for non-default storage backends.

---

## Accuracy Issues

| File | Location | Issue |
|------|----------|-------|
| `README.md` | Line 391 | `createRegistry()` destructures `{ recipeRegistry, stepHandlerRegistry }` — those keys don't exist; correct keys are `{ recipes, handlers }` |
| `README.md` | Line 395 | `planner.plan({ goal, context })` — wrong call signature; actual is `plan(workflowKind, input, context?)` |
| `README.md` | Line 342 | `scheduler.start()` missing `await`; method is `async` |
| `docs/stepflow-api-reference.md` | Lines 1432–1437 | Subpath imports use `'stepflow/...'` instead of `'@multiplier-labs/stepflow/...'` |
| `docs/stepflow-api-reference.md` | Error Classes section | `WaitForRunTimeoutError` is exported from `src/index.ts:211` but absent from the error class table |
| `docs/stepflow-api-reference.md` | Logger section | `sanitizeErrorForStorage` (utility) and `LogLevel` (type) are exported from `src/index.ts:220,222` but not documented |
| `docs/stepflow-api-reference.md` | TypeScript Types Reference | Types section does not list `WaitForRunTimeoutError`, `sanitizeErrorForStorage`, `LogLevel`, or `CombinedRegistry` despite all being public exports |

---

## Overlap & Redundancy

### Installation instructions (minor overlap)

Both `README.md` (lines 16–22) and `docs/stepflow-api-reference.md` (lines 40–58) document the install command and optional peer dependencies.

- **README.md** has the shorter version (install command + link to setup guide).
- **API reference** has the fuller version (install command + peer dependency breakdown).

This is acceptable duplication for a library—users expect both files to be self-contained. No consolidation needed, but the README should link explicitly to the peer deps section of the API reference for clarity.

### Quick Start examples (minor overlap)

Both files contain a Quick Start section with a full workflow definition example. The examples cover different use cases (README: order processing; API reference: email campaign), so they serve different purposes. No action required.

---

## Fragmentation

**No significant fragmentation detected.** The three-file structure is appropriately lean:
- `README.md` → landing page / overview
- `docs/stepflow-api-reference.md` → complete API reference
- `docs/github-packages-setup.md` → ops runbook for package distribution

No split specs, plan documents, or proposal files were found.

---

## Action Items

### Delete

| File | Reason |
|------|--------|
| *(none)* | All three files serve distinct, current purposes. None are candidates for deletion. |

---

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|-------------|-------------|---------------------|
| *(none)* | — | No beneficial merges identified at current scale. |

---

### Update

| File | Section | What to Fix |
|------|---------|-------------|
| `README.md` | Planning System (line 391) | Change `{ recipeRegistry, stepHandlerRegistry }` → `{ recipes, handlers }` |
| `README.md` | Planning System (line 395) | Rewrite `planner.plan({ goal, context })` → `planner.plan('process-order', { orderId: '123' })` |
| `README.md` | Scheduling / Cron Scheduler (line 342) | Add `await` before `scheduler.start()` |
| `docs/stepflow-api-reference.md` | TypeScript Types Reference — subpath imports (lines 1432–1437) | Change `'stepflow/storage'` → `'@multiplier-labs/stepflow/storage'` (same for `/events`, `/scheduler`) |
| `docs/stepflow-api-reference.md` | Error Handling — Error Classes table | Add `WaitForRunTimeoutError` row: code `WAIT_FOR_RUN_TIMEOUT`, constructor `(runId, timeoutMs)` |
| `docs/stepflow-api-reference.md` | Utilities — Logger section | Document `sanitizeErrorForStorage(error): WorkflowError` and `LogLevel` type |
| `docs/stepflow-api-reference.md` | TypeScript Types Reference — classes block | Add `WaitForRunTimeoutError` to import list; add `sanitizeErrorForStorage`, `LogLevel`, `CombinedRegistry` |
| `docs/github-packages-setup.md` | Installing in Projects | Add a note that consumers of SQLite, PostgreSQL, or Socket.IO transports need the relevant optional peer dependencies (`better-sqlite3`, `pg` + `kysely`, `socket.io`) |

---

## Recommendations

1. **Fix the three broken README code examples immediately** (createRegistry keys, planner.plan signature, missing await on scheduler.start). These are the only examples in the README for the Planning System and Scheduler — broken examples actively mislead users who copy-paste them.

2. **Fix the subpath import package name** in the API reference. `'stepflow/...'` resolves to nothing; this will confuse anyone who follows the example.

3. **Add the three undocumented public exports** (`WaitForRunTimeoutError`, `sanitizeErrorForStorage`, `LogLevel`) to the API reference. They are publicly exported and their absence creates a false impression that they don't exist.

4. **Add a peer dependencies note to `docs/github-packages-setup.md`**. The current file focuses only on authentication and publishing. Consumers who want PostgreSQL or SQLite hit an undiscoverable runtime error unless they read the API reference carefully.

5. **Cross-link the API reference from the Planning System section of the README**. The existing link at the bottom of that section (`See the API Reference...`) is good, but the wrong destructuring syntax above it will confuse readers before they get there.

6. **Consider adding a `CHANGELOG.md` or linking to GitHub Releases** from the README. The project is at version `0.2.6` with non-trivial changes in each minor version; consumers have no in-repo document to track what changed between versions.

7. **Add peer dependencies to the README's Installation section**. Currently only the install command is shown. A one-liner (`# SQLite: npm install better-sqlite3 / # PostgreSQL: npm install pg kysely`) here would reduce friction significantly.

8. **Consider a `CONTRIBUTING.md`**. There is no developer setup guide, making it harder for new contributors to build and test the project.

9. **Verify `github-packages-setup.md` versioning instructions** are still accurate for `npm version` + GitHub release flow. The workflow file (`.github/workflows/publish.yml`) has not been publicly audited in this pass but the documented manual steps appear structurally unchanged.

10. **Set a staleness policy**: given the frequency of automated audit-driven changes to the codebase, documentation updates should be included in the same PR as the code changes that affect public API surface. The pattern of fixing docs in a separate "documentation audit findings" commit (as seen in the git log) introduces a lag window where users on `main` encounter broken examples.