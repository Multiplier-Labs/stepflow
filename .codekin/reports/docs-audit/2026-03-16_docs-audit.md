# Documentation Audit: stepflow

**Date**: 2026-03-16T14:56:55.544Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: a6fba482-1adb-4bd6-b81d-e8bd80c0577c
**Session**: 85645684-d7f5-4afa-804e-ddc00847027e

---

Now I have all the data needed. Here is the complete documentation audit report:

---

# Stepflow Documentation Audit Report
*Generated: 2026-03-16*

## Summary

The stepflow repository contains **3 active documentation files** totalling **2,224 lines**. The docs cover installation, quick start, API reference, and publishing setup. Overall health is **Needs Cleanup** — the API reference is thorough and well-structured, but both `README.md` and `stepflow-api-reference.md` carry a pervasive package-name error affecting every import example, and the README's API reference section documents a constructor signature and a method that do not exist in source code.

| Metric | Value |
|---|---|
| Total doc files | 3 |
| Files with accuracy issues | 2 (`README.md`, `stepflow-api-reference.md`) |
| Files that are current and accurate | 1 (`docs/github-packages-setup.md`) |
| Broken API examples | 3 (wrong install, wrong constructor, phantom `getDb()`) |
| Import errors (wrong package name) | 29 total across two files |
| Recently deleted files | 1 (`docs/stepflow-postgresql-spec.md`, commit `df2d237`) |

**Health rating: Needs Cleanup**

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 467 | 2026-02-24 | Project overview, quick start, feature guide, and abridged API reference | **stale** |
| `docs/stepflow-api-reference.md` | 1660 | 2026-02-28 | Comprehensive API reference for all components | **stale** |
| `docs/github-packages-setup.md` | 97 | 2026-01-25 | Publishing to and installing from GitHub Packages | **current** |

---

## Staleness Findings

### 1. `README.md` — Wrong package name throughout (lines 18, 24, 194, 204, 216, 246, 263, 285, 312)

The package name in `package.json` is `@multiplier-labs/stepflow`, published exclusively to GitHub Packages. The README's install command and all eight import examples use the bare `stepflow` name:

```
npm install stepflow                              ← line 18 (WRONG)
import { WorkflowEngine, … } from 'stepflow';    ← lines 24, 194, 204, 216, 246, 263, 285, 312 (WRONG)
```

The correct install command (`npm install @multiplier-labs/stepflow`) appears only in `docs/github-packages-setup.md` and once in `docs/stepflow-api-reference.md`. A user following only the README cannot install or import the package.

### 2. `README.md` — `SQLiteStorageAdapter` quick-start example uses non-existent `filename` option (line 28)

The quick-start code block shows:

```typescript
new SQLiteStorageAdapter({ filename: './workflows.db' })
```

`SQLiteStorageConfig` (in `src/storage/sqlite.ts:91`) has no `filename` field. The required field is `db: Database.Database`. This example would throw a runtime error because `db` is required and the adapter calls `config.db.pragma(...)` immediately.

### 3. `README.md` — `SQLiteStorageAdapter` API reference documents phantom `getDb()` method (lines 442–444)

The README documents:

```typescript
class SQLiteStorageAdapter implements StorageAdapter {
  constructor(config: { filename?: string; db?: Database });
  getDb(): Database;
}
```

Three problems:
- `filename` does not exist in `SQLiteStorageConfig`
- `db` is **required**, not optional  
- `getDb()` is not implemented in the source; `this.db` is `private` with no accessor

The scheduling example on line 314 depends on `getDb()`:

```typescript
const schedulePersistence = new SQLiteSchedulePersistence({ db: storage.getDb() });
```

This call would fail at runtime. `autoCreateTables?: boolean` (a real option) is also absent from the documented signature.

### 4. `docs/stepflow-api-reference.md` — All 21 import examples use wrong package name (lines 65, 115, 384, 395, 416, 463, 537, 548, 757, 771, 800, 1146, 1184, 1246, 1301, 1311, 1334, 1410, 1428, and more)

Despite having the correct `npm install @multiplier-labs/stepflow` on line 43, every code example in the document uses `from 'stepflow'`. This is inconsistent and will break any copy-pasted code.

### 5. `docs/stepflow-api-reference.md` — `tablePrefix` documented as active option, but deprecated in source (line 778)

The API reference shows:

```typescript
tablePrefix: 'workflow',   // default: 'workflow'
```

The source code marks this field as `@deprecated` with the note *"This option is not currently supported and will be ignored."* Users who set this option expecting custom table prefixes will get silent misbehavior.

