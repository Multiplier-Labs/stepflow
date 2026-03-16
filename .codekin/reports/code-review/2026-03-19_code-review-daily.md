# Daily Code Review: stepflow

**Date**: 2026-03-19T10:28:32.847Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 5d0bf10e-05c6-45cf-94e2-b8e78e3bf1fd
**Session**: 0b9deafe-a31a-4e53-aa66-d7a78d57642c

---

Now I have enough to compile a thorough review. Let me write it up.

---

# Daily Code Review — 2026-03-19

**Project:** `@multiplier-labs/stepflow` v0.2.6  
**Commits reviewed:** 7 commits over last 7 days (b0b822c → b87ad34)  
**Recent focus:** Security hardening, test coverage (+33 tests), dependency upgrades, ReDoS protection (RE2), doc fixes.

---

## Critical

### 1. `delay` parameter silently dropped for queued runs
**`src/core/engine.ts:112-119, 279-298`**

`QueuedRun` does not store the `delay` field. When capacity is unavailable, a run is queued without its delay. When later dequeued, `executeRun` is called without any delay argument, so the caller's intent is silently ignored.

```typescript
// QueuedRun has no `delay` field
interface QueuedRun {
  runId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority: number;
  queuedAt: Date;
  // ❌ delay missing
}

// processQueue (line 392) never passes delay:
this.executeRun(next.runId, next.definition, next.input, next.metadata);
```

**Fix:** Add `delay?: number` to `QueuedRun` and thread it through `processQueue` → `executeRun`.

---

### 2. `SQLiteStorageAdapter.transaction()` always throws
**`src/storage/sqlite.ts:440-460`**

The deprecated `async transaction()` wrapper uses `.then()` to check `settled`, but Promise callbacks are always asynchronous (scheduled as microtasks). So `settled` is always `false` when checked synchronously inside `transactionSync`. This means `transaction()` unconditionally throws for every call, even with a correctly synchronous inner function. The error message suggests it's a usage error, but it's actually a library bug.

```typescript
promise.then(r => { result = r; settled = true; }); // runs async
if (!settled) {                                       // always true → always throws
  throw new Error('SQLiteStorageAdapter.transaction() does not support async operations...');
}
```

The method is `@deprecated`, but broken APIs should not silently misbehave. Either remove it entirely or make it truly no-op and always throw a clear deprecation error upfront.

---

## Warning

### 3. Duplicate cron schedule executions possible under slow persistence
**`src/scheduler/cron.ts:303-320`**

`checkSchedules()` fires every `pollInterval` (default 1s). `executeSchedule()` is async and includes a `persistence.updateSchedule()` call. If persistence is slow, `nextRunAt` may not be updated before the next poll fires, causing the same schedule to be triggered multiple times.

```typescript
private checkSchedules(): void {
  if (schedule.nextRunAt <= now) {
    this.executeSchedule(schedule).catch(...);  // async, not awaited
    this.updateNextRunTime(schedule);           // ✅ synchronous, but...
    // If updateNextRunTime fails (line 409), nextRunAt stays stale
  }
}
```

`updateNextRunTime` itself can fail silently (catch at line 409 sets `nextRunAt = undefined`), which stops the schedule entirely. More importantly, there's no "currently executing" guard — if a workflow run takes longer than `pollInterval`, duplicate runs won't be triggered (since `nextRunAt` is updated synchronously), but any exception in `updateNextRunTime` creates a permanent self-DOS for that schedule.

**Fix:** Add a per-schedule `executing: boolean` guard flag and ensure `nextRunAt` is set before yielding to the event loop.

### 4. `cancelRun` has a write-write race with the orchestrator
**`src/core/engine.ts:421-456`**

`cancelRun` writes `status: 'canceled'` to storage directly, then sends the abort signal. Concurrently, the orchestrator catches `WorkflowCanceledError` and also writes `status: 'canceled'` to storage (orchestrator.ts:263). Two concurrent writers to the same row is safe for SQLite (serialized) but fragile for PostgreSQL under concurrent transactions. More critically, if `afterRun` hook throws after the engine has already written `canceled`, the orchestrator's final `updateRun` is skipped, leaving the engine-written status.

The `run.canceled` event is emitted at line 454 in the engine, but the orchestrator also emits `run.canceled` via `eventType` at line 244 — subscribers will receive this event twice.

**Fix:** Let the orchestrator own the final status write. `cancelRun` should only abort the controller and optionally write `canceled` for runs that are queued (not yet active).

### 5. SSRF protection bypassable via DNS rebinding
**`src/events/webhook.ts:402-426`**

`validateWebhookUrl` checks the hostname at **registration time** only. A DNS rebinding attack can register a legitimate hostname (e.g. `evil.com`) that initially resolves to a public IP, pass validation, then switch DNS to `169.254.169.254` before the webhook fires. The protection is real but incomplete.

This is a known limitation of hostname-only SSRF checks, but it should be documented clearly as a known gap with a recommendation to deploy in a network environment that doesn't route to internal endpoints.

