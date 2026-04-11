# Security Audit: stepflow

**Date**: 2026-04-03T20:03:06.542Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 54523493-771d-44b8-b39f-03f2d6caa49e
**Session**: 53e402d9-8d47-49b4-9a27-03f2ae5ec912

---

I now have all the information needed to produce the report. Here is the security audit:

---

## Summary

**Overall Risk Rating: Low**

The Stepflow project is a TypeScript workflow orchestration library with a mature security posture. No critical or high vulnerabilities were identified. The codebase demonstrates intentional, defence-in-depth practices: parameterized queries, SSRF protection with DNS-rebinding prevention, HMAC-SHA256 webhook signing, and delegated authorization. Recent commits (`48e5f0a`, `d61858c`) show that prior SSRF and SQL-injection issues were already discovered and remediated.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 3 |
| Informational | 4 |

---

## Critical Findings

None.

---

## High Findings

None.

---

## Medium Findings

### M1 — Missing Input Validation on `tableName` in `PostgresSchedulePersistence`

**File:** `src/scheduler/postgres-persistence.ts:153`

**Description:**  
`PostgresSchedulePersistence` validates `schema` with a strict regex (`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`) but applies **no equivalent validation to `tableName`**. The raw `tableName` string is concatenated into `fullTableName` (`${this.schema}.${this.tableName}`) at line 235 and then passed to Kysely's `sql.table()` and `sql.ref()` at lines 257–296. While Kysely correctly double-quotes identifiers — preventing SQL injection — there is no upfront guard to reject nonsensical or adversarially crafted values.

Contrast: `SQLiteSchedulePersistence` (`src/scheduler/sqlite-persistence.ts:61`) validates its `tableName` with `^[a-zA-Z_][a-zA-Z0-9_]*$` and the Postgres *storage* adapter (`src/storage/postgres.ts:228`) validates its schema similarly. The omission in `postgres-persistence.ts` is an inconsistency in the defensive pattern.

**Impact:**  
In the current implementation, `sql.table()` quoting prevents SQL injection. However, a consumer passing a malformed `tableName` (e.g. `"foo\x00bar"`, very long strings, or strings containing periods) will receive a confusing runtime database error rather than a clear upfront `Error`. If the Kysely dependency ever changes its quoting behaviour, this becomes a direct injection point.

**Remediation:**  
Add the same regex guard used for `schema` immediately after line 153:
```typescript
if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.tableName)) {
  throw new Error(`Invalid table name "${this.tableName}".`);
}
```

---

### M2 — Non-Cryptographic ID Generation Used for Workflow Run Identifiers

**File:** `src/utils/id.ts:17`

**Description:**  
`generateId()` constructs identifiers using `Date.now()` and `Math.random()`:

```typescript
const randomPart = Math.random().toString(36).substring(2, 10);
```

`Math.random()` is not a CSPRNG. V8's implementation is seeded with a 64-bit value derived from the system clock at startup; an attacker with knowledge of the process start time can reconstruct the PRNG state and predict future IDs. These IDs are used as primary keys for workflow runs and steps (`src/core/orchestrator.ts`).

**Impact:**  
If run IDs are used for access-control purposes by a consumer (e.g. "share a link containing the run ID" patterns), predictable IDs enable enumeration and unauthorized access. The library itself does not enforce any access control on run IDs, so impact depends entirely on the consuming application's threat model.

**Remediation:**  
Replace `Math.random()` with `crypto.randomBytes` (Node) or `crypto.getRandomValues` (Web Crypto), both available in Node.js 18+:
```typescript
import { randomBytes } from 'node:crypto';
const randomPart = randomBytes(6).toString('base64url');
```

---

## Low Findings

### L1 — Blanket Block of All IPv6 Literals in SSRF Protection

**File:** `src/events/webhook.ts:493–496`

**Description:**  
The `isBlockedHost` function blocks **all** IPv6 address literals, not just private/reserved ones:

```typescript
// Block all IPv6 address literals (wrapped in brackets by URL parser)
if (hostname.startsWith('[')) {
  return true;
}
```

This was added to prevent SSRF via `[::1]` and similar loopback bypasses (commit `48e5f0a`). While the intent is correct, the implementation also blocks legitimate public IPv6 targets such as `[2001:db8::1]`.

**Impact:**  
Consumers cannot register webhook endpoints using public IPv6 addresses. This is a functional limitation, not a security vulnerability. As global IPv6 adoption grows, this will become increasingly restrictive.

**Remediation:**  
Instead of blocking all bracket-wrapped addresses, parse the IPv6 address, expand it to full form, and check only against reserved ranges (loopback `::1`, ULA `fc00::/7`, link-local `fe80::/10`, documentation prefixes, etc.) using a library or the same range-check logic applied to IPv4.

---

### L2 — `allowInsecureUrls` Flag Lacks Production-Safety Warning

**File:** `src/events/webhook.ts:64–67`

**Description:**  
The `allowInsecureUrls` option on `WebhookEventTransportConfig` relaxes the HTTPS requirement and bypasses URL scheme validation:

