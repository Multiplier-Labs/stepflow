# Daily Code Review: stepflow

**Date**: 2026-03-16T13:56:49.417Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 727ff6ca-c309-4d71-8a90-5be93bf40682
**Session**: 3b1a6ed8-57b9-4c58-a884-e5123b4c7cfa

---

Now let me do a deeper code review of the critical files.Now I have enough to compile a thorough review. Here is the daily automated code review:

---

# Daily Code Review — stepflow (`@multiplier-labs/stepflow`)

**Date:** 2026-03-16 | **Branch:** `main` | **Last commit:** `5ba18a2` (2026-02-28) | **Coverage:** ~93%

---

## CRITICAL

### 1. Canceling a queued (not-yet-started) run does not remove it from the in-memory queue
**`src/core/engine.ts:276-297, 408-432`**

When `startRun` cannot immediately execute (capacity full), it pushes to `this.runQueue`. If `cancelRun(runId)` is called on that run, it updates storage to `'canceled'` but leaves the run object in `this.runQueue`. When `processQueue()` eventually fires, it calls `executeRun()` → `executeWorkflow()` which immediately overwrites status back to `'running'` and proceeds to execute. The cancellation is silently ignored.

```ts
// cancelRun sets storage to 'canceled', but:
this.runQueue  // still contains the QueuedRun with this runId
```

**Fix:** In `cancelRun`, also remove the run from `this.runQueue` if it exists there.

---

### 2. `sleep()` leaks an abort listener when the timeout fires normally
**`src/utils/retry.ts:43-47`**

```ts
signal?.addEventListener('abort', () => {
  clearTimeout(timeoutId);
  reject(new Error('Aborted'));
});
// ← listener is NEVER removed
```

When `sleep()` resolves via the normal `setTimeout`, the abort listener is left permanently attached to the signal. In a long-running engine processing many retrying steps, every retry sleep adds a permanent listener. `orchestrator.ts` correctly cleans up in `executeWithTimeout` and `raceWithAbort` — `sleep()` should do the same.

---

### 3. `transaction()` in SQLite has a broken guard — silent data corruption
**`src/storage/sqlite.ts:444-447`**

```ts
promise.then(r => { result = r; }).catch(e => { error = e; });
if (error) throw error;
if (result === undefined && !promise) {   // ← !promise is ALWAYS false
  throw new Error('Transaction callback must use synchronous operations only');
}
return result as T;
```

`!promise` is always `false` because `promise` is a `Promise` object (always truthy). If the caller passes any genuinely async callback (e.g., one that does network I/O), `result` stays `undefined` and the function silently returns `undefined` instead of throwing. The safety guard is dead code.

---

### 4. Abort during retry sleep produces `'failed'` status instead of `'canceled'`
**`src/core/orchestrator.ts:431-445`, `src/utils/retry.ts:43-47`**

When a step is retrying and the workflow is aborted mid-sleep, `sleep()` rejects with `new Error('Aborted')` (a plain Error, not `WorkflowCanceledError`). This error bubbles out of the step's `catch` block (which can't catch it since it's already inside the catch) up to `executeWorkflow`'s outer catch. The outer catch sees a plain `Error`, not a `WorkflowCanceledError`, so:

```ts
const isCanceled = !isTimeout && actualError instanceof WorkflowCanceledError;
// → false, because it's a plain Error('Aborted')
const status = isCanceled ? 'canceled' : 'failed';
// → 'failed'  ← wrong
```

A canceled run during a retry sleep is persisted as `'failed'`.

---

## WARNING

### 5. `resumeRun` doesn't call `processQueue()` on completion
**`src/core/engine.ts:533-554`**

The `execute` closure in `resumeRun` deletes the active run from `activeRuns` in `finally`, but never calls `this.processQueue()`. Normal `executeRun` does (line 351). If `maxConcurrency` is set and resumed runs are holding slots, queued runs are never dequeued after a resumed run finishes.

---

### 6. `run.resumed` event is emitted twice on resume
**`src/core/engine.ts:524-529` and `src/core/orchestrator.ts:86-92`**

`resumeRun()` emits `run.resumed` before calling `executeWorkflow`. Then `executeWorkflow` emits it again when called with a checkpoint (`isResume = true`). Every subscriber sees two `run.resumed` events per resume.

---

### 7. `startedAt` is overwritten on resume, losing original start time
**`src/core/orchestrator.ts:81-84`**

```ts
await storage.updateRun(runId, {
  status: 'running',
  startedAt: new Date(),  // ← overwrites original startedAt
});
```

When a run is resumed after a crash, `startedAt` is reset to the resume timestamp. Downstream analytics that compute duration from `startedAt` will report incorrect values.

---

### 8. `StepTimeoutError` always has `stepKey = 'step'` (hardcoded)
**`src/core/orchestrator.ts:475`**

```ts
reject(new StepTimeoutError('step', timeoutMs));
```

`executeWithTimeout` doesn't receive the step key and substitutes the literal `'step'`. The `StepTimeoutError.stepKey` field, which is part of the public API, is always meaningless.

---

### 9. `cancelRun` overwrites terminal run statuses
**`src/core/engine.ts:420-424`**

If `cancelRun` is called on a run that already `'succeeded'` or `'failed'`, the method does not check for terminal status and will overwrite the final status to `'canceled'`. This corrupts historical run records.

---

### 10. `PostgresStorageAdapter.close()` may double-end the pool
**`src/storage/postgres.ts:274-279`**

```ts
await this.db.destroy();   // Kysely calls pool.end() internally via PostgresDialect
if (this.ownsPool) {
  await this.pool.end();   // ← pool.end() called a second time
}
```

