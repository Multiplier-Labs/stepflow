# Security Audit: stepflow

**Date**: 2026-03-16T14:27:03.704Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 009534f2-0b48-42d8-a8c7-722b9ebfdf24
**Session**: 5565f37b-693a-419e-9d52-dbc0d31dfbb1

---

Now I have all the data needed to produce the report.

## Security Audit Report — @multiplier-labs/stepflow v0.2.6

**Audit Date:** 2026-03-16
**Audited Revision:** `bbe9905` (branch: `main`)
**Tech Stack:** TypeScript / Node.js ESM library — workflow orchestration engine with SQLite (better-sqlite3), PostgreSQL (Kysely + pg), Socket.IO events, and HMAC-signed webhooks.

---

## Summary

**Overall Risk Rating: High**

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 5 |
| Informational / Positive | 5 |

No hardcoded credentials were found in source files. The most significant risks are a confirmed upstream dependency vulnerability with an available fix, an unvalidated SSRF vector in the webhook transport, and missing authorization controls on Socket.IO run subscriptions.

---

## Critical Findings

_None identified._

---

## High Findings

### H-1 — Server-Side Request Forgery (SSRF) in Webhook Transport

**File:** `src/events/webhook.ts:281`

**Description:**
`WebhookEndpoint.url` is a plain `string` with no validation. It is passed directly to `globalThis.fetch()` (or a user-supplied `fetchFn`) without any allowlist, scheme check, or IP-range filter:

```typescript
// src/events/webhook.ts:281-286
const response = await this.fetchFn(endpoint.url, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
  signal: controller.signal,
});
```

An attacker who can register a webhook endpoint can direct the server to make POST requests to:
- `http://169.254.169.254/latest/meta-data/` (AWS/GCP instance metadata)
- `http://127.0.0.1:<port>/` (internal services)
- `http://10.x.x.x/` or `http://192.168.x.x/` (internal networks)
- Non-HTTP schemes handled by the underlying fetch implementation

**Impact:** Full SSRF — internal service enumeration, credential theft from cloud metadata endpoints, lateral movement within the hosting network.

**Remediation:**
1. Parse the URL and validate the scheme is `https:` (block `http:` in non-development environments).
2. Resolve the hostname and reject RFC 1918 addresses, loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), and the cloud metadata address `169.254.169.254`.
3. Consider an explicit allowlist of permitted hostname patterns.

---

### H-2 — Rollup Arbitrary File Write via Path Traversal (GHSA-mw96-cpmx-2vgc)

**File:** `package-lock.json` (transitive devDependency through `tsup`)

**Description:**
`npm audit` reports a **high-severity** vulnerability in `rollup 4.0.0–4.58.0`:

```
rollup  4.0.0 - 4.58.0
Severity: high
Rollup 4 has Arbitrary File Write via Path Traversal
https://github.com/advisories/GHSA-mw96-cpmx-2vgc
fix available via `npm audit fix`
```

**Impact:** During a build (e.g., CI/CD pipeline), a malicious plugin or crafted input could write files to arbitrary paths on the build host. If the build runs with elevated privileges or in a shared environment, this can lead to code execution or supply-chain compromise.

**Remediation:**
Run `npm audit fix` immediately. The fix is available and non-breaking.

---

## Medium Findings

### M-1 — Socket.IO Run Subscriptions Have No Authorization Check

**File:** `src/events/socketio.ts:172-195`

**Description:**
`setupClientHandlers()` allows any connected socket to join the room for any `runId` and even a global room that receives all workflow events, with zero authentication or authorization:

```typescript
// src/events/socketio.ts:172-175
socket.on('workflow:subscribe', (...args: unknown[]) => {
  const runId = args[0];
  if (typeof runId === 'string') {
    socket.join(`${this.roomPrefix}${runId}`);  // no ownership check
  }
});

// src/events/socketio.ts:188-189
socket.on('workflow:subscribe:all', () => {
  socket.join(this.globalRoom);  // subscribes to ALL runs
});
```

**Impact:** Any authenticated (or unauthenticated, depending on Socket.IO server config) client can observe the real-time state of any workflow run, including its input, output, and intermediate step results, by guessing or enumerating `runId` values (which are application-generated but not cryptographically secret in isolation).

**Remediation:**
`setupClientHandlers()` should accept an optional authorization callback, e.g.:

```typescript
setupClientHandlers(
  socket: SocketIOSocket,
  canAccessRun?: (runId: string) => boolean | Promise<boolean>
): void
```

Callers are responsible for supplying the check. Document that omitting the callback leaves subscriptions open to all connected clients.

---

### M-2 — Bare `console.error()` Calls Outside Logger Infrastructure

