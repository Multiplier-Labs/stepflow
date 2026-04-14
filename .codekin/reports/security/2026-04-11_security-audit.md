# Security Audit: stepflow

**Date**: 2026-04-11T02:46:55.102Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 1376d4fe-4d4b-45f4-8663-781da416479e
**Session**: 20d039cc-df62-48da-a043-3b916b144149

---

Now I have all the information needed to produce the full security audit report.

## Security Audit: `@multiplier-labs/stepflow`

**Date:** 2026-04-11
**Repository:** `/srv/repos/stepflow`
**Branch:** `main` (HEAD `bd16961`)
**Tech Stack:** TypeScript / Node.js · better-sqlite3 · Kysely + PostgreSQL · Socket.IO (optional peer) · cron-parser · RE2

---

## Summary

**Overall Risk Rating: Low**

The codebase is a well-structured TypeScript workflow-orchestration library. Parameterized queries, SSRF protection with DNS-rebinding prevention, HMAC-SHA256 webhook signing, and a mandatory authorization callback on the Socket.IO transport demonstrate deliberate defence-in-depth. No hardcoded secrets or committed credential files were found. No critical or high vulnerabilities were discovered.

However, three medium findings from the prior audit (2026-04-03) remain **unaddressed** in `HEAD`:

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 3 |
| Informational | 3 |

---

## Critical Findings

None.

---

## High Findings

None.

---

## Medium Findings

### M1 — Non-Cryptographic ID Generation for Workflow Run and Step Identifiers

**File:** `src/utils/id.ts:17`

**Description:**
`generateId()` constructs record primary keys using `Math.random()`:

```typescript
const randomPart = Math.random().toString(36).substring(2, 10);
```

`Math.random()` is not a CSPRNG. V8's PRNG (`xorshift128+`) is seeded from system entropy at startup, but the full internal state can be recovered from a sequence of observed outputs. An attacker who can observe any generated IDs (e.g. via API responses, event payloads, or log lines) can reconstruct the PRNG state and predict past and future run IDs with high confidence.

These IDs are used as primary keys for all workflow runs (`src/core/orchestrator.ts`), steps (`src/storage/sqlite.ts`, `src/storage/postgres.ts`), schedules (`src/scheduler/cron.ts`), and events.

**Note:** This finding was identified in the 2026-04-03 audit and is still **unaddressed** in HEAD.

**Impact:** If a consumer treats run IDs as a capability token (e.g. embedding them in shareable URLs or using them to gate access), an attacker who can observe any prior run IDs can enumerate or predict run IDs they were never given, bypassing application-level access controls. Impact is entirely dependent on the consuming application's threat model, but the library cannot guarantee ID unpredictability for security-conscious consumers.

**Remediation:**
Replace `Math.random()` with a CSPRNG. Both options are available in Node.js 18+:

```typescript
// Option A – Node.js crypto (if running in Node)
import { randomBytes } from 'node:crypto';
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = randomBytes(6).toString('base64url');
  return `${timestamp}${randomPart}`;
}

// Option B – Web Crypto (works in Node 18+ and browsers)
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  const randomPart = Buffer.from(buf).toString('base64url');
  return `${timestamp}${randomPart}`;
}
```

---

### M2 — Missing `tableName` Validation in `PostgresSchedulePersistence`

**File:** `src/scheduler/postgres-persistence.ts:153`

**Description:**
`PostgresSchedulePersistence` validates the `schema` configuration option with a strict regex at construction time:

```typescript
if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.schema)) {
  throw new Error(`Invalid schema name "${this.schema}"...`);
}
```

However, `tableName` (line 153) receives **no equivalent validation**. The raw value is concatenated into `fullTableName` at line 234–235 and injected into DDL statements via `sql.table()` and `sql.ref()` at lines 257–299.

By contrast: `SQLiteSchedulePersistence` validates `tableName` with `^[a-zA-Z_][a-zA-Z0-9_]*$` at `src/scheduler/sqlite-persistence.ts:61`, and `PostgresStorageAdapter` validates `schema` at `src/storage/postgres.ts:228`. The omission in `postgres-persistence.ts` is an inconsistency in an otherwise consistent defensive pattern.

**Note:** This finding was identified in the 2026-04-03 audit and is still **unaddressed** in HEAD.

**Impact:** Kysely's `sql.table()` correctly double-quotes identifiers, so SQL injection is currently blocked by the ORM layer. However: (1) a consumer passing a malformed name receives an opaque database error instead of a clear early failure; (2) if Kysely's quoting is bypassed by any code path or future refactor, this becomes a direct DDL injection point; (3) the existing defensive pattern in the same file (for `schema`) creates a false sense of symmetry.

**Remediation:**
Add a regex guard immediately after line 153, matching the pattern already used for `schema`:

