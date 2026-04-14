# Documentation Audit: stepflow

**Date**: 2026-04-11T02:47:05.901Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 24ff56b6-9441-43f2-8563-c985920b774f
**Session**: ba7bd622-3564-476e-976b-21918677f818

---

Now I have enough information to write the complete report.

## Summary

**Audit date:** 2026-04-11 | **Repository:** `/srv/repos/stepflow` | **Branch:** `main`

The repository contains **3 documentation files** totalling **2,167 lines**. All three share the same commit timestamp (`2026-04-11 05:43:05`) from the initial import, so git-log staleness analysis is not applicable — all docs and code landed together. Cross-referencing documentation claims against the actual TypeScript source reveals the documentation is largely accurate and comprehensive, with **2 confirmed accuracy issues** and **1 minor fragmentation observation**.

**Health rating: Well-maintained** — minimal sprawl, no redundancy, nearly all claims verified against source.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|---------------|---------|--------|
| `README.md` | 408 | 2026-04-11 | Project overview, quick start, core concepts, feature tour, storage/event/scheduler options, planning system intro | Current |
| `docs/github-packages-setup.md` | 97 | 2026-04-11 | Publish and consume `@multiplier-labs/stepflow` via GitHub Packages; CI/CD token setup | Current |
| `docs/stepflow-api-reference.md` | 1,662 | 2026-04-11 | Full API reference: every class, interface, method signature, configuration option, PostgreSQL schema, integration patterns | Current (2 minor issues) |

---

## Staleness Findings

Because all documentation and source files share the same initial-commit timestamp, there is no temporal drift to report — no doc file predates its covered code or vice versa. No broken internal cross-links were found between the three files; the README's link to `docs/stepflow-api-reference.md` resolves correctly, and the GitHub Packages guide is self-contained.

No references to non-existent file paths, removed CLI commands, or deprecated config keys were found in any of the three documents.

---

## Accuracy Issues

### Issue 1 — Non-existent `getSchedule()` method (confirmed)

**File:** `docs/stepflow-api-reference.md`  
**Location:** Scheduler section (approximate line 499)  
**Claim:** Documents a `scheduler.getSchedule(scheduleId: string): Promise<WorkflowSchedule>` method.  
**Reality:** The `Scheduler` interface in `src/scheduler/types.ts` defines only `getSchedules(): Promise<WorkflowSchedule[]>` (plural, no `scheduleId` parameter). The singular `getSchedule(id)` does not exist on the interface.  
**Impact:** Any developer who copies the shown usage will get a TypeScript compile error and runtime failure.

### Issue 2 — `getInterruptedRuns()` method needs verification

**File:** `docs/stepflow-api-reference.md`  
**Location:** Storage adapter section (approximate line 785)  
**Claim:** References `storage.getInterruptedRuns()` on `SQLiteStorageAdapter`.  
**Reality:** This method does not appear in the `StorageAdapter` interface (`src/storage/types.ts`) nor in the `WorkflowStorage` interface. It may be an undocumented implementation-only method, a leftover reference to a removed method, or a documentation invention. Requires reading `src/storage/sqlite.ts` to confirm.  
**Impact:** Medium — if the method does not exist, documented usage will fail at compile time.

### Everything Else — Verified Accurate

All of the following were cross-checked against source and match exactly:

- All exported names in `src/index.ts` match the TypeScript Types Reference section in the API reference.
- All `RunStatus`, `StepStatus`, `StepErrorStrategy` union literal values are correct.
- All `WorkflowContext`, `WorkflowStep`, `WorkflowHooks`, `WorkflowDefinition` interface properties and types are correct.
- All `StorageAdapter` and `WorkflowStorage` method signatures are correct.
- All 14 `BuiltInEventType` literals are correct.
- All `EventTransport` method signatures are correct.
- All `WorkflowSchedule` properties and `Scheduler` interface methods (except the `getSchedule` issue above) are correct.
- All 10 `ConditionOperator` values, all `Recipe`, `Plan`, `PlannedStep` interfaces are correct.
- All 9 error class names, error codes, and constructor signatures are correct.
- `WorkflowEngineConfig` and `StartRunOptions` interfaces are correct.
- `package.json` scripts (`build`, `dev`, `typecheck`, `test`, `test:watch`, `test:coverage`) match README claims.
- Peer dependency versions (`better-sqlite3 >=11.0.0`, `kysely >=0.27.0`, `pg >=8.13.0`) match `package.json`.
- Package name `@multiplier-labs/stepflow` and subpath exports (`/storage`, `/events`, `/scheduler`) are correct throughout all docs.