```typescript
/**
 * Whether to allow non-HTTPS URLs (default: false).
 * Set to true only in development environments.
 */
allowInsecureUrls?: boolean;
```

The comment mentions development use, but there is no runtime enforcement or warning when this flag is enabled in a context that looks like production (e.g. `NODE_ENV=production`).

**Impact:**  
A consumer who copies a development configuration to production silently downgrades all webhooks to plain HTTP, exposing payloads (which may contain workflow results and metadata) to network interception, and disabling part of the SSRF protection.

**Remediation:**  
Emit a logger warning at construction time when `allowInsecureUrls: true` is set, e.g.:
```typescript
if (this.allowInsecureUrls) {
  this.logger.warn('allowInsecureUrls is enabled. Do not use this in production.');
}
```

---

### L3 — No Rate Limiting on Outbound Webhook Dispatch

**File:** `src/events/webhook.ts:465–480`

**Description:**  
The webhook transport implements concurrency limiting (default 50 concurrent requests) and a queue, but no per-endpoint rate limiting or per-second emission cap. A burst of workflow events can cause hundreds of webhook deliveries in a short window.

**Impact:**  
Could trigger rate limiting or bans from external webhook receivers. Does not directly introduce an inbound attack surface (the library sends, not receives), but could cause unintended denial-of-service toward third-party services.

**Remediation:**  
Add an optional `rateLimit` configuration (e.g. `maxRequestsPerSecond`) per endpoint or globally, with token-bucket or leaky-bucket logic.

---

## Secrets & Credentials Exposure

**Result: None found.**

- `git grep` across all `*.ts`, `*.js`, `*.json`, `*.yaml`, `*.yml` files for `password`, `secret`, `api_key`, `token`, and `private_key` returned only:
  - **`src/events/webhook.ts:22–23`** — `secret?: string` type definition for HMAC signing (no value)
  - **`src/events/webhook.ts:116`** — JSDoc comment example: `secret: process.env.WEBHOOK_SECRET` (correctly references an environment variable, not a hardcoded value)
  - **`src/planning/planner.ts`, `src/planning/types.ts`** — `tokensPerStep`, `tokens` — LLM token budget fields, not credentials
  - **`dist/` build artefacts** — mirror of source, no embedded values

- No `.env` files exist in the repository at any path.
- `git log --all -p -- "*.env" "*.pem" "*.key"` returned no output — no credential files were ever committed to git history.

---

## Recommendations

The following are ordered by risk impact:

1. **[Medium — M1] Validate `tableName` in `PostgresSchedulePersistence`.**  
   Add a regex guard (`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`) for `tableName` at `src/scheduler/postgres-persistence.ts:153`, matching the existing pattern in `sqlite-persistence.ts:61` and `storage/postgres.ts:228`. This closes the inconsistency and provides a clean failure mode.

2. **[Medium — M2] Replace `Math.random()` with a CSPRNG in ID generation.**  
   Replace `Math.random()` at `src/utils/id.ts:17` with `crypto.getRandomValues` or Node's `crypto.randomBytes`. The timestamp prefix can remain. This is low-effort and eliminates predictability of workflow run IDs if consumers use them for access decisions.

3. **[Low — L2] Add a runtime warning for `allowInsecureUrls: true`.**  
   Log a warning through the configured logger in `WebhookEventTransport`'s constructor when `allowInsecureUrls` is set. This is a single-line addition that prevents silent production misconfiguration.

4. **[Low — L1] Narrow IPv6 blocking to reserved ranges only.**  
   Replace the blanket `hostname.startsWith('[')` block in `isBlockedHost` (`webhook.ts:493`) with targeted checks for `[::1]`, `[fc00:...]`, `[fe80:...]`, and other RFC-reserved IPv6 prefixes, allowing legitimate public IPv6 webhook endpoints.

5. **[Low — L3] Document or implement outbound webhook rate limiting.**  
   Either add an optional `rateLimit` configuration to `WebhookEventTransport`, or explicitly document in JSDoc that consumers are responsible for choosing receivers that can handle burst traffic.

6. **[Informational] Add explicit authorization enforcement documentation.**  
   The Socket.IO transport (`src/events/socketio.ts`) requires consumers to provide an `authorize` callback. Add JSDoc `@throws` documentation and an example showing what happens when no `authorize` callback is supplied, to prevent consumers from accidentally running with open subscriptions.

7. **[Informational] Consider documenting CORS requirements for Socket.IO consumers.**  
   The library accepts an already-constructed `SocketIOServer` (`src/events/socketio.ts:45`) and does not configure CORS. Add a README section or JSDoc example showing the minimum recommended CORS configuration to avoid consumers defaulting to wildcard origins.

8. **[Informational] Run `npm audit` in CI.**  
   The production dependency surface is minimal (only `cron-parser` and `re2`), but automated vulnerability scanning should be enforced in the CI pipeline to catch transitive dependency CVEs early.

---

*Audit performed: 2026-04-03. Branch: `main` (HEAD `4d9838a`). No source files were modified during this audit.*