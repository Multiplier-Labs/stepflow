# Documentation Audit: stepflow

**Date**: 2026-04-27T09:47:59.641Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 08c3ea17-7cb5-4125-996a-39c35677be95
**Session**: f433bd66-7a11-47de-8d7c-ded74e1d801c

---

I have the full exploration results. Let me verify a few specific claims before writing the report.Now I have all the data I need to write the report.

```markdown
## Summary

**Total documentation files:** 5 user-facing files — 2,266 lines across `README.md`, `CHANGELOG.md`, `SECURITY.md`, `docs/github-packages-setup.md`, and `docs/stepflow-api-reference.md`. A `.codekin/reports/` directory contains automated analysis reports (not user-facing docs; excluded from this audit).

**Files needing attention:** 4 of 5

**Key findings:**
- The repository moved from GitHub Packages to npmjs.com (confirmed by `package.json publishConfig` and `.github/workflows/publish.yml`), but `README.md` still advertises GitHub Packages and `docs/github-packages-setup.md` remains entirely oriented around the old registry. Any new user following the README's installation guidance will be directed to incorrect authentication instructions.
- `CHANGELOG.md` only documents releases up to v0.2.6 (2026-04-03). The package is now at v0.3.3 with multiple significant reliability and security fixes; three minor versions are completely undocumented.
- `SECURITY.md` lists only `0.2.x` as the supported version; v0.3.x is absent from the table.
- `docs/stepflow-api-reference.md` is high-quality and was updated in the most recent fix cycle (2026-04-13), but the public `ConsoleLogger` constructor's optional `level: LogLevel` parameter goes undocumented, and the `WebhookEventTransport` docs do not mention the per-call `AbortController` timeout and short-TTL DNS cache added in commit `29dc877` (2026-04-14).

**Health rating: Needs cleanup.** The API reference is excellent; everything else has drifted.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|---------------|---------|--------|
| `README.md` | 432 | 2026-04-11 | Project overview, installation, quick-start, feature tour, links to detailed docs | Stale |
| `CHANGELOG.md` | 34 | 2026-04-11 | Version history following Keep a Changelog format | Stale |
| `SECURITY.md` | 40 | 2026-04-11 | Vulnerability reporting, disclosure policy, security practices | Stale |
| `docs/github-packages-setup.md` | 97 | 2026-04-11 | Publishing and installing from GitHub Packages npm registry | Outdated |
| `docs/stepflow-api-reference.md` | 1,663 | 2026-04-13 | Complete API reference for all public modules | Current (minor gap) |

---

## Staleness Findings

### 1. README.md — Installation section (line 18) references a superseded registry

> "This package is published to GitHub Packages. See [docs/github-packages-setup.md](docs/github-packages-setup.md) for authentication setup."

`package.json` contains:
```json
"publishConfig": { "registry": "https://registry.npmjs.org" }
```
`.github/workflows/publish.yml` sets `registry-url: 'https://registry.npmjs.org'` and authenticates via `NPM_TOKEN` (not `GITHUB_TOKEN` / `read:packages`). The `npm install @multiplier-labs/stepflow` command on line 21 will work from npmjs.com without any authentication, but the sentence above it sends users to an authentication guide for the wrong registry. The `.github/workflows/publish.yml` workflow is also misnamed ("Publish to GitHub Packages") despite targeting npmjs.org.

**Last meaningful code change that triggered this drift:** commit `c0a79d2` / `76dc80f` (2026-04-11) wired up the publish workflow to npmjs.org but the prose was not updated.

### 2. CHANGELOG.md — Three releases unrecorded

Current package version is `0.3.3`. The changelog documents only `[0.2.6] - 2026-04-03` plus a partial `[Unreleased]` block. Commits `f7cacfa`, `29dc877`, and `f08cde3` (2026-04-11 through 2026-04-14) include: critical reliability fixes to storage adapters (JSON parse safety), race-condition fix in `waitForRun()`, timer-leak fixes in `shutdown()`, `WaitForRunTimeoutError` addition, per-call webhook timeout via `AbortController`, DNS cache with short TTL, and cron-expression validation on startup. None of these appear under any versioned heading.

### 3. SECURITY.md — Supported-versions table stops at 0.2.x

```
| 0.2.x   | Yes |
| < 0.2   | No  |
```

v0.3.x is omitted entirely. Users on v0.3.3 cannot determine from this table whether they are running a supported release.

### 4. docs/github-packages-setup.md — Entire file describes decommissioned workflow

The file instructs users to:
- Configure `.npmrc` with `@multiplier-labs:registry=https://npm.pkg.github.com`
- Generate a Personal Access Token with `read:packages` scope
- Authenticate via `npm login --registry=https://npm.pkg.github.com`
- Use `NODE_AUTH_TOKEN` in CI pointing to a PAT

