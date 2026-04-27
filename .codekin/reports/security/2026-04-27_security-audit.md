# Security Audit: stepflow

**Date**: 2026-04-27T09:47:24.195Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 43c7b594-65ce-44f0-9729-60d18d2e5dfc
**Session**: 280619a7-39df-445b-bc31-461b5a63cc54

---

I'll conduct a comprehensive security audit of this project. Let me gather information in parallel.I now have sufficient data to compile the complete security report.

---

## Summary

**Overall Risk Rating: Medium**

This is a TypeScript workflow-orchestration library (`@multiplier-labs/stepflow`). No hardcoded secrets were found in the repository. SQL queries are parameterized throughout. The most significant gaps are **incomplete IPv6 SSRF protection** in the webhook transport's runtime DNS-validation path, an **unbounded in-memory request queue** in the webhook transport, and **missing `npm audit` in the publish pipeline**.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 4 |

---

## Critical Findings

None identified.

---

## High Findings

### H1 — Incomplete IPv6 SSRF Protection in `isBlockedIp`

**File:** `src/events/webhook.ts` — `isBlockedIp()` function (~line 535)

**Description:** The static hostname check (`isBlockedHost`) correctly blocks all IPv6 *literals* in URLs by testing `hostname.startsWith('[')`. However, the runtime DNS-resolution check (`isBlockedIp`) — called after `dns.lookup()` resolves a hostname to an IP — has incomplete IPv6 coverage. It only blocks `::1` (loopback) and `fe80:` (link-local) addresses. The following ranges are **not blocked**:

- `fc00::/7` — Unique Local Addresses (`fc00::` through `fdff::`)
- `::ffff:0:0/96` — IPv4-mapped addresses (e.g. `::ffff:127.0.0.1`)
- `64:ff9b::/96` — IPv4-translated addresses
- `::` — unspecified address

**Impact:** An attacker who controls a webhook endpoint URL could register a public hostname that DNS-resolves to an internal IPv6 address in the ULA range (e.g. `fd12::1`). Because `isBlockedIp` does not block ULA ranges, the SSRF guard passes and the webhook transport posts the event payload to that internal address. This could be used to probe or interact with internal services behind a dual-stack firewall.

**Remediation:**
```typescript
function isBlockedIp(ip: string): boolean {
  // ... existing IPv4 checks ...

  // Full IPv6 private/reserved coverage
  if (ip === '::' || ip === '::1') return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:')) return true;          // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('::ffff:')) return true;        // IPv4-mapped
  if (lower.startsWith('64:ff9b:')) return true;       // IPv4-translated

  return false;
}
```

---

### H2 — Unbounded Webhook Request Queue (Memory Exhaustion)

**File:** `src/events/webhook.ts` — `requestQueue` and `enqueueRequest()` (~lines 137, 470–486)

**Description:** The `enqueueRequest()` method pushes pending webhook calls onto `this.requestQueue: Array<() => void>` when `activeRequests >= maxConcurrentRequests`. There is no cap on the queue length. If webhook endpoints are slow or unreachable (retries × delay can be up to `3 × 1s × 2^n ≈ 7 seconds` per delivery), events continue to enqueue while deliveries are stuck. Under sustained high event throughput, `requestQueue` grows unboundedly, consuming heap memory until the Node.js process is killed by OOM.

**Impact:** Sustained workflow activity with a slow or unreachable webhook endpoint causes memory exhaustion and process crash, taking down the host application alongside it. This can be triggered by legitimate (non-malicious) load spikes.

**Remediation:** Add a `maxQueueSize` configuration option (e.g. default `1000`) and drop or error on overflow:

```typescript
if (this.requestQueue.length >= this.maxQueueSize) {
  this.logger.warn(`Webhook queue full (${this.maxQueueSize}), dropping delivery for endpoint ${endpoint.id}`);
  return;
}
this.requestQueue.push(execute);
```

---

## Medium Findings

### M1 — DNS TOCTOU Window Allows Residual DNS Rebinding

**File:** `src/events/webhook.ts` — `validateResolvedHost()` and `sendWebhook()` (~lines 340–360, 415–430)