### 6. Unbounded webhook request queue
**`src/events/webhook.ts:136, 431-446`**

`requestQueue` is an unbounded array. Under high event throughput with slow or down endpoints, this queue grows indefinitely, consuming memory without backpressure. With retries (up to 3 by default) and exponential backoff, a single slow endpoint can accumulate thousands of queued requests.

**Fix:** Add a `maxQueueSize` config option and drop/log when exceeded.

### 7. `delete updates.id` mutates caller's object
**`src/scheduler/cron.ts:244`**

```typescript
async updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void> {
  delete updates.id;  // ❌ mutates the caller's object
```

The caller might reuse `updates` after this call and would silently find `.id` missing. Use destructuring instead: `const { id: _id, ...safeUpdates } = updates`.

---

## Info

### 8. `Math.random()` used for ID generation
**`src/utils/id.ts:17`**

`Math.random()` is not cryptographically secure. Run IDs are used in API-like operations (`cancelRun`, `waitForRun`, `subscribeToRun`). In environments where IDs are predictable, an attacker with partial knowledge could enumerate or guess valid run IDs. Use `crypto.randomUUID()` or `crypto.getRandomValues()` for the random portion.

### 9. Priority semantics diverge between planner and registry
**`src/planning/registry.ts:185-196` vs `src/planning/planner.ts:238-243`**

`getDefault()` falls back to the recipe with the **lowest numeric priority** (ascending), while `selectRecipe()` treats **higher numeric priority as better** (descending). The code comments acknowledge this, but it remains a latent foot-gun. A developer adding `priority: 5` to a recipe expecting it to be preferred as a default will get the opposite result.

**Fix:** Standardize to one convention (higher = more preferred) and remove the divergence, or document the asymmetry with a clear example in the type definition.

### 10. Retry defaults duplicated between orchestrator and retry.ts
**`src/core/orchestrator.ts:305-307`** vs **`src/utils/retry.ts:26-30`**

```typescript
// orchestrator.ts — hardcoded
const maxRetries = step.maxRetries ?? 3;
const retryDelay = step.retryDelay ?? 1000;
const retryBackoff = step.retryBackoff ?? 2;

// retry.ts — defined constant
export const DEFAULT_RETRY_OPTIONS = { maxRetries: 3, delay: 1000, backoff: 2 };
```

These currently agree, but a change to `DEFAULT_RETRY_OPTIONS` won't affect the orchestrator's step retry behavior, creating silent divergence.

### 11. Orphaned JSDoc block before `QueuedRun` interface
**`src/core/engine.ts:83-119`**

The class-level JSDoc at lines 83–108 describes `WorkflowEngine`, but it's separated from the `class WorkflowEngine` declaration at line 121 by the `QueuedRun` interface at lines 112–119. TypeScript/IDE tooling will likely attribute this JSDoc to `QueuedRun`, leaving `WorkflowEngine` without its documentation.

**Fix:** Move `QueuedRun` above the class JSDoc, or move the JSDoc to immediately precede `export class WorkflowEngine`.

### 12. `dist/` committed to git
The `dist/` directory (compiled output) is committed and updated regularly (24 files in one commit, 22 in another). For a published npm package, dist should either be generated in CI/CD and excluded from git, or kept but only updated on release tags. Committing it on every doc/code fix creates noisy diffs and merge conflicts.

---

## Summary Table

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | Critical | `engine.ts:112` | `delay` lost for queued runs |
| 2 | Critical | `sqlite.ts:440` | `transaction()` always throws (broken deprecated API) |
| 3 | Warning | `cron.ts:303` | Duplicate schedule fires on slow persistence/cron failure |
| 4 | Warning | `engine.ts:421` | Double-write race + duplicate events in `cancelRun` |
| 5 | Warning | `webhook.ts:402` | SSRF protection incomplete (DNS rebinding gap) |
| 6 | Warning | `webhook.ts:136` | Unbounded request queue under backpressure |
| 7 | Warning | `cron.ts:244` | `delete updates.id` mutates caller's object |
| 8 | Info | `id.ts:17` | Non-CSPRNG ID generation |
| 9 | Info | `registry.ts:185` | Priority semantics inconsistency (planner vs registry) |
| 10 | Info | `orchestrator.ts:305` | Retry defaults duplicated, not referencing `DEFAULT_RETRY_OPTIONS` |
| 11 | Info | `engine.ts:83` | Orphaned JSDoc on `WorkflowEngine` class |
| 12 | Info | `dist/` | Built artifacts committed to git |

---

**Overall assessment:** The codebase is well-structured with good TypeScript hygiene, solid error hierarchy, and appropriate security additions (RE2 ReDoS protection, SSRF checks, HMAC signing). The most actionable fixes are #1 (delay loss), #2 (broken deprecated API), and #7 (mutation bug). The scheduler concurrency issue (#3) should be addressed before any high-frequency production deployment.