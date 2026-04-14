# Documentation Audit: stepflow

**Date**: 2026-04-13T01:17:34.517Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 54339665-09b6-4e19-8981-c8fc3144a296
**Session**: 386a6c34-ce83-4c68-a8e7-e668435ced26

---

Now I'll produce the final structured report based on the audit findings.

## Summary

**Total documentation files:** 3 (2,167 lines total)
**Files needing attention:** 1 (minor — one missing error class entry)
**Health rating:** Well-maintained

The repository has a lean, focused documentation set: one root README, one GitHub Packages setup guide, and one comprehensive API reference. All three files share the same last-modified date (2026-04-11, the initial commit), so there is no divergence between doc age and code age. Code examples, configuration keys, export paths, and API signatures were cross-checked against the source and are accurate. The only finding is a single missing entry in the error-class table.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|--------------|---------|--------|
| `README.md` | 408 | 2026-04-11 | Project overview, quick-start, install, basic usage examples | Current |
| `docs/github-packages-setup.md` | 97 | 2026-04-11 | Instructions for authenticating with and publishing to GitHub Packages NPM registry | Current |
| `docs/stepflow-api-reference.md` | 1,662 | 2026-04-11 | Complete API reference: WorkflowEngine, storage adapters, event transports, scheduler, planner, error types, TypeScript types | Current (1 omission) |

---

## Staleness Findings

No staleness issues detected. All three documentation files were committed in the initial commit (2026-04-11) alongside the source code they describe. There is only one commit in the repository (`bd16961 Initial commit`), so no code has changed after the docs were written.

No broken internal links were found:
- `README.md` references `docs/github-packages-setup.md` — file exists.
- `README.md` references `docs/stepflow-api-reference.md` — file exists.
- All markdown anchor links (`#error-classes`, `#workflow-engine`, etc.) resolve to sections present in their respective files.

---

## Accuracy Issues

**Issue 1 — Missing error class in API Reference**

`WaitForRunTimeoutError` is exported from `src/index.ts` and implemented in `src/utils/errors.ts`, but it does not appear in the error-class table in `docs/stepflow-api-reference.md` (the table covers eight error types; this is the ninth).

- **Exported symbol:** `WaitForRunTimeoutError` with code `WAIT_FOR_RUN_TIMEOUT`, constructor signature `(runId, timeoutMs)`.
- **Where it is thrown:** `WorkflowEngine.waitForRun()` when the timeout elapses before the run completes.
- **Impact:** Users who encounter this error and search the API reference will not find it documented.

**Issue 2 — Storage adapter naming ambiguity (very minor)**

The TypeScript types section mentions both `StorageAdapter` and `WorkflowStorage` interfaces without explaining that `WorkflowStorage` is the extended/current interface while `StorageAdapter` is the narrower legacy surface. This distinction is inferable from the source but is not stated in the docs.

No issues were found with:
- Install / setup instructions (match `package.json` scripts and peer deps).
- Subpath export paths (`/storage`, `/events`, `/scheduler`) — all match `package.json` `exports` field.
- Code examples for `WorkflowEngine`, storage adapters, event transports, scheduler, and planner.
- All nine documented config keys for `WorkflowEngineConfig`, `PostgresStorageConfig`, and `SQLiteStorageConfig`.

---

## Overlap & Redundancy

No meaningful overlap exists across the three files. Each file occupies a distinct niche:

- `README.md` — orientation and quick-start; deliberately high-level.
- `docs/github-packages-setup.md` — operational runbook for package publishing; not replicated elsewhere.
- `docs/stepflow-api-reference.md` — exhaustive API detail; README does not duplicate it.

The README links to the API reference rather than reproducing its content, which is the correct pattern.

**No merge or deletion actions are warranted on overlap grounds.**

---

## Fragmentation

No fragmentation detected. The documentation set is already consolidated: three files covering three distinct concerns. There are no orphaned spec documents, proposal files, or feature-design docs in the repository. The `docs/` directory contains exactly two files, both purposeful and non-overlapping.

No "plan" or "proposal" documents describing completed work were found.

---

## Action Items

### Delete

| File | Reason |
|------|--------|
| *(none)* | No files are outdated, superseded, or describe completed proposals with no reference value. |

### Consolidate

| Source Files | Target File | Notes |
|-------------|-------------|-------|
| *(none)* | — | No consolidation needed; the current three-file structure is appropriate. |

### Update

| File | Section Needing Update | What Changed |
|------|----------------------|--------------|
| `docs/stepflow-api-reference.md` | Error Classes table | Add missing `WaitForRunTimeoutError` entry: code `WAIT_FOR_RUN_TIMEOUT`, constructor `(runId, timeoutMs)`, thrown by `waitForRun()` on timeout. |
| `docs/stepflow-api-reference.md` | TypeScript Types Reference | Add a one-sentence note clarifying that `WorkflowStorage` is the current extended interface and `StorageAdapter` is the narrower legacy one, so users know which to implement. |

---

## Recommendations

1. **Add `WaitForRunTimeoutError` to the error-class table** in `docs/stepflow-api-reference.md`. It is exported, thrown at a documented public API boundary (`waitForRun`), and its absence is the only real gap in API coverage.

2. **Clarify `StorageAdapter` vs `WorkflowStorage`** in the TypeScript types section — a single sentence noting which is the current recommended interface and which is the narrower legacy surface will prevent confusion for implementors.

3. **Add a `CHANGELOG.md` or version-history section** to `README.md` as the project evolves past v0.2.6. The current single-commit history makes this unnecessary now, but without it, future contributors will have no changelog to update when they introduce breaking changes.

4. **Protect documentation accuracy through CI.** Because the repository has no docs-linting step, future code changes could silently invalidate examples. Consider adding a `docs:check` script (e.g., `markdownlint`, `markdown-link-check`) to the GitHub Actions workflow so broken links and formatting regressions are caught automatically.

5. **Keep the three-file structure.** The current organisation (`README.md` + `docs/github-packages-setup.md` + `docs/stepflow-api-reference.md`) is clean and proportional to the codebase size. Resist splitting the API reference into per-module files until the reference exceeds ~3,000 lines or the docs audience clearly segments by module.