### 6. `README.md` — Planning system absent

The planning system (`RuleBasedPlanner`, `MemoryRecipeRegistry`, `MemoryStepHandlerRegistry`, `createRegistry`) is fully implemented and exported from `src/index.ts`, and fully documented in the API reference (lines 1085–1231). It does not appear anywhere in `README.md`. New users reading the README have no indication this system exists.

---

## Accuracy Issues

### Issue A — `README.md` quick start: `SQLiteStorageAdapter` call will fail

`new SQLiteStorageAdapter({ filename: './workflows.db' })` (line 28) has no `filename` option; `db` is required. The correct first-time setup requires importing `better-sqlite3` and instantiating `Database` separately:

```typescript
import Database from 'better-sqlite3';
import { WorkflowEngine, SQLiteStorageAdapter } from '@multiplier-labs/stepflow';

const db = new Database('./workflows.db');
const engine = new WorkflowEngine({
  storage: new SQLiteStorageAdapter({ db }),
});
```

### Issue B — `README.md` scheduling example: `storage.getDb()` does not exist (line 314)

`SQLiteStorageAdapter` has no `getDb()` public method. The scheduling example must be rewritten to create and pass the `Database` instance directly:

```typescript
import Database from 'better-sqlite3';
const db = new Database('./workflows.db');
const storage = new SQLiteStorageAdapter({ db });
const schedulePersistence = new SQLiteSchedulePersistence({ db });
```

### Issue C — `README.md` API reference: `SQLiteStorageAdapter` constructor signature wrong

Documents `{ filename?: string; db?: Database }`. Actual `SQLiteStorageConfig` is:
- `db: Database.Database` — **required**
- `autoCreateTables?: boolean` — optional, default `true`
- `tablePrefix?: string` — **deprecated**, ignored

### Issue D — `docs/stepflow-api-reference.md`: `tablePrefix` not flagged as deprecated (line 778)

The API reference documents `tablePrefix` as a live configuration option with an example. The source code marks it `@deprecated` and explicitly states it is ignored. The docs should reflect the deprecation.

---

## Overlap & Redundancy

### Group 1: Installation instructions

Three files each document how to install `@multiplier-labs/stepflow`:

| File | Section | Coverage |
|---|---|---|
| `README.md` | "Installation" (line 15) | `npm install stepflow` — **wrong** |
| `docs/stepflow-api-reference.md` | "Installation" (line 40) | Correct command + peer deps |
| `docs/github-packages-setup.md` | "Step 3: Install the package" (line 63) | Correct command + auth setup |

**Recommendation:** The API reference's installation section is the most complete. The README should link to `docs/github-packages-setup.md` for full auth setup rather than duplicating instructions. No file should be deleted, but the README's installation section needs updating.

### Group 2: Quick start examples

Both `README.md` (line 22) and `docs/stepflow-api-reference.md` (line 62) contain a "Quick Start" section with full code examples. The API reference version is more accurate (uses `MemoryStorageAdapter` avoiding the SQLite constructor issue). The README version has broken code.

**Recommendation:** README quick start should be updated to accurate code; it serves a different audience (first-time visitors) than the comprehensive API reference.

### Group 3: `WorkflowEngine` API surface

`README.md` (lines 370–408) contains an abbreviated `WorkflowEngine` class listing that duplicates a portion of `docs/stepflow-api-reference.md` (lines 108–260). The API reference is authoritative and more complete.

**Recommendation:** The README's "API Reference" section (lines 368–463) could be replaced with a link to `docs/stepflow-api-reference.md` to eliminate duplication and reduce the surface area that must stay in sync.

---

## Fragmentation

### 1. README vs. API Reference split creates maintenance burden

The README contains an embedded "API Reference" section (lines 368–463) that partially duplicates `docs/stepflow-api-reference.md`. Every API change must be reflected in two places. With only 3 doc files in the project, this split is unjustified. The README should serve as a "getting started" document only; all API details should live solely in `docs/stepflow-api-reference.md`.

### 2. Deleted spec file left no migration trail

`docs/stepflow-postgresql-spec.md` (428 lines) was deleted in commit `df2d237`. Its content was partially absorbed into the API reference. However, migration guidance for users upgrading from v0.2.5 (schema changes, renamed columns) is no longer available in any doc. This creates a gap for existing users upgrading.

### 3. Planning system documentation fragmentation