Kysely's `destroy()` with a `PostgresDialect` terminates the underlying pool. The subsequent `pool.end()` call sends a second termination signal, which can throw or cause connection errors in `pg`.

---

### 11. `loadDependencies()` has a TOCTOU race on concurrent `initialize()` calls
**`src/storage/postgres.ts:18-19`**

```ts
async function loadDependencies(): Promise<void> {
  if (Kysely) return;  // ← not atomic
```

Two concurrent calls to `initialize()` can both see `Kysely` as `undefined` and both attempt the dynamic import. While typically benign (double-import), the module-level `let` variables are then written twice. The standard pattern is to store a single `loadingPromise` to deduplicate.

---

### 12. SQLite `tablePrefix` config option is silently ignored
**`src/storage/sqlite.ts:159, 183-260`**

`this.prefix = config.tablePrefix ?? 'workflow'` is assigned but the prefix is never interpolated into `CREATE_TABLES_SQL` or the prepared statement strings. All table names are always hardcoded (`workflow_runs`, `workflow_run_steps`, etc.). This is documented in the public API but does not work.

---

### 13. `getInterruptedRuns()` and `getLastCompletedStep()` prepare statements on every call
**`src/storage/sqlite.ts:500-522`**

```ts
async getInterruptedRuns(): Promise<WorkflowRunRecord[]> {
  const stmt = this.db.prepare(`SELECT ...`);  // ← prepared every call
```

These methods bypass the `this.stmts` cache. In high-frequency scenarios (e.g., a scheduler polling `getInterruptedRuns` in a loop), this creates unnecessary SQLite statement compilation overhead.

---

### 14. `emitEvent` swallows errors using `console.error` instead of the logger
**`src/core/orchestrator.ts:528-534`**

```ts
function emitEvent(events: EventTransport, event: WorkflowEvent): void {
  try {
    events.emit(event);
  } catch (error) {
    console.error('Failed to emit event:', error);  // ← bypasses configured logger
  }
}
```

`emitEvent` is a module-level function with no access to the logger. If a custom logger (e.g., structured JSON logger) is configured, event emission errors bypass it entirely and write to stdout/stderr directly.

---

## INFO

### 15. `maxConcurrency` JSDoc comment says "not yet implemented" — it is implemented
**`src/core/engine.ts:51`**

```ts
/** Maximum concurrent workflows (not yet implemented) */
maxConcurrency?: number;
```

The feature is fully implemented via `hasCapacity()` and `queueRun()`. The comment is stale and could mislead users into thinking the field has no effect.

---

### 16. `waitForRun` timeout throws a plain `Error` — breaks error hierarchy
**`src/core/engine.ts:471-473`**

```ts
throw new Error(`Timeout waiting for run ${runId}`);
```

All other engine errors subclass `WorkflowEngineError`. This one-off plain `Error` makes it harder for callers to distinguish poll timeouts from other errors with an `instanceof` check.

---

### 17. No integration test coverage for `PostgresStorageAdapter`
There are test suites for `MemoryStorageAdapter` and `SQLiteStorageAdapter`, but `PostgresStorageAdapter` has zero test coverage. This is the primary production storage backend and contains the most complex logic (schema migrations, `FOR UPDATE SKIP LOCKED`, connection sharing, lazy loading).

---

### 18. `dist/` is committed to the repository
Compiled artifacts are tracked in git. This causes noisy diffs on every build, inflates repository size, and can create merge conflicts. Libraries published to package registries typically use `.npmignore` to control what is published without committing `dist/`.

---

### 19. `publish.yml` has no explicit version pin for `actions/checkout` or `actions/setup-node`
**`.github/workflows/publish.yml`**

Using `@v4`/`@v3` tags (rather than pinned SHA digests) means the CI pipeline is susceptible to tag mutation. Pinning to commit SHAs is the hardened practice for supply-chain integrity.

---

## Summary Table

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | CRITICAL | `engine.ts:276-297, 408-432` | Canceling queued run doesn't remove from in-memory queue |
| 2 | CRITICAL | `retry.ts:43-47` | `sleep()` leaks abort listener |
| 3 | CRITICAL | `sqlite.ts:444-447` | `transaction()` broken guard — silent `undefined` return |
| 4 | CRITICAL | `orchestrator.ts:431-445` | Abort during retry sleep → `'failed'` instead of `'canceled'` |
| 5 | WARNING | `engine.ts:533-554` | `resumeRun` doesn't call `processQueue()` on finish |
| 6 | WARNING | `engine.ts:524` + `orchestrator.ts:86` | `run.resumed` event emitted twice |
| 7 | WARNING | `orchestrator.ts:81-84` | `startedAt` overwritten on resume |
| 8 | WARNING | `orchestrator.ts:475` | `StepTimeoutError` stepKey always `'step'` |
| 9 | WARNING | `engine.ts:420-424` | `cancelRun` overwrites terminal run statuses |
| 10 | WARNING | `postgres.ts:274-279` | Double pool termination on `close()` |
| 11 | WARNING | `postgres.ts:18-19` | TOCTOU race in `loadDependencies()` |
| 12 | WARNING | `sqlite.ts:159` | `tablePrefix` config silently ignored |
| 13 | WARNING | `sqlite.ts:500-522` | Statements re-prepared on every call |
| 14 | WARNING | `orchestrator.ts:528-534` | `emitEvent` errors bypass configured logger |
| 15 | INFO | `engine.ts:51` | Stale JSDoc comment on `maxConcurrency` |
| 16 | INFO | `engine.ts:471-473` | `waitForRun` timeout throws plain `Error` |
| 17 | INFO | — | No PostgreSQL integration tests |
| 18 | INFO | `dist/` | Compiled output committed to git |
| 19 | INFO | `publish.yml` | CI action tags not pinned to SHA |