# Daily Code Review: stepflow

**Date**: 2026-03-23T02:33:51.644Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: ec283f95-51d4-44f8-843d-73b68376be6a
**Session**: 75ff6ea4-1035-4675-83f3-a3197b25c968

---

All 331 tests pass. Here is the full review:

---

## Daily Code Review — 2026-03-23

**Project:** `@multiplier-labs/stepflow` v0.2.6  
**Commits reviewed:** 22 commits (last 7 days) — heavy bug-fix week covering abort/cancel status, security (SSRF, ReDoS), documentation, and dependency upgrades.

---

### CRITICAL

#### 1. SSRF bypass via IPv6 loopback — `src/events/webhook.ts:489`

`isBlockedHost` checks `hostname === '::1'` but `new URL('http://[::1]/').hostname` returns `'[::1]'` (with brackets) in Node.js — **confirmed via runtime test**. A webhook URL of `http://[::1]/` passes both `validateWebhookUrl` and `validateResolvedHost`.

```
hostname: [::1]  blocked: false   ← confirmed bypass
```

Fix: add `hostname === '[::1]'` (and similarly `hostname.startsWith('[') && hostname.endsWith(']')` for general IPv6 address-literal detection) to `isBlockedHost`.

#### 2. SQL injection in schedule table name — `src/scheduler/sqlite-persistence.ts:83–113`

`this.tableName` (user-supplied via `SQLiteSchedulePersistenceConfig.tableName`) is interpolated directly into DDL strings and prepared statement strings with no validation or quoting:

```typescript
this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.tableName} ...`);
this.db.prepare(`INSERT INTO ${this.tableName} ...`);
```

A caller passing `tableName: "x; DROP TABLE workflow_runs; --"` can execute arbitrary SQL. Fix: either restrict `tableName` to `/^[a-zA-Z_][a-zA-Z0-9_]*$/` or use proper SQLite identifier quoting (`"${name}"`).

---

### WARNING

#### 3. Workflow timeout status inconsistency across adapters — `src/core/orchestrator.ts:242`, `src/core/engine.ts:468`

The orchestrator always maps timeout to `status: 'failed'`:
```typescript
const status = isCanceled ? 'canceled' : 'failed';  // timeout goes here
```
But `TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled', 'timeout']` includes `'timeout'`, and the PostgreSQL adapter has a dedicated `'timeout'` status (postgres.ts:970). Users querying by status cannot distinguish a timeout from a regular failure on SQLite. `RunStatus` in `core/types.ts` doesn't include `'timeout'` at all, making `TERMINAL_STATUSES` contain a value that can never appear on `WorkflowRunRecord.status` from the SQLite path.

#### 4. `includeSteps` planning hint silently ignored — `src/planning/planner.ts:290`

```typescript
const { skipSteps, includeSteps, additionalConfig } = context.hints;
//                 ^^^^^^^^^^^^ destructured but never referenced again
```
`planning/types.ts:338` documents `includeSteps?: string[]` as a valid hint. Callers expecting it to filter the plan steps will see silently wrong behavior. Either implement it or remove the type definition.

#### 5. `withRetry` throws generic `Error` on abort — `src/utils/retry.ts:84`

```typescript
if (opts.signal?.aborted) {
  throw new Error('Aborted');   // ← should be WorkflowCanceledError
}
```
All other abort paths throw `WorkflowCanceledError`. This makes `instanceof WorkflowCanceledError` checks unreliable for callers of `withRetry`, and the abort will propagate as a generic error through error-handling hooks.

#### 6. Unbounded webhook request queue — `src/events/webhook.ts:465–480`

`requestQueue: Array<() => void>` has no maximum size. Under sustained event bursts with a slow/unreachable webhook endpoint, every event queued while `maxConcurrentRequests` is saturated is pushed to this array, with no eviction or back-pressure. Long-running deployments with misconfigured endpoints can accumulate large memory footprints silently.

#### 7. `cancelRun` storage update races with orchestrator — `src/core/engine.ts:444–449`

`cancelRun` calls `controller.abort()` then immediately calls `storage.updateRun(runId, { status: 'canceled' })`. The orchestrator's catch block will *also* call `updateRun` (with the same or a different terminal status) moments later. If the orchestrator writes after `cancelRun`'s update, the run could end up re-stamped with `'failed'` or another status. There is no locking or check that the orchestrator's write is authoritative. This is a narrow race window but real in async Node.js code.

---

### INFO

#### 8. `getStats()` creates uncached prepared statements — `src/storage/sqlite.ts:570–572`

```typescript
getStats(): { runs: number; steps: number; events: number } {
  const runsCount = this.db.prepare('SELECT COUNT(*)...').get() as ...;
  // repeated for steps and events
```
Three `db.prepare()` calls on every invocation. These should be added to the `this.stmts` cache initialized in `prepareStatements()`.

#### 9. Stack traces stored in error records — `src/utils/errors.ts:27, 43`

`WorkflowEngineError.toRecord()` and `fromError()` both store `error.stack` in `WorkflowError`. These records are persisted to the database and emitted in events (including `run.failed` webhook payloads). Stack traces often contain internal file paths and are an information-leak risk if event payloads are forwarded to external systems.

#### 10. Deprecated `transaction()` still exported — `src/storage/sqlite.ts:440`

The async `transaction()` wrapper is marked `@deprecated` but remains in the public API. It silently breaks for callbacks that contain real async I/O, giving no runtime error — only a stale Promise. Removal (or a hard `throw`) would be safer than a JSDoc warning.

#### 11. No test coverage for PostgreSQL adapter

`src/storage/sqlite.test.ts` has 37 tests; the PostgreSQL adapter (`src/storage/postgres.ts`) has no test file. The adapter has unique behavior (`'timeout'` status, `output_json` column, `priority` column) that diverges from the SQLite path and is currently entirely untested.

---

### Summary Table

| # | Severity | File | Line | Issue |
|---|----------|------|------|-------|
| 1 | Critical | `events/webhook.ts` | 489 | IPv6 `[::1]` bypasses SSRF block |
| 2 | Critical | `scheduler/sqlite-persistence.ts` | 83–113 | SQL injection via `tableName` |
| 3 | Warning | `core/orchestrator.ts`, `engine.ts` | 242, 468 | Timeout status inconsistency SQLite vs Postgres |
| 4 | Warning | `planning/planner.ts` | 290 | `includeSteps` hint ignored |
| 5 | Warning | `utils/retry.ts` | 84 | Abort throws generic `Error` not `WorkflowCanceledError` |
| 6 | Warning | `events/webhook.ts` | 465 | Unbounded webhook request queue |
| 7 | Warning | `core/engine.ts` | 444 | `cancelRun` races with orchestrator storage update |
| 8 | Info | `storage/sqlite.ts` | 570 | `getStats()` does not use cached statements |
| 9 | Info | `utils/errors.ts` | 27, 43 | Stack traces stored in DB / webhook payloads |
| 10 | Info | `storage/sqlite.ts` | 440 | Deprecated `transaction()` still exported |
| 11 | Info | `storage/postgres.ts` | — | No unit tests for Postgres adapter |

The highest-priority fixes are **#1** (confirmed SSRF bypass, exploitable with a single crafted URL) and **#2** (SQL injection via table name). Both are security issues that can be introduced accidentally by a user misconfiguring the library.