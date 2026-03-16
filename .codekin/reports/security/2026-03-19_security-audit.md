# Security Audit: stepflow

**Date**: 2026-03-19T10:29:23.624Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 709736ba-2b6c-400d-a67d-1fbb5b1c1a21
**Session**: 7d2435a9-2b4b-4151-8a09-166dc50e59a3

---

Now I have all the data needed to compile the report.

## Summary

**Overall Risk Rating: Low**

This audit covers `@multiplier-labs/stepflow` v0.2.6, a TypeScript workflow orchestration library (~14,000 lines of source). No critical or high-severity findings were discovered. The codebase demonstrates strong security fundamentals: parameterized SQL throughout, SSRF protection, ReDoS-safe regex, HMAC-SHA256 webhook signing, and stack-trace sanitization before persistence.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 3 |
| Informational | 2 |

---

## Critical Findings

None identified.

---

## High Findings

None identified.

---

## Medium Findings

### M1 — Weak Entropy in ID Generation

**File:** `src/utils/id.ts:17`

**Description:** The `generateId()` function constructs record identifiers by concatenating a base-36 timestamp with `Math.random().toString(36)`. `Math.random()` is a pseudo-random number generator (PRNG) that is explicitly **not** cryptographically secure in the V8 engine; its internal state can be recovered with sufficient observations.

```ts
// src/utils/id.ts:15-18
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${randomPart}`;
}
```

**Impact:** Run IDs and step IDs generated via `generateId()` are used as primary keys and appear in Socket.IO subscription events. If an attacker can enumerate or predict IDs, they could subscribe to private workflow run events (provided authorization callbacks are absent — see M3) or attempt IDOR attacks against storage queries.

**Remediation:** Replace `Math.random()` with `crypto.randomBytes()` (Node.js) or `crypto.getRandomValues()` (Web Crypto), which the project already uses in `signPayload()`:

```ts
import { randomBytes } from 'crypto';
const randomPart = randomBytes(8).toString('hex');
```

---

### M2 — Incomplete IPv6 SSRF Block List

**File:** `src/events/webhook.ts:453-488`

**Description:** The `isBlockedHost()` function blocks `::1` (loopback) and `fe80::` (link-local) but does **not** block:
- `fc00::/7` — IPv6 Unique Local Addresses (ULA), the IPv6 analogue of RFC 1918 (`fc00::` through `fdff::`)
- `::ffff:0:0/96` — IPv4-mapped IPv6 addresses (e.g., `::ffff:127.0.0.1`, `::ffff:10.0.0.1`), which some HTTP clients resolve to their IPv4 equivalents
- `100::0/64` — IPv6 discard prefix
- `2001:db8::/32` — Documentation/testing range that some environments route

```ts
// src/events/webhook.ts:482-485 — only fe80:: is blocked; fc00/fd00 ULA not covered
if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
  return true;
}
```

**Impact:** An attacker could supply a ULA or mapped IPv4 URL (e.g., `https://[::ffff:127.0.0.1]/`) that bypasses the block list and reaches internal services, depending on the host OS's IPv6 routing configuration.

**Remediation:** Extend `isBlockedHost()` to cover:
- `fc` and `fd` prefixes (ULA)
- `::ffff:` prefix (IPv4-mapped)
- Bracketed variants of all IPv6 patterns

---

### M3 — Socket.IO Authorization is Unenforced by Default

**File:** `src/events/socketio.ts:183-204`

**Description:** The `setupClientHandlers()` method accepts an optional `authorize` callback. When no callback is provided (the common path for quick integrations), **any connected client can subscribe to any run's events**, including runs belonging to other users or tenants.

```ts
// src/events/socketio.ts:194
public setupClientHandlers(
  socket: SocketIOSocket,
  authorize?: SocketIOAuthorizeFn   // optional — unenforced when omitted
): void
```

The JSDoc warns that authorization should always be provided in production, but this is not enforced programmatically.

**Impact:** Unauthorized clients can receive real-time workflow execution events (step outputs, run status) for runs they do not own. In multi-tenant deployments this constitutes an information disclosure vulnerability.

**Remediation:** Consider making `authorize` a required parameter, or defaulting to a deny-all policy when not provided (returning `false` for all subscriptions unless explicitly unlocked). At minimum, emit a runtime warning when `setupClientHandlers` is called without an `authorize` callback.

---

## Low Findings

### L1 — DNS Rebinding Not Mitigated in Webhook SSRF Check

**File:** `src/events/webhook.ts:402-425`

**Description:** The SSRF check in `validateWebhookUrl()` is performed once at `addEndpoint()` time against the URL's static hostname string. It does **not** re-validate the resolved IP address immediately before each HTTP request. A DNS rebinding attack — where the hostname initially resolves to a public IP (passing validation) and subsequently resolves to a private IP (used for the actual request) — can bypass this protection.

**Impact:** Exploitability requires an adversary-controlled DNS server and is therefore a low-probability, environment-specific threat. However, in high-security deployments the risk is real.

**Remediation:** Perform a DNS pre-resolution check before each outgoing request using `dns.promises.lookup()` and validate the resulting IP against the private range block list before dispatching the `fetch` call.