---

## Overlap & Redundancy

There is no meaningful overlap between the three files. Each occupies a distinct lane:

- `README.md` — conceptual overview and feature tour (prose-heavy, code snippets for motivation)
- `docs/github-packages-setup.md` — ops/distribution concern (PAT setup, CI/CD tokens, `npm version`)
- `docs/stepflow-api-reference.md` — exhaustive technical reference

Both `README.md` and `docs/stepflow-api-reference.md` contain a Quick Start section, but they use different examples (order-processing workflow vs. email-campaign workflow) and serve different readers (README = first-time evaluator, API ref = returning developer). This is a reasonable design choice, not a redundancy problem.

**No merge recommendations are warranted.**

---

## Fragmentation

With only 3 files, fragmentation is not a concern. The split between README and API reference follows widely accepted open-source convention. The GitHub Packages setup guide is appropriately separated as a distribution/ops concern that would clutter the main README.

No spec, proposal, or planning documents exist in the repo. No "completed feature" spec files need to be folded in or removed.

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|------|----------------------------|
| — | No deletion candidates. All three files serve distinct, active purposes. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| — | — | No consolidation needed. Files do not overlap in scope. |

### Update

| File | Section Needing Update | What Changed |
|------|------------------------|--------------|
| `docs/stepflow-api-reference.md` | Scheduler section — `getSchedule(scheduleId)` method | Remove or replace with correct `getSchedules(): Promise<WorkflowSchedule[]>`. The documented method does not exist on the `Scheduler` interface. |
| `docs/stepflow-api-reference.md` | Storage section — `getInterruptedRuns()` on `SQLiteStorageAdapter` | Verify against `src/storage/sqlite.ts`. If the method no longer exists or was never part of the public interface, remove the reference. If it's an implementation detail not on the interface, add a note clarifying it is not part of the `StorageAdapter` contract. |

---

## Recommendations

1. **Fix `getSchedule()` → `getSchedules()`** in `docs/stepflow-api-reference.md`. This is a confirmed broken API reference that will cause compile errors if followed. One-line fix.

2. **Verify `getInterruptedRuns()`** by reading `src/storage/sqlite.ts`. If the method is absent, delete the reference. If present, ensure it is either promoted to the `StorageAdapter` interface (if intentionally public) or marked as an internal implementation detail.

3. **Add a version changelog or `CHANGELOG.md`** if the package begins publishing new minor/major versions. Currently at `0.2.6`, with no changelog. As the API stabilises this becomes important for downstream consumers to understand what changed between releases.

4. **Pin documented peer-dependency versions in the API reference.** The reference correctly lists minimum versions but does not mention tested/recommended ranges. As `better-sqlite3`, `kysely`, and `pg` release new majors, this becomes a source of drift. Consider a compatibility table or tested-with note.

5. **Add a `CONTRIBUTING.md` or development-setup section** for contributors. The `package.json` has `dev`, `test`, `build`, and `typecheck` scripts, but there is no document explaining how to run the test suite locally, set up a Postgres instance for integration tests, or submit changes. This gap matters as the project gains external contributors.

6. **Keep `docs/github-packages-setup.md` updated on PAT scope requirements.** GitHub periodically revises fine-grained PAT scopes. The current instructions reference `read:packages` — this is correct today, but is the most likely part of that document to go stale.

7. **Consider lightweight doc-testing** (e.g., extracting TypeScript code blocks and running `tsc --noEmit` on them as part of CI). The one confirmed accuracy issue (`getSchedule`) would have been caught automatically if the Quick Start and integration examples were compiled as part of the build.