**Files:**
- `src/events/webhook.ts:164, 173, 183`
- `src/events/socketio.ts:116, 125`

**Description:**
Five `console.error()` calls exist in the event transport layer that bypass the configurable `Logger` interface used everywhere else in the codebase. These calls log raw `Error` objects (including `.message`, `.stack`, and any enumerable properties) directly to stderr with no filtering:

```typescript
// src/events/webhook.ts:183
console.error(`Webhook ${endpoint.id} failed:`, error);

// src/events/socketio.ts:116
console.error('Event callback error:', error);
```

**Impact:** Error objects thrown during webhook delivery may contain stack frames, database connection strings (from Kysely errors), or webhook secrets embedded in request headers. These appear in application logs that may be shipped to third-party log aggregation services.

**Remediation:**
Replace all five `console.error()` calls with the configurable `Logger` (already used throughout the rest of the codebase). Add a `logger` option to `WebhookTransportConfig` and `SocketIOTransportConfig`, defaulting to `new SilentLogger()` (or `ConsoleLogger`) so existing consumers are not broken.

---

### M-3 — Schema Name Passed to `sql.ref()` Without Input Validation

**Files:** `src/storage/postgres.ts:272`, `src/scheduler/postgres-persistence.ts:220`

**Description:**
The PostgreSQL schema name (`this.schema`) originates from user-supplied configuration and is passed directly to Kysely's `sql.ref()` and `sql.table()` helpers:

```typescript
// src/storage/postgres.ts:272
await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(this.schema)}`.execute(this.db);

// src/storage/postgres.ts:796
UPDATE ${sql.table(`${this.schema}.runs`)}
```

Kysely's `sql.ref()` quotes identifiers but does not prevent an attacker from supplying a crafted schema name such as `public"; DROP SCHEMA app CASCADE; --` in environments where identifier quoting is bypassed or misconfigured.

**Impact:** If a multi-tenant application allows users to specify their own schema names, a malicious schema value could escape identifier quoting depending on the PostgreSQL version and driver behavior. This is low-probability but high-impact.

**Remediation:**
Validate `schema` against a strict allowlist regex (e.g., `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`) at construction time and throw a descriptive error if it fails. This is inexpensive and eliminates the risk entirely.

---

## Low Findings

### L-1 — `ConsoleLogger.debug()` Always Emits, No Environment Gate

**File:** `src/utils/logger.ts:18-20`

**Description:**
`ConsoleLogger.debug()` calls `console.debug()` unconditionally. Callers throughout the engine (`src/core/engine.ts`, `src/scheduler/cron.ts`) emit debug messages that include run IDs, step keys, and workflow kind names at every lifecycle transition. With the default `ConsoleLogger`, this output is always present in production.

**Impact:** Verbose debug output may surface workflow topology and internal IDs in log streams visible to operators or third-party services without a conscious decision to enable debug logging.

**Remediation:**
Add a `level` option to `ConsoleLogger` (default `'info'`) that suppresses `debug` output unless explicitly enabled.

---

### L-2 — `WorkflowError` Optionally Persists Stack Traces to Storage

**File:** `src/core/types.ts:44`

**Description:**
`WorkflowError.stack?: string` is persisted in the storage layer alongside workflow state. Stack traces expose internal file paths, function names, and library versions.

**Impact:** If workflow run records are exposed via an API or breach of the storage layer, stack traces provide a roadmap for targeted exploitation.

**Remediation:**
Strip stack traces before writing to storage (store them in structured logs instead), or make storage of stacks opt-in via a debug flag.

---

### L-3 — Example Code Uses Weak Placeholder Secret

**File:** `src/events/webhook.ts:86`

**Description:**
A JSDoc `@example` block demonstrates webhook configuration with `secret: 'webhook-secret-123'`. Documentation-adjacent examples are routinely copy-pasted into production code.

**Impact:** Low direct risk, but normalizes the use of weak secrets.

**Remediation:**
Replace with `secret: process.env.WEBHOOK_SECRET` and add a note that secrets should be at least 32 random bytes.

---

### L-4 — No Webhook Payload Size Limit

**File:** `src/events/webhook.ts:284`

**Description:**
`JSON.stringify(payload)` is posted to webhook endpoints without a maximum body size constraint. Workflow events with large `data` fields can produce arbitrarily large payloads.

**Impact:** Memory pressure on the server if many large events are dispatched concurrently; potential to exhaust the receiving server's request handling capacity.

**Remediation:**
Add a `maxPayloadBytes` option (default e.g. 1 MB) to `WebhookTransportConfig` and reject or truncate payloads that exceed it before dispatch.

---

### L-5 — No Rate Limiting on Webhook Dispatch

