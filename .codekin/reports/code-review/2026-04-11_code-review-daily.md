# Daily Code Review: stepflow

**Date**: 2026-04-11T02:46:56.903Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 592ed81f-2d62-4608-bf34-98470c42c55b
**Session**: 99646d28-b2e3-4d3a-bcdf-1478c0bc9eff

---

Let me verify the most critical findings before writing the final report.Now I have enough detail to write the full report.

---

## Daily Automated Code Review — `@multiplier-labs/stepflow` v0.2.6

**Date**: 2026-04-11 | **Commit**: `bd16961` (Initial commit — only commit in repo)

---

### Critical

**None found.**

---

### Warnings

**[W1] Checkpoint resume derives completedStepKeys from context keys — fragile assumption**
`src/core/engine.ts:569`
```typescript
const completedStepKeys = new Set(Object.keys(run.context));
```
`run.context` stores step results keyed by step key. If a step writes to context before throwing, its key will appear in context but the step didn't complete. On resume, that step would be silently skipped. There is no separate `completedSteps` log to distinguish "wrote result" from "finished cleanly."
**Recommendation**: Track a dedicated `completedSteps: string[]` field in the persisted run record, written atomically with the step result, and use that set during resume.

---

**[W2] `isBlockedIp` does not cover IPv6 reserved ranges beyond loopback and link-local**
`src/events/webhook.ts:533–557`
The resolved-IP check (`isBlockedIp`) handles IPv4 private ranges well, and blocks `::1` and `fe80:` for IPv6. However it does not block:
- `fc00::/7` — Unique Local Addresses (ULA, the IPv6 equivalent of RFC 1918)
- `ff00::/8` — Multicast
- `2001:db8::/32` — Documentation range
- `::ffff:0:0/96` — IPv4-mapped IPv6 addresses (could bypass IPv4 private range checks)

`isBlockedHost` is more aggressive (blocks all bracket-wrapped IPv6 literals), so the static check is safe. But if `validateResolvedHost` receives a resolved IPv6 address in any format other than `[addr]`, the gap applies.
**Recommendation**: In `isBlockedIp`, add IPv4-mapped check (`::ffff:` prefix) and ULA check (`/^f[cd]/i`).

---

**[W3] `enqueueRequest` doesn't guard against `maxConcurrentRequests <= 0`**
`src/events/webhook.ts:475–479`
```typescript
if (this.activeRequests < this.maxConcurrentRequests) {
  execute();
} else {
  this.requestQueue.push(execute);
}
```
If `maxConcurrentRequests` is set to `0` (or negative), the condition is never true and all requests queue forever — effectively a deadlock. There is no constructor validation.
**Recommendation**: Add `if (maxConcurrentRequests <= 0) throw new Error('maxConcurrentRequests must be > 0')` in the constructor.

---

**[W4] `withRetry` abort throws a generic `Error('Aborted')` instead of `WorkflowCanceledError`**
`src/utils/retry.ts:83–85`
```typescript
if (opts.signal?.aborted) {
  throw new Error('Aborted');
}
```
The `sleep()` helper (line 58) correctly throws `WorkflowCanceledError` on abort, but the pre-attempt abort check throws a plain `Error`. Downstream error classification (e.g. `instanceof WorkflowCanceledError`) will fail for aborts caught before the first sleep.
**Recommendation**: Change to `throw new WorkflowCanceledError('run')` to match the `sleep()` path.

---

**[W5] Hook errors log without run context**
`src/core/orchestrator.ts:258`
```typescript
logger.error('afterRun hook failed:', hookError);
```
The error is intentionally swallowed (correct behavior), but the log line has no `runId` or `kind`, making production debugging unnecessarily hard.
**Recommendation**: `logger.error(\`afterRun hook failed for run ${runId}:\`, hookError)`

---

**[W6] Integration and edge-case test coverage gaps**

No integration tests exercise the full lifecycle across multiple adapters. Specific gaps:
- Resume of a partially-completed run (directly relevant to W1 above)
- `maxConcurrency` queuing with priority ordering
- Webhook retries under network failure simulations
- Scheduler DST-boundary cron behavior
- Hook error recovery scenarios (`beforeRun`, `afterRun`, `onStepError` throwing)
- SQLite transaction rollback verification

The current test suite is unit-level and covers the happy path well, but these edge cases are where durable-execution bugs hide.

---

### Info

**[I1] CI workflow publishes without running tests**
`.github/workflows/publish.yml:23–29`
The publish job runs `npm ci` → `npm run build` → `npm publish`. There is no `npm test` or `npm run typecheck` step. A broken release could be published if tests are skipped.
**Recommendation**: Add `- run: npm test` and `- run: npm run typecheck` between Install and Publish steps.

---

**[I2] `calculateRetryDelay` is defined but never called internally**
`src/utils/retry.ts:115–121`
`withRetry` computes delay inline (`currentDelay * opts.backoff`) rather than calling `calculateRetryDelay`. The exported helper is a public API, but the internal inconsistency means the two can drift.
**Recommendation**: Refactor `withRetry` to call `calculateRetryDelay` for the delay computation, or document that they are intentionally separate.

---

**[I3] Peer dependency lower bounds are not tested**
`package.json:57–71`
`better-sqlite3>=11`, `kysely>=0.27`, `pg>=8.13` are wide ranges. Only the devDependency pinned versions are tested. If a consumer uses the minimum allowed version and it has a breaking API difference, the error surface is silent.
**Recommendation**: Add a CI matrix job that installs minimum peer dependency versions and runs the test suite.

---

**[I4] Short webhook secrets not warned against**
`src/events/webhook.ts:24`
The `secret` field accepts any string. A very short secret (< 16 bytes) produces a weak HMAC. The JSDoc example (`process.env.WEBHOOK_SECRET`) is good, but there is no runtime warning or minimum-length enforcement.
**Recommendation**: Add a `secret.length < 16` warning log in `signPayload` at minimum, or throw in the constructor.

---

**[I5] `retryDelay` in webhook config is not applied with backoff**
`src/events/webhook.ts` — webhook retries use a fixed `retryDelay` with no backoff, while the core `withRetry` utility supports exponential backoff. This inconsistency means repeated webhook failures hammer the endpoint at a fixed rate.
**Recommendation**: Either apply backoff to webhook retries (using the existing `withRetry` utility) or document the fixed-delay intent.

---

### Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| Warning | 6 |
| Info | 5 |

The codebase is well-structured with good TypeScript discipline, solid SSRF protection, and thoughtful SQLite query design. The top priorities are **W1** (checkpoint resume correctness) and **W4** (abort error type mismatch), both of which are correctness bugs rather than just style issues. **W2** is a security hardening gap. The CI publish-without-tests gap (**I1**) is a process risk worth closing quickly.