The planning system is fully documented in `docs/stepflow-api-reference.md` (lines 1085–1231) but entirely absent from `README.md`. Users who only read the README will not discover this capability.

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|---|---|
| *(none)* | All three remaining files serve distinct purposes. No file is fully superseded. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| `README.md` lines 368–463 ("API Reference" section) | Remove from `README.md`; add a link to `docs/stepflow-api-reference.md` | **Drop** the duplicate class/interface listings from README. The API reference is authoritative. |
| `README.md` "Installation" section | Merge with `docs/github-packages-setup.md` link | **Keep** one-liner install; **replace** verbose duplication with a pointer to the setup doc. |

### Update

| File | Section Needing Update | What Changed in Code |
|---|---|---|
| `README.md` | Line 18: `npm install stepflow` | Package name is `@multiplier-labs/stepflow`; must configure `.npmrc` first (see `github-packages-setup.md`) |
| `README.md` | Lines 24, 194, 204, 216, 246, 263, 285, 312: `from 'stepflow'` | All imports must use `from '@multiplier-labs/stepflow'` |
| `README.md` | Line 28: `new SQLiteStorageAdapter({ filename: './workflows.db' })` | No `filename` option; `db: Database` is required; must import and instantiate `better-sqlite3` separately |
| `README.md` | Line 314: `storage.getDb()` | Method does not exist; pass `db` instance directly to both adapter and persistence |
| `README.md` | Lines 441–444: `SQLiteStorageAdapter` constructor + `getDb()` | Constructor signature wrong (`filename` absent, `db` required, `autoCreateTables` missing); `getDb()` not implemented |
| `README.md` | Entire file: Planning system not mentioned | `RuleBasedPlanner`, `MemoryRecipeRegistry`, `MemoryStepHandlerRegistry` shipped and exported; add at minimum a mention and link |
| `docs/stepflow-api-reference.md` | Lines 65, 115, 384, 395, 416, 463, 537, 548, 757, 771, 800, 1146, 1184, 1246, 1301, 1311, 1334, 1410, 1428 (21 occurrences): `from 'stepflow'` | All must be `from '@multiplier-labs/stepflow'` |
| `docs/stepflow-api-reference.md` | Line 778: `tablePrefix: 'workflow'` | Mark as `@deprecated`; note it is silently ignored in current implementation |

---

## Recommendations

1. **Fix the package name everywhere (highest impact).** Replace all 29 occurrences of `from 'stepflow'` across `README.md` and `docs/stepflow-api-reference.md`, and fix `npm install stepflow` in the README. This is a copy-paste trap that silently breaks any user following the docs.

2. **Fix the `SQLiteStorageAdapter` examples in `README.md`.** The quick start (line 28) and the API reference section (lines 441–444, 314) contain non-functional code. Correct the constructor signature (`db` required, no `filename`) and remove `getDb()` from both the signature and the scheduling example.

3. **Remove the duplicated API reference section from `README.md` (lines 368–463).** Replace it with a single-line link to `docs/stepflow-api-reference.md`. This eliminates the sync burden that allowed the current stale content to accumulate, and keeps the README focused on orientation.

4. **Mark `tablePrefix` as deprecated in `docs/stepflow-api-reference.md`.** The source already documents it as `@deprecated` and ignored. The API reference should match, so users do not waste time configuring an option with no effect.

5. **Add a planning system entry to `README.md`.** At minimum, add a bullet in the Features list and a brief section (or link) covering `RuleBasedPlanner`. The planning system is production-ready and exported, but is invisible to any user who reads only the README.

6. **Add a v0.2.5 → v0.2.6 migration note** (or link to a git tag/release) somewhere accessible. The deleted `stepflow-postgresql-spec.md` contained schema migration details that are no longer reachable through docs. A short "Upgrading" section in `README.md` or a GitHub Release note would cover this gap.

7. **Standardise installation instructions to a single source of truth.** `docs/github-packages-setup.md` is the most complete and correct. The README and API reference should point to it rather than reproducing partial (and in the README's case, incorrect) install steps.

8. **Add a CHANGELOG or link to GitHub Releases.** Neither `README.md` nor `docs/stepflow-api-reference.md` reference a version history. Given that the project is on v0.2.6 with meaningful breaking changes between minor versions, users need a way to see what changed.

9. **Audit the API reference `transactionSync` and `getStats` examples** against any future refactors. These methods currently exist in `SQLiteStorageAdapter` but are not part of the `StorageAdapter` interface. Documenting them as part of the adapter's public API is fine, but should be clearly labelled as SQLite-specific.

10. **Consider adding a brief troubleshooting/FAQ section to `README.md`** covering the two most common setup pitfalls now documented in code: (a) GitHub Packages auth required before install, and (b) `better-sqlite3` / `pg`+`kysely` must be installed separately as peer dependencies.