---

### L2 — `allowInsecureUrls` Has No Environment Guard

**File:** `src/events/webhook.ts:66`

**Description:** The `allowInsecureUrls` configuration flag disables HTTPS enforcement and is documented as a development-only setting, but there is no runtime check preventing its use in production environments.

**Impact:** If a developer accidentally enables this in a production build, webhook payloads (which may contain sensitive workflow state) are transmitted in cleartext over HTTP.

**Remediation:** Emit a prominent `console.warn` or `logger.warn` at construction time when `allowInsecureUrls: true` is set, to surface accidental misuse in logs. Document explicitly in README that this flag must never be enabled in production.

---

### L3 — Error Responses May Leak Internal URL Structure

**File:** `src/events/webhook.ts:352`

**Description:** When a webhook call fails, the error message includes the HTTP status code and status text from the remote server:

```ts
lastError = new Error(`Webhook returned ${response.status}: ${response.statusText}`);
```

If callers propagate this error to end users or external logs, it can confirm the existence and reachability of internal endpoints (useful for SSRF enumeration).

**Impact:** Low — information leakage limited to status codes, not body content or internal IPs.

**Remediation:** Ensure callers handle these errors in internal logs only, not in user-facing responses. The library itself cannot prevent this but should note the risk in its documentation.

---

## Secrets & Credentials Exposure

**Result: No hardcoded or committed secrets found.**

- All `secret`, `password`, `api_key`, and `token` references in source files are either:
  - **Type declarations** (`secret?: string`) with no assigned values
  - **JSDoc examples** explicitly directing users to `process.env.WEBHOOK_SECRET`
  - **Non-sensitive** uses of the word "token" (LLM token counts, `js-tokens` package)
- `.gitignore` correctly excludes `.env`, `.env.local`, and `.env.*.local`
- No `.env` files present in the repository
- The `dist/` directory is committed (for git-based installation) but contains no secrets

---

## Informational

### I1 — `sql.table()` Used with Schema-Interpolated Table Names

**File:** `src/storage/postgres.ts:317-463`, `src/scheduler/postgres-persistence.ts:239-299`

The schema name is validated with a strict allowlist regex before use (`/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/` at `src/storage/postgres.ts:228`). Kysely's `sql.ref()` and `sql.table()` helpers provide escaping for identifiers. No injection risk is present given the validation, but the pattern warrants ongoing attention if the schema handling is refactored.

### I2 — `fetchFn` Injectable for Testing

**File:** `src/events/webhook.ts:60`

The `fetchFn` configuration option allows callers to replace the HTTP client used for webhook delivery. This is a sound testing pattern but could be misused to inject a custom fetch that bypasses SSRF validation, since `validateWebhookUrl()` runs at `addEndpoint()` time regardless of `fetchFn`. This is an architectural note, not a vulnerability.

---

## Recommendations

1. **(Medium priority) Replace `Math.random()` with `crypto.randomBytes()`** in `src/utils/id.ts`. The project already uses Web Crypto for HMAC signing — use the same primitive for ID entropy. This eliminates any IDOR risk from predictable identifiers.

2. **(Medium priority) Extend the IPv6 SSRF block list** in `src/events/webhook.ts:isBlockedHost()` to cover ULA prefixes (`fc00::/7`), IPv4-mapped addresses (`::ffff:`), and bracketed IPv6 literals. Test against all new cases with unit tests mirroring the existing `ssrf-*` test suite.

3. **(Medium priority) Enforce Socket.IO authorization by default** — either make the `authorize` parameter required in `setupClientHandlers()`, or default to a deny-all policy (log a warning and reject all subscriptions) when no callback is provided. Add a clearly visible production-security notice to the README.

4. **(Low priority) Add pre-request DNS IP validation** in `WebhookTransport.sendToEndpoint()` to defend against DNS rebinding: resolve the hostname to an IP immediately before each `fetch` call and re-run it through `isBlockedHost()`. Use Node.js `dns.promises.lookup()` with `{ verbatim: true }`.

5. **(Low priority) Warn on `allowInsecureUrls: true`** at construction time in `WebhookTransport`. A `logger.warn('[stepflow] allowInsecureUrls is enabled — HTTPS is not enforced. Do not use in production.')` line will surface accidental misconfigurations in log pipelines.

6. **(Low priority) Add webhook secret strength guidance** to the `WebhookEndpointConfig.secret` JSDoc: specify a minimum entropy of 32 bytes (256 bits) and link to a generation example (`openssl rand -hex 32`). The current comment recommends a length but does not quantify it sufficiently.

7. **(Informational) Audit downstream caller error handling** for webhook errors. Document that `WebhookTransport` error messages should be treated as internal diagnostics and must not be forwarded to end users or external parties in their raw form.

8. **(Informational) Consider adding `npm audit` to CI** — while current dependencies are minimal and up-to-date, automating `npm audit --audit-level=high` in the CI pipeline ensures new transitive vulnerabilities are caught before release. The recent dependency audit commit (`85bf3b5`) demonstrates this is already a team practice; automating it removes the manual step.