None of these steps are needed or correct for a public package on npmjs.com. The CI section (`registry-url: 'https://npm.pkg.github.com'`) contradicts the actual `publish.yml`.

### 5. docs/stepflow-api-reference.md — Webhook transport description predates AbortController addition

Commit `29dc877` (2026-04-14) added per-call request timeouts via `AbortController` and a short-TTL DNS resolution cache to `src/events/webhook.ts`. The `WebhookEventTransport` section in the API reference was last modified 2026-04-13 and does not describe either behaviour. This is a minor omission for an internal reliability mechanism, but users who encounter timeout behaviour may not find it in the reference.

---

## Accuracy Issues

### 1. `ConsoleLogger` — undocumented `level` parameter

The API reference shows:
```typescript
const logger = new ConsoleLogger('[my-app]');  // default prefix: '[workflow]'
```
The actual constructor signature in `src/utils/logger.ts` is:
```typescript
constructor(prefix = '[workflow]', level: LogLevel = 'info')
```
The `LogLevel = 'debug' | 'info' | 'warn' | 'error'` type is exported from `@multiplier-labs/stepflow` (confirmed in `src/index.ts`) but neither the type itself nor the second constructor parameter appear anywhere in the API reference's Logger section.

### 2. `WorkflowStorage` vs `StorageAdapter` — no guidance on which to implement

The TypeScript types section lists both interfaces without explaining that `WorkflowStorage` is the current recommended interface and `StorageAdapter` is the narrower legacy surface. The distinction is load-bearing for implementors: `StorageAdapter` lacks `dequeueRun`, `cleanupStaleRuns`, `getStepResult`, and other methods present on `WorkflowStorage`. A comment in `src/storage/types.ts` marks `StorageAdapter.transaction()` as `@deprecated`. The docs are silent on all of this.

### 3. `publish.yml` workflow name vs actual registry

While not a documentation file itself, the workflow named `"Publish to GitHub Packages"` publishes to `registry.npmjs.org`. This inconsistency compounds the README error: if a developer checks the workflow file while troubleshooting installation, the name reinforces the wrong mental model.

---

## Overlap & Redundancy

No meaningful content overlap exists across the five files. Each occupies a distinct purpose:

- `README.md` — orientation and quick-start
- `CHANGELOG.md` — version history
- `SECURITY.md` — security policy
- `docs/github-packages-setup.md` — package registry operations runbook
- `docs/stepflow-api-reference.md` — full API reference

`docs/github-packages-setup.md` does overlap with the "Installation" section of `README.md` in the sense that both claim to describe how to install the package — but with contradictory registries, not duplicated content. The resolution is to update `README.md` and either delete or replace `docs/github-packages-setup.md`, not to merge them.

---

## Fragmentation

No fragmentation issues. The three-file docs layout (README + setup guide + API reference) is appropriately proportioned for a single-package library of this size.

The `.codekin/reports/` automated reports (`code-review/`, `comments/`, `complexity/`, `coverage/`, `dependencies/`, `docs-audit/`, `security/`) are point-in-time machine-generated artifacts, not developer documentation. Previous doc-audit reports (2026-04-04, 2026-04-11, 2026-04-13) confirm an active audit cadence but are themselves not part of the user-facing doc set.

No proposal, spec, or design documents describing completed work were found. `docs/stepflow-postgresql-spec.md` was already deleted (commit `df2d237`, 2026-03-19) and merged into the API reference — correct prior action.

---

## Action Items

### Delete

| File | Reason it is safe to delete |
|------|-----------------------------|
| `docs/github-packages-setup.md` | Describes GitHub Packages authentication which is no longer the distribution channel. Every instruction is wrong for the actual npmjs.com registry. No content is worth salvaging; public packages on npmjs.com require no special auth. If a replacement is needed, a 5-line note in README suffices. |