**Description:** The SSRF defense resolves the hostname and validates the resulting IP *before* making the HTTP request. However, the `fetch()` call still uses the original URL string (hostname), not the validated IP. If the DNS record has a very short TTL and an attacker controls both a public DNS server and an internal server, they can serve a legitimate IP on the first resolution (which passes the check) and then change the DNS entry to an internal address before the fetch is issued (rebinding). The attack window is narrow but not zero.

**Impact:** A sophisticated attacker with DNS control could potentially bypass SSRF protection to reach internal services. Exploitability is constrained by the narrow timing window, attacker needing DNS control, and the host's DNS caching behavior.

**Remediation:** After resolving the IP, establish the connection to the *resolved IP address* directly (using a custom `Agent` or overriding the request target) rather than re-resolving the hostname at `fetch()` time. Alternatively, document the residual risk prominently and recommend users deploy network-level egress controls.

---

### M2 — `safeJsonParse` Bypasses Custom Logger, May Log Raw Database Content

**Files:** `src/storage/sqlite.ts:522`, `src/storage/postgres.ts:863`, `src/scheduler/sqlite-persistence.ts:221`, `src/scheduler/postgres-persistence.ts:487`

**Description:** All `safeJsonParse` implementations call `console.warn(...)` directly on parse failure, logging the raw `SyntaxError` message alongside the corrupted value. This bypasses any custom `Logger` injected at configuration time, so these warnings always reach the process stdout/stderr regardless of the host application's log-filtering or redirection setup. The logged `error.message` from `JSON.SyntaxError` may include a snippet of the malformed content, potentially exposing truncated sensitive payload data in server logs.

**Impact:** Sensitive workflow input/output data that corrupts on round-trip through the database could appear in cleartext server logs, creating an inadvertent data-leakage path.

**Remediation:** Thread the injected `Logger` instance into all storage adapters and replace `console.warn` calls in `safeJsonParse` with `logger.warn(...)`. SQLite adapter does not currently accept a logger; add one to its config.

---

### M3 — Publish Pipeline Missing Dependency Audit

**File:** `.github/workflows/publish.yml`

**Description:** The npm publish pipeline (`publish.yml`) runs `build`, `typecheck`, and `test` before publishing to the npm registry, but omits `npm audit`. The `ci.yml` pipeline (which runs on PRs) does include `npm audit --audit-level=high`, but a dependency vulnerability introduced between the last CI run and a release tag would not be caught before the package is published publicly.

**Impact:** A vulnerable dependency version could be shipped in a published npm package, affecting downstream consumers who install it.

**Remediation:** Add `npm audit --audit-level=high` as a mandatory step before `npm publish` in `publish.yml`.

---

## Low Findings

### L1 — Deprecated `transaction()` Accepts Async Callbacks with Unsafe Semantics

**File:** `src/storage/sqlite.ts` — `transaction()` (~line 468)

**Description:** The public method `transaction(fn: (tx) => Promise<T>)` runs async callbacks inside a synchronous `better-sqlite3` transaction. If the callback awaits real async I/O (network, timers), `better-sqlite3` will throw an error at runtime. The method is marked `@deprecated` and documented, but it remains part of the exported `StorageAdapter` interface, giving library consumers a footgun.

**Remediation:** Remove `transaction()` from the public interface in the next major version, or gate it with a runtime check that throws an informative error immediately if the callback returns a pending Promise containing async I/O.

---

### L2 — No HMAC Verification Helper for Incoming Webhooks

**File:** `src/events/webhook.ts`

**Description:** The library sends HMAC-SHA256 signatures on outbound webhook payloads (via `X-Webhook-Signature`), which is good practice. However, no corresponding verification utility is exported. Consumers building bidirectional integrations (e.g. receiving webhooks from external systems and triggering workflows) must implement their own constant-time HMAC verification from scratch.

**Remediation:** Export a `verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean>` helper using `crypto.subtle` with timing-safe comparison.

---

### L3 — `safeJsonParse` Fallback Silently Swallows Database Corruption

**Files:** Multiple storage adapters

**Description:** When a corrupted JSON row is encountered, `safeJsonParse` returns a silent fallback (`{}` or `undefined`) and continues execution. A corrupt `error_json` field would return `undefined`, making a failed run appear to have no error. A corrupt `context_json` would return `{}`, causing a workflow to resume with an empty context, potentially triggering downstream step failures or incorrect results.

**Remediation:** Add an explicit corruption metric/event, and consider propagating the parse error as a dedicated `StorageCorruptionError` to the caller rather than silently degrading.

---

### L4 — RE2 Regex Patterns Accepted from Recipe/Condition Configuration Without Size Limit

**Files:** `src/planning/planner.ts:88`, `src/planning/registry.ts:326`

**Description:** The `matches` condition operator passes the recipe-configured `conditionValue` directly to `new RE2(pattern)`. RE2 is used (mitigating ReDoS), but there is no validation on pattern length or structure. An extremely long or complex RE2 pattern could still consume significant CPU during compilation, and an erroneous pattern simply returns `false` (silently ignored).

**Remediation:** Add a maximum pattern length check (e.g. 1000 characters) and optionally log a warning when an invalid regex is silently swallowed.

---

## Secrets & Credentials Exposure

**No hardcoded secrets, API keys, passwords, or private keys were found** in any source file, configuration file, or committed history.

- `.env` files are correctly excluded via `.gitignore` (entries: `.env`, `.env.local`, `.env.*.local`)
- No `.env` files appear in `git log --all --full-history`
- References to secrets in source code are all documentation examples using `process.env.WEBHOOK_SECRET` and `process.env.DATABASE_URL` — not literal values
- The CI publish workflow stores `NPM_TOKEN` as a GitHub Actions secret (`${{ secrets.NPM_TOKEN }}`), not in any file
- `git grep` across all TypeScript, JSON, YAML, and environment-adjacent files found no credential values

---

## Recommendations

1. **[High — Fix now]** Expand `isBlockedIp()` in `src/events/webhook.ts` to cover all IPv6 private/reserved ranges: ULA (`fc00::/7`), IPv4-mapped (`::ffff:*`), and IPv4-translated (`64:ff9b::`). This closes the residual SSRF bypass path in the DNS-validation layer.

2. **[High — Fix now]** Add a `maxQueueSize` cap to `WebhookEventTransport.enqueueRequest()`. Drop (and log) overflow entries rather than allowing unbounded heap growth. Choose a sensible default (e.g. `maxQueueSize: 1000`) and expose it as a configuration option.

3. **[Medium — Fix before next release]** Add `npm audit --audit-level=high` as a mandatory pre-publish step in `.github/workflows/publish.yml`. This ensures vulnerability checks are never skipped between CI runs and the release tag.

4. **[Medium — Short term]** Replace all `console.warn(...)` calls inside `safeJsonParse()` across the storage and scheduler adapters with calls to an injected `Logger` instance, consistent with the pattern already used in `WebhookEventTransport` and `SocketIOEventTransport`.

5. **[Medium — Short term]** Document the DNS TOCTOU residual risk in `WebhookEventTransport` and provide guidance on network-level egress restrictions as a complementary defense layer. Consider whether connecting directly to the resolved IP (rather than the hostname) is feasible within the Node.js `fetch` API.

6. **[Low — Next major version]** Remove the deprecated `transaction(fn: Promise)` method from the `StorageAdapter` public interface; expose only `transactionSync()`. This eliminates an API footgun for async callbacks inside a synchronous SQLite transaction.

7. **[Low — Backlog]** Export a timing-safe `verifyWebhookSignature(payload, signature, secret)` utility to help consumers correctly verify inbound HMAC-signed webhook payloads without rolling their own potentially timing-vulnerable comparison.

8. **[Low — Backlog]** Propagate `safeJsonParse` failures as a structured `StorageCorruptionError` (or a dedicated log event) rather than silently returning a fallback. Silent fallbacks mask data integrity problems that should alert an operator.

9. **[Low — Backlog]** Add a maximum length guard (e.g. 1000 characters) on regex patterns used in the `matches` condition operator before passing them to `new RE2()`, and log discarded invalid patterns via the logger rather than silently returning `false`.

10. **[Informational]** The security posture of this library is largely a function of how consuming applications configure it — particularly `SocketIOAuthorizeFn` for Socket.IO subscriptions and `allowInsecureUrls` for webhooks. Consider publishing a hardening guide (in `SECURITY.md` or a dedicated doc) covering minimum production configuration requirements, recommended webhook secret rotation practices, and network-level egress controls.