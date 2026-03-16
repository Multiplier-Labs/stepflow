# Security Audit: stepflow

**Date**: 2026-03-18T02:32:51.530Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 9fc99bde-4349-4ae9-8b42-fa6e3a552ac8
**Session**: 9977a792-ceec-4c77-a299-f2ae2b5185ad

---

## Summary

**Overall Risk Rating: Low**
**Audit Date:** 2026-03-18
**Project:** `@multiplier-labs/stepflow` v0.2.6 — TypeScript/Node.js workflow orchestration engine with SQLite/PostgreSQL persistence, Socket.IO real-time events, and HMAC-signed webhooks.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 (2 previously identified, both remediated in commit `b0b822c`) |
| Medium | 1 (new finding: ReDoS risk) |
| Low | 2 (new findings) |
| Secrets/credentials exposed | 0 |
| npm audit vulnerabilities | 0 |

A prior security audit (2026-03-16) identified 10 findings (2 high, 3 medium, 5 low), all of which have been comprehensively remediated. This report documents current standing, verifies remediation, and identifies three new findings discovered during this audit pass.

---

## Critical Findings

None.

---

## High Findings

None.

All previously-identified high findings have been remediated:

| Prior ID | Title | Status | Commit |
|----------|-------|--------|--------|
| H-1 | SSRF in webhook URL handling | Fixed | `b0b822c` |
| H-2 | Rollup path traversal (GHSA-mw96-cpmx-2vgc) | Fixed | `85bf3b5` |

---

## Medium Findings

### M-NEW-1: ReDoS via User-Controlled Regex in Recipe Conditions

**File:** `src/planning/planner.ts` (around the `'matches'` operator branch), `src/planning/registry.ts`

**Description:**
The `'matches'` operator in recipe condition evaluation constructs a `RegExp` directly from a user-supplied string value with no complexity validation:

```typescript
case 'matches':
  if (typeof fieldValue === 'string' && typeof value === 'string') {
    try {
      return new RegExp(value).test(fieldValue);  // 'value' is caller-supplied
    } catch {
      return false;
    }
  }
```

A caller who can supply recipe conditions may provide a catastrophically backtracking pattern (e.g., `(a+)+b`, `([a-z]+)*X`) that causes the Node.js event loop to block for seconds or minutes per evaluation.

**Impact:**
If recipe conditions are accepted from untrusted input (API payloads, configuration files loaded at runtime), an attacker can cause denial of service by submitting a malicious regex. Even in trusted-input scenarios, an accidental complex pattern can stall the event loop.

**Remediation:**
- Use the `re2` npm package (a linear-time regex engine) as a drop-in replacement for `RegExp` where user patterns are evaluated.
- Alternatively, validate the pattern against a blocklist of ReDoS-prone constructs (nested quantifiers, polynomial backreferences) before constructing the `RegExp`.
- At minimum, document the risk and recommend that callers validate regex patterns before including them in recipe conditions.

---

## Low Findings

### L-NEW-1: Error `details` Field May Expose Sensitive Runtime State

**File:** `src/core/types.ts`

**Description:**
`WorkflowError` includes a `details?: Record<string, unknown>` field containing arbitrary error context. While `stack` traces are now stripped before storage (via `sanitizeErrorForStorage()`), the `details` field is not filtered and may contain values such as database query parameters, internal state objects, or filesystem paths that were included for debugging.

**Impact:**
Low — only materialises if callers surface `WorkflowError` objects directly to end users or external API consumers without filtering. No internal serialisation issue.

**Remediation:**
- Add documentation on `WorkflowError.details` noting it may contain sensitive runtime information and should be filtered before returning to untrusted callers.
- Consider a `sanitizeErrorForResponse()` utility (analogous to the existing `sanitizeErrorForStorage()`) that strips or redacts the `details` field.

---

### L-NEW-2: Socket.IO CORS Default Allows Any Origin

**File:** `src/events/socketio.ts`

