# Daily Code Review: stepflow

**Date**: 2026-04-27T09:46:41.343Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: d27ad000-f710-45c0-8fa4-c1c0491cbb98
**Session**: 74908eed-b5ef-416f-a3bc-810bcac90a2a

---

Now let me do a deep dive into the critical source files.Now let me check the CI/CD configuration and look at test coverage.Now I have enough to write the full review. Let me save this analysis and produce the report.---

## Daily Code Review — 2026-04-27

**No new commits** since 2026-04-14 (the codebase is stable after PR #36). This review covers the full codebase with focus on the files most recently changed.

---

## CRITICAL

### C1 — `src/storage/postgres.ts:349–351` — Schema migration swallows all errors

```typescript
.execute(this.db).catch(() => {
  // Ignore if columns already exist or syntax not supported
});
```

Every error (permissions, syntax, connectivity) is silently discarded. Only PostgreSQL error code `42701` ("column already exists") should be ignored. A misconfigured schema appears to initialize successfully while the column never gets created.

**Fix:** Check `err.code === '42701'` before ignoring; rethrow all others.

---

### C2 — `src/storage/postgres.ts:1236` — Pagination `total` is wrong inside transactions

```typescript
total: rows.length, // BUG: should be full count, not page length
```

`PostgresTransactionAdapter.listRuns()` returns the current page size as `total`. Any paginating caller inside a transaction receives wrong data and may terminate early or loop infinitely.

**Fix:** Issue a `COUNT(*)` with the same filters before returning the paginated result.

---

### C3 — `src/core/engine.ts:382–402` — Unhandled rejections in `processQueue` can crash the engine

`processQueue` calls `executeRun` with no top-level try/catch. A rejection escapes to the event loop and can take down the process.

**Fix:** Wrap the `executeRun` invocation in `processQueue` with a `.catch` that logs and continues.

---

## WARNING

| # | File | Lines | Issue |
|---|------|-------|-------|
| W1 | `engine.ts` | 483–543 | `waitForRun` subscribes to events after the call site — terminal events can be missed in the gap, causing indefinite hang |
| W2 | `engine.ts` | 370–376 | `timerHandles` Set grows forever; handles are added but never removed after firing |
| W3 | `engine.ts` | 307–320 | Priority queue uses `Array.splice()` — O(n) per insertion, O(n²) for batch arrivals |
| W4 | `engine.ts` | 578–580 | TOCTOU race: two concurrent `resumeRun` calls can both pass the active-run check and double-launch |
| W5 | `orchestrator.ts` | 515 | `clearTimeout(timeoutId)` called in abort handler before `timeoutId` is assigned |
| W6 | `orchestrator.ts` | 134, 352 | `beforeRun`/`beforeStep` hooks have no try/catch; `afterRun` does — inconsistent and a crash risk |
| W7 | `orchestrator.ts` | 261–267 | All hooks awaited with no timeout — a hung hook stalls the workflow forever |
| W8 | `cron.ts` | 268 | `Object.assign(schedule, updates)` mutates in-memory state before `await persistence.updateSchedule()` — diverges on failure |
| W9 | `webhook.ts` | 372 | `retryDelay * Math.pow(2, attempt)` has no upper bound — at attempt 10 with 1s base delay this is ~17 minutes |
| W10 | `engine.ts` | 248–254 | No size limit on user-supplied `input`/`metadata` payloads |

---

## INFO

| # | File | Lines | Issue |
|---|------|-------|-------|
| I1 | `retry.ts` | 39, 58 | `new WorkflowCanceledError('run')` — literal `'run'` used instead of the actual run ID |
| I2 | `postgres.ts` | 602 | `COUNT(*)` result implicitly coerced from string with `Number()`; silent `0` on null result |
| I3 | `sqlite.ts` | 482–487 | Explicit child-table deletes before CASCADE — redundant and adds lock contention |
| I4 | `sqlite.ts` | 516–526 | `console.warn` in `safeJsonParse` bypasses the structured logger |
| I5 | `engine.test.ts` | 871–873 | Test passes `pollInterval` option that `waitForRun` doesn't accept (silently ignored) |
| I6 | `ci.yml` | — | PostgreSQL adapter (1,409 lines) is never exercised in CI — C2 would not be caught |
| I7 | `types.ts` | 50–51, 73 | `WorkflowRunRecord.error` and `WorkflowRunStepRecord.error` use different types for the same concept |

---

## Prioritized Action Plan

1. **Before next release:** Fix C1, C2, C3 — data corruption and process crash risks.
2. **Short-term:** W1, W4, W6, W7, W8 — correctness under concurrent load.
3. **Medium-term:** W2, W3, W9, W10 — memory, performance, and safety hardening.
4. **Housekeeping:** I1–I7 — code hygiene and adding a PostgreSQL CI job.

Report saved to `.codekin/reports/code-review/2026-04-27_code-review-daily.md`.