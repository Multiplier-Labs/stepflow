# Daily Code Review: stepflow

**Date**: 2026-04-13T01:32:56.537Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 12fb929b-3da3-4e1b-a8fc-e9b497a0eb42
**Session**: c3af596a-a1f0-43c3-922e-8ed0cd0562f0

---

---

## Daily Code Review — 2026-04-13

**Project:** `@multiplier-labs/stepflow` — TypeScript workflow orchestration library
**Coverage:** 93.88% | **Recent changes:** Initial commit only (no incremental changes in 7 days)

---

### CRITICAL (4)

**C1 — Unhandled `JSON.parse()` in all storage adapters**
`src/storage/sqlite.ts`, `src/storage/postgres.ts`, `src/scheduler/*-persistence.ts`
Every row deserialization call is bare `JSON.parse()`. Corrupted DB rows will throw unhandled `SyntaxError` and crash the process. Wrap all calls in try-catch with safe fallbacks.

**C2 — DNS lookup blocks event loop on every webhook send**
`src/events/webhook.ts` ~line 417
`validateResolvedHost()` calls `dns.lookup()` with no timeout, no caching. A stalling DNS resolver can hang the entire event loop for 30+ seconds. Add a per-call timeout (via `AbortController`) and a short-TTL cache.

**C3 — No `shutdown()` method; timers are untracked**
`src/core/engine.ts` ~lines 369–374
`setTimeout` / `setImmediate` handles in `launchRun()` are never stored or cleared. The process cannot exit cleanly while delayed runs are pending. Implement `WorkflowEngine.shutdown()` that cancels all tracked handles.

**C4 — Race condition in `waitForRun`**
`src/core/engine.ts` ~lines 480–527
Storage is polled _before_ subscribing to events. A run completing in that window emits an event that is never received, causing an infinite wait. Fix: subscribe first, then check storage; unsubscribe immediately if terminal.

---

### WARNING (10)

| # | File | Issue |
|---|------|-------|
| W1 | `package.json` deps | `npm audit`: `picomatch` (HIGH ReDoS) + `brace-expansion` (MODERATE hang). Run `npm audit fix`. |
| W2 | `src/storage/postgres.ts:13-16` | 48 `any` casts — concentrated in lazy Kysely imports. Use conditional types or `unknown` + guards. |
| W3 | `src/events/webhook.ts` | Webhook secret length not enforced despite docs recommending ≥ 32 bytes. Validate in `addEndpoint()`. |
| W4 | `src/events/webhook.ts` | DNS validation is outside the retry loop — DNS failures skip all retry logic. Move inside loop. |
| W5 | `src/scheduler/cron.ts:96-97` | `start()` after `stop()` can create duplicate subscriptions. Unconditionally unsubscribe at top of `start()`. |
| W6 | `src/storage/postgres.ts` | PG connection pool not closed if adapter goes out of scope without explicit `close()`. Document + warn. |
| W7 | `src/core/engine.ts:405-412` | No depth/count limit on `spawnChild()` — recursive workflows can spawn unboundedly. Add `maxChildDepth`. |
| W8 | `src/core/orchestrator.ts:87-93` | `emitEvent()` called without error handling — transport failures can abort workflow execution. Wrap in try-catch. |
| W9 | `src/scheduler/cron.ts` | Invalid persisted cron strings crash the scheduler on startup. Catch `CronExpressionParser.parse()` errors. |
| W10 | `src/storage/sqlite.ts` | SQLite single-writer limitation not documented. Add prominent warning; recommend Postgres for multi-worker. |

---

### INFO (5)

- **I1** — Test files are very large (engine.test.ts: 1364 lines). Split by feature for maintainability.
- **I2** — Resume/checkpoint semantics undocumented for distributed use (single-process only).
- **I3** — `registerWorkflow()` doesn't validate `kind` format or duplicate step keys.
- **I4** — Error stacks sanitized on write but not on read — defense-in-depth gap.
- **I5** — No circuit breaker for consistently failing webhook endpoints.

---

**Top 5 priorities:**
1. `JSON.parse()` error handling in all storage adapters (C1)
2. `WorkflowEngine.shutdown()` with timer cleanup (C3)
3. Fix subscribe-then-check ordering in `waitForRun` (C4)
4. `npm audit fix` for dep vulnerabilities (W1)
5. DNS caching + timeout in webhook transport (C2/W4)

Report saved to `.codekin/reports/code-review/2026-04-13_code-review-daily.md`.