### Consolidate

| Source files | Target file | What to keep / drop |
|-------------|-------------|---------------------|
| *(none)* | — | No consolidation needed; current file structure is appropriate for this repo's scale. |

### Update

| File | Section needing update | What changed in the codebase |
|------|------------------------|------------------------------|
| `README.md` | Installation (line 18) | Replace "published to GitHub Packages" with "published to npm" and remove the link to `docs/github-packages-setup.md` (or update the link to point to npmjs.com). Remove GitHub Packages authentication instructions; a bare `npm install @multiplier-labs/stepflow` is sufficient. |
| `CHANGELOG.md` | Add `[0.3.0]`–`[0.3.3]` entries | Significant changes since v0.2.6: `WaitForRunTimeoutError` error class; JSON parse safety in all storage/scheduler adapters; `waitForRun()` race-condition fix; `shutdown()` timer-handle cleanup; per-call `AbortController` timeout in webhook transport; short-TTL DNS resolution cache in webhook transport; cron-expression validation on startup; dependency vulnerability resolutions. |
| `SECURITY.md` | Supported Versions table | Add row `\| 0.3.x \| Yes \|`; current package is v0.3.3. |
| `docs/stepflow-api-reference.md` | WebhookEventTransport section | Document that each outbound webhook request uses a per-call `AbortController` for timeout enforcement, and that DNS resolution results are cached with a short TTL to prevent DNS rebinding between resolution and connection. |
| `docs/stepflow-api-reference.md` | Logger section (ConsoleLogger) | Document the optional `level: LogLevel` second constructor parameter and export the `LogLevel = 'debug' \| 'info' \| 'warn' \| 'error'` type. |
| `.github/workflows/publish.yml` | Workflow `name:` field (not a doc, but affects discoverability) | Rename from `"Publish to GitHub Packages"` to `"Publish to npm"` to match the actual registry. |

---

## Recommendations

1. **Fix README.md installation text immediately.** The current wording actively misleads new users toward a broken setup flow. A one-line change — "published to npm" instead of "published to GitHub Packages" — plus removal of the github-packages-setup link, unblocks onboarding.

2. **Delete `docs/github-packages-setup.md`.** The file has no salvageable content for the current registry. If a minimal "installing from npm" guide is needed, two or three lines in the README are sufficient; a dedicated file would be disproportionate.

3. **Backfill CHANGELOG.md with v0.3.0–v0.3.3 entries.** The changelog is the first place users and downstream maintainers look when upgrading. Three unreleased minor versions with security and reliability fixes represent meaningful omissions. Commit messages from `f7cacfa`, `29dc877`, and `f08cde3` provide ready-made content.

4. **Update SECURITY.md supported-versions table.** Add `0.3.x → Yes`. This is a two-line edit but directly affects whether security researchers and enterprise evaluators consider the project active.

5. **Document `ConsoleLogger(prefix, level)` and the `LogLevel` type export** in `docs/stepflow-api-reference.md`. The level parameter is useful for suppressing debug noise in production; its absence from the docs makes it an accidental hidden feature.

6. **Add a brief note on `WebhookEventTransport` timeout and DNS-cache behaviour** to `docs/stepflow-api-reference.md`. Users integrating webhooks in strict network environments benefit from knowing these protections exist.

7. **Rename the publish workflow** from "Publish to GitHub Packages" to "Publish to npm" to eliminate the naming inconsistency that reinforces the stale README text.

8. **Add a `CHANGELOG.md` update reminder to the publish workflow** (e.g., a pre-publish CI check or a `CONTRIBUTING.md` note) so future releases do not reach npm without a corresponding changelog entry.

9. **Clarify `StorageAdapter` vs `WorkflowStorage`** in the TypeScript types section of the API reference. One sentence noting that `StorageAdapter` is the legacy narrow interface, `WorkflowStorage` is the current recommended interface, and `StorageAdapter.transaction()` is deprecated will prevent implementors from building against the wrong surface.

10. **Keep the five-file doc structure.** With the GitHub Packages file removed, the set becomes four purposeful files (README, CHANGELOG, SECURITY, API reference) which is a clean, proportional structure for a single-package library. Resist splitting the API reference until it substantially exceeds 2,000 lines or the audience clearly segments by module.
```