```typescript
this.tableName = config.tableName ?? 'workflow_schedules';
if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.tableName)) {
  throw new Error(
    `Invalid table name "${this.tableName}". Table name must start with a letter or ` +
    `underscore, contain only alphanumeric characters and underscores, and be at most 63 characters.`
  );
}
```

---

### M3 — Stack Traces Included in `WorkflowError` Records Returned to Library Callers

**File:** `src/utils/errors.ts:28`, `src/utils/errors.ts:45`

**Description:**
`WorkflowEngineError.toRecord()` explicitly includes `stack: this.stack` in the serialized `WorkflowError`:

```typescript
toRecord(): WorkflowError {
  return {
    code: this.code,
    message: this.message,
    stack: this.stack,      // ← internal file paths exposed
    details: this.details,
  };
}
```

Similarly, `WorkflowEngineError.fromError()` (line 45) includes `stack: error.stack` when wrapping a generic `Error`. These `WorkflowError` records appear in `RunResult.error` (returned by `engine.startRun()`, `engine.waitForRun()`) and in the `WorkflowContext` passed to step handlers.

The library does apply `sanitizeErrorForStorage()` (which strips `stack`) before writing errors to the database. However, the in-memory `RunResult` returned synchronously to callers retains the full stack. If a consuming application forwards `RunResult` to an HTTP response body (a common pattern), the stack trace is exposed to external clients.

**Impact:** Stack traces expose absolute file-system paths, internal module names, and line numbers. This information aids an attacker in mapping the server's deployment layout and understanding application logic, reducing the effort required to exploit other vulnerabilities.

**Remediation:**
Strip the `stack` field from `WorkflowError` before it is surfaced via the public `RunResult` return value. This can be done in the `WorkflowError` type (mark `stack` as internal), in `toRecord()`, or in `executeWorkflow`'s error handling:

```typescript
toRecord(): WorkflowError {
  return {
    code: this.code,
    message: this.message,
    // stack intentionally omitted from public records
    details: this.details,
  };
}
```

If consumers need stack traces for server-side diagnostics, they can be logged via the `Logger` interface rather than included in the result object.

---

## Low Findings

### L1 — Blanket Block of All IPv6 Address Literals in SSRF Protection

**File:** `src/events/webhook.ts:493–496`

**Description:**
`isBlockedHost()` blocks **all** bracket-enclosed hostnames:

```typescript
// Block all IPv6 address literals (wrapped in brackets by URL parser)
if (hostname.startsWith('[')) {
  return true;
}
```

This blocks the loopback address `[::1]` as intended, but also blocks every legitimate public IPv6 address (e.g. `[2001:4860:4860::8888]`). The downstream `isBlockedIp()` function used for DNS-resolved addresses does contain scoped IPv6 checks, creating an inconsistency.

**Note:** This finding was identified in the 2026-04-03 audit and is still **unaddressed** in HEAD.

**Impact:** Functional limitation, not a security vulnerability. Consumers cannot register webhook endpoints at public IPv6 addresses. As IPv6 adoption grows, this will increasingly block legitimate integrations.

**Remediation:** Replace the blanket bracket-check with targeted checks for RFC-reserved IPv6 ranges: `::1` (loopback), `fc00::/7` (ULA), `fe80::/10` (link-local), and `::ffff:0:0/96` (IPv4-mapped). A minimal implementation:

```typescript
if (hostname.startsWith('[')) {
  const bare = hostname.slice(1, -1).toLowerCase();
  if (bare === '::1' || bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd')) {
    return true;
  }
  // Allow other public IPv6 addresses
  return false;
}
```

---

### L2 — `allowInsecureUrls: true` Provides No Runtime Warning

**File:** `src/events/webhook.ts:64–67`, `src/events/webhook.ts:145`

**Description:**
The `allowInsecureUrls` flag disables the HTTPS requirement and part of the SSRF scheme check. The JSDoc comment says "Set to true only in development environments," but there is no runtime enforcement or warning emitted via the configured logger when this flag is enabled.

**Impact:** A consumer who copies a development configuration to production silently downgrades all webhook deliveries to plain HTTP. Payload contents (which include workflow results, metadata, and run IDs) are then transmitted in cleartext and are susceptible to interception and replay attacks. The absence of a warning means this misconfiguration could persist undetected.

**Remediation:** Emit a warning at construction time when the flag is set:

```typescript
if (this.allowInsecureUrls) {
  this.logger.warn(
    'WebhookEventTransport: allowInsecureUrls is enabled. ' +
    'Webhook payloads will be sent over HTTP. Do not use this setting in production.'
  );
}
```

---

### L3 — No Per-Endpoint Rate Limiting on Outbound Webhook Dispatch

**File:** `src/events/webhook.ts:465–480`