**File:** `src/events/webhook.ts:175-185`

**Description:**
Webhooks are fired for every event emitted by every workflow run without any throttling, concurrency cap, or backpressure mechanism:

```typescript
for (const endpoint of this.endpoints.values()) {
  // ...
  this.sendWebhook(endpoint, event).catch((error) => {
    console.error(`Webhook ${endpoint.id} failed:`, error);
  });
}
```

**Impact:** A high-throughput workflow or a burst of concurrent runs can spawn thousands of concurrent outbound HTTP requests, exhausting the process's TCP connection pool and potentially DDoSing the receiving server.

**Remediation:**
Implement a bounded async queue (e.g., using a semaphore with configurable `maxConcurrentRequests` per endpoint). Consider adding per-endpoint rate limiting.

---

## Secrets & Credentials Exposure

A full scan with `git grep` across all TypeScript, JavaScript, JSON, YAML, and environment file patterns found **no hardcoded credentials, API keys, passwords, or private keys** in the source tree.

Findings of note:
- `src/events/webhook.ts:86` — JSDoc example contains the string `'webhook-secret-123'`. This is illustrative placeholder text, not a real credential. No actual secret value was found.
- `package-lock.json` — contains only npm registry URLs and package integrity hashes; no credentials.
- No `.env`, `.env.local`, or other secret-containing files are present or committed to the repository.

---

## Recommendations

Ordered by risk impact:

1. **Run `npm audit fix` now (H-2).** The Rollup path-traversal vulnerability is confirmed by `npm audit`, a fix is available, and build pipelines run on every commit. This is a one-command fix with no breaking changes.

2. **Add SSRF protection to `WebhookTransport` (H-1).** Validate webhook URLs at registration time and at dispatch time. Block non-HTTPS schemes and RFC 1918 / loopback / link-local / metadata service IP ranges. This is the only vector for network-level attacks reachable from normal library use.

3. **Add an authorization callback to `setupClientHandlers()` (M-1).** The Socket.IO adapter is explicitly designed for use in multi-user applications; shipping it without an authorization hook forces every consumer to either re-implement the room-join logic or accept open subscriptions. A simple optional `canAccess: (runId: string, socket: Socket) => boolean | Promise<boolean>` parameter closes the gap.

4. **Validate `schema` configuration with a strict regex (M-3).** A one-line guard at construction time (`/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)`) eliminates the identifier-injection risk entirely before any database connection is made.

5. **Route all error logging through the `Logger` interface (M-2).** The five `console.error()` calls in the event transports are inconsistent with the rest of the codebase and cannot be silenced without patching the library. This is a low-effort change that improves the library's operational safety profile.

6. **Add a `level` option to `ConsoleLogger` (L-1).** Suppress `debug` output by default in `ConsoleLogger`. Callers who want debug output can opt in explicitly, reducing accidental information disclosure in production log streams.

7. **Strip stack traces before persistence (L-2).** Remove `stack` from `WorkflowError` records written to SQLite/PostgreSQL, or gate inclusion behind a debug flag. Stack traces belong in structured logs, not in durable workflow state.

8. **Add `maxPayloadBytes` and `maxConcurrentRequests` options to `WebhookTransport` (L-4, L-5).** These configuration knobs prevent resource exhaustion under load and are straightforward additions to `WebhookTransportConfig`.

9. **Replace the `'webhook-secret-123'` example with `process.env.WEBHOOK_SECRET` (L-3).** Update the JSDoc example and the README to show environment-variable-based secret management and a note that secrets must be cryptographically random with sufficient entropy (≥ 32 bytes).

10. **Document Socket.IO CORS requirements explicitly (informational).** Add a note to the `SocketIOTransport` docs warning that Socket.IO's default CORS policy (`origin: *`) is permissive and should be scoped to known origins before deployment. Provide a configuration example using `process.env.ALLOWED_ORIGINS`.

---

## Positive Security Observations

- **No SQL injection vectors found.** All database queries use parameterized statements (better-sqlite3 prepared statements, Kysely query builder with `sql.ref()` / `sql.table()` for identifiers).
- **No remote code execution vectors.** No `eval()`, `new Function()`, `child_process.exec()`, or dynamic `require()` of user-supplied input exists anywhere in the source tree.
- **TypeScript strict mode enabled.** `tsconfig.json` sets `"strict": true`, which catches a broad class of type-related bugs at compile time.
- **HMAC-SHA256 webhook signing uses the Web Crypto API.** The implementation (`src/events/webhook.ts:311–330`) correctly uses `crypto.subtle` with a non-extractable key and constant-time underlying primitives.
- **No committed secrets.** The repository contains no `.env` files, private keys, or hardcoded credentials.