**Description:**
The Socket.IO adapter accepts the caller-provided `io` server instance and does not document or enforce any CORS policy recommendation. Socket.IO's default CORS setting (`origin: "*"`) permits cross-origin WebSocket connections from any domain. If a consumer deploys the Socket.IO server without explicitly configuring CORS, any webpage can connect to it.

**Impact:**
Low — the library itself does not create the server, so this is a deployment-time concern. However, the absence of any guidance increases the likelihood of misconfigured deployments.

**Remediation:**
Add a JSDoc warning on `SocketIOEventTransport` (or in the README) recommending explicit CORS scoping:

```typescript
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
    credentials: true,
  },
});
```

---

## Secrets & Credentials Exposure

**Result: No secrets or credentials found.**

Checks performed:
- `git grep` across all `*.ts`, `*.js`, `*.json`, `*.yaml`, `*.yml`, `*.env` files for `password`, `secret`, `api_key`, `token`, `private_key` — all matches were either JSDoc examples using `process.env.*` references, test fixtures with clearly synthetic/placeholder values, or type definition strings.
- No `.env` files are tracked in the repository (`.gitignore` correctly excludes `.env*`).
- No Base64-encoded credential blobs detected.
- No AWS access key patterns (`AKIA…`), PEM private key headers, or Bearer token literals found.
- `git log --all --oneline | head -20` reviewed; no commits with credential-suggestive messages.

---

## Recommendations

Ordered by risk impact:

1. **[Medium] Add ReDoS protection for user-supplied regex patterns** (`src/planning/planner.ts`, `src/planning/registry.ts`). Replace `new RegExp(value)` with the `re2` package, or add a structural complexity check before construction. This is the only active code-level vulnerability identified.

2. **[Low] Add `sanitizeErrorForResponse()` utility** mirroring `sanitizeErrorForStorage()`, and document that `WorkflowError.details` must be filtered before returning to untrusted clients. Add an example to the public API docs.

3. **[Low] Document Socket.IO CORS best practices** in the `SocketIOEventTransport` JSDoc and/or README. Include a minimal-privilege example that restricts `origin` to an allowlist.

4. **[Informational] Continue running `npm audit` in CI** on every pull request. Current status is zero vulnerabilities; automated enforcement will prevent regressions as the dependency tree evolves.

5. **[Informational] Consider adding a secrets-scanning step to CI** (e.g., `trufflehog` or `gitleaks`) to catch accidentally committed credentials before they reach the repository history. Current state is clean, but proactive scanning prevents future exposure.

6. **[Informational] Explicitly pin major dependency versions** in `package.json` rather than using caret (`^`) ranges for security-sensitive packages (crypto, database drivers, HTTP libraries) to avoid unexpected upgrades introducing regressions.

7. **[Informational] Review `maxConcurrentRequests` and `maxPayloadBytes` defaults** (`src/events/webhook.ts`) against expected production workloads. The current defaults (50 concurrent, 1 MB payload) are reasonable but may need tuning for high-throughput deployments.

---

## Positive Security Observations

The following areas demonstrate strong security fundamentals:

- **SQL injection — none possible.** All database operations use parameterized prepared statements (better-sqlite3) or Kysely's query builder with `sql.ref()` / `sql.table()` for identifiers. Schema names are validated against `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/` at construction time.
- **No unsafe code execution.** No `eval()`, `new Function()`, `child_process.exec()`, or dynamic `require()` of user-supplied input anywhere in the source tree.
- **Correct HMAC-SHA256 implementation.** Webhook signing uses `crypto.subtle.importKey()` with `extractable: false` and `crypto.subtle.sign()`, both from the Web Crypto API. This is the correct approach and avoids timing side-channels.
- **SSRF fully mitigated.** Webhook URLs are validated at registration for HTTPS scheme, RFC 1918 private ranges, loopback, link-local, and the cloud metadata endpoint (169.254.169.254).
- **TypeScript strict mode enabled** (`"strict": true` in `tsconfig.json`), eliminating implicit `any` and null dereference classes at compile time.
- **Stack traces stripped from persistence.** `sanitizeErrorForStorage()` removes `stack` before writing error objects to the database.
- **Zero npm audit vulnerabilities** at time of audit.