**Description:**
The webhook transport implements a global concurrency cap (`maxConcurrentRequests`, default 50) and a FIFO queue, but no per-endpoint or per-second emission rate limit. A burst of workflow events (e.g. completing 200 steps in rapid succession) can cause hundreds of webhook deliveries to a single endpoint within seconds.

**Impact:** Could trigger rate-limiting responses (HTTP 429) or IP bans from external webhook receivers, disrupting event delivery for all consumers sharing that endpoint. Does not introduce an inbound attack surface but could constitute inadvertent abuse of third-party services.

**Remediation:** Add an optional per-endpoint `rateLimit` configuration (requests per second) with token-bucket logic, or document explicitly in the API that callers are responsible for selecting receivers capable of handling burst traffic.

---

## Secrets & Credentials Exposure

**Result: None found.**

Exhaustive `git grep` across all TypeScript, JavaScript, JSON, YAML, and environment file patterns for `password`, `secret`, `api_key`, `token`, and `private_key` found only:

| Location | Type | Assessment |
|---|---|---|
| `src/events/webhook.ts:22–23` | `secret?: string` type definition | Safe — no value |
| `src/events/webhook.ts:116` | JSDoc example: `process.env.WEBHOOK_SECRET` | Safe — env-var reference, not a literal |
| `src/planning/planner.ts`, `src/planning/types.ts` | `tokensPerStep`, `tokens` | LLM budget fields, not credentials |
| `dist/` build artifacts | Mirror of source | No embedded values |

No `.env` files exist in the repository. The full `git log` (`bd16961`…`0c78d90`) contains no commits that added credential files. No Base64-encoded or obfuscated secrets were detected.

---

## Recommendations

Ordered by risk impact:

1. **[Medium — M1] Replace `Math.random()` with a CSPRNG in `src/utils/id.ts:17`.**
   Use `crypto.getRandomValues()` or `crypto.randomBytes()`. This eliminates ID predictability for security-sensitive consumers and is a one-line change. Existing stored IDs are unaffected.

2. **[Medium — M2] Add `tableName` regex validation in `PostgresSchedulePersistence` constructor.**
   Add `if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.tableName))` at `src/scheduler/postgres-persistence.ts:153`, matching the pattern already applied to `schema` in the same constructor and to `tableName` in `SQLiteSchedulePersistence`. This closes a defensive inconsistency and provides a clean failure mode.

3. **[Medium — M3] Strip `stack` from public `WorkflowError` records in `src/utils/errors.ts:28,45`.**
   Remove `stack` from `toRecord()` and `fromError()` return values, or strip it at the `RunResult` construction site in the orchestrator. Log stack traces server-side via the `Logger` interface. This prevents internal paths leaking to callers who forward `RunResult` to HTTP responses.

4. **[Low — L2] Add a `logger.warn()` in `WebhookEventTransport` constructor when `allowInsecureUrls: true`.**
   Single-line addition that prevents silent HTTP downgrade in production. Can be gated on `process.env.NODE_ENV === 'production'` if strictness is undesirable during integration tests.

5. **[Low — L1] Narrow IPv6 blocking to RFC-reserved ranges only in `isBlockedHost()`.**
   Replace `hostname.startsWith('[')` at `webhook.ts:494` with targeted checks for `[::1]`, `[fe80:…]`, `[fc…]`, and `[fd…]` prefixes. Allows legitimate public IPv6 webhook endpoints without weakening SSRF protection.

6. **[Low — L3] Document or implement outbound webhook rate limiting.**
   Either add an optional `rateLimit` option to `WebhookEventTransportConfig` with token-bucket semantics, or add explicit API documentation warning consumers about burst dispatch behaviour.

7. **[Informational] Add `@throws` JSDoc to `setupClientHandlers` documenting behavior when `authorize` returns `false`.**
   Currently the silent `return` on denied subscriptions (socketio.ts:211, 235) is not documented in the public API. Clarify that a denied `workflow:subscribe` results in the socket not joining the room with no client-visible error, to prevent consumers from implementing broken "subscription failed" logic.

8. **[Informational] Document CORS configuration requirements for the Socket.IO transport.**
   `SocketIOEventTransport` accepts an already-configured `SocketIOServer` and does not set CORS headers. Add a README example showing a minimal secure CORS configuration (`origin: ['https://app.example.com']` rather than `origin: '*'`) to prevent consumers from defaulting to wildcard origins.

9. **[Informational] Add `npm audit` to the CI pipeline.**
   The production dependency surface is minimal (`cron-parser`, `re2`) but automated CVE scanning should run on every pull request. A GitHub Actions step of `npm audit --audit-level=high` would catch transitive vulnerabilities before they reach a release.

---

*Audit performed: 2026-04-11. Branch: `main` (HEAD `bd16961`). No source files were modified during this audit. Three findings (M1, M2, L1) were also present in the prior audit dated 2026-04-03 and remain unaddressed.*