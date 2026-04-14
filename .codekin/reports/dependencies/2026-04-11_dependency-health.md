# Dependency Health Report: stepflow

**Date**: 2026-04-11T02:46:13.072Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 672a3272-e7d7-4127-b865-4e02a47eac94
**Session**: 0b582a44-067e-4ef0-b863-b0cd566a81fd

---

Now I have all the data needed to compile the report.

## Dependency Health Assessment — `@multiplier-labs/stepflow` v0.2.6

_Assessment date: 2026-04-11 | Package manager: **npm** | Lock file: `package-lock.json`_

---

## Summary

| Package Manager | Total Deps | Outdated (direct) | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 296 (12 direct) | 7 | 4 (3 high, 1 moderate) | **HIGH** |

---

## Security Vulnerabilities

| Package | Severity | Advisory | Description | Fixed In |
|---|---|---|---|---|
| `kysely` | **HIGH** (CVSS 8.1) | GHSA-8cpq-38p9-67gx | SQL Injection via insufficient backslash escaping in `sql.lit()` and similar string-literal methods | `0.28.14` |
| `kysely` | **HIGH** (CVSS 8.1) | GHSA-fr9j-6mvq-frcv | SQL Injection via backslash escape bypass in non-type-safe JSON path key usage | `0.28.14` |
| `picomatch` | **HIGH** (CVSS 7.5) | GHSA-c2c7-rcm5-vvqj | ReDoS (Denial of Service) via extglob quantifiers — affects transitive dep from `vitest`/`chokidar` chain | `4.0.4` |
| `vite` | **HIGH** | GHSA-p9ff-h696-f583 | Arbitrary file read via Vite Dev Server WebSocket — transitive dep via `vitest` | `8.0.5` |
| `vite` | **HIGH** | GHSA-v2wj-q39q-566r | `server.fs.deny` access control bypass with query strings — transitive dep via `vitest` | `8.0.5` |
| `vite` | Moderate | GHSA-4w7w-66w2-5vf9 | Path traversal in optimized deps `.map` handling — transitive dep via `vitest` | `8.0.5` |
| `brace-expansion` | Moderate (CVSS 6.5) | GHSA-f886-m6hf-6m8v | Zero-step sequence causes process hang and memory exhaustion — transitive dep | `5.0.5` |
| `picomatch` | Moderate (CVSS 5.3) | GHSA-3v7f-55p6-f55p | Method injection in POSIX character classes causes incorrect glob matching | `4.0.4` |

> **Note:** `kysely` appears as both a `devDependency` and `peerDependency` in this project. The SQL injection issues affect MySQL dialect users specifically; SQLite and PostgreSQL dialects have lower exposure, but upgrading is still critical.

---

## Outdated Dependencies

| Package | Current | Latest | Gap | Type |
|---|---|---|---|---|
| `@types/node` | `22.19.5` | `25.6.0` | 3 major versions | devDependency |
| `typescript` | `5.9.3` | `6.0.2` | 1 major version | devDependency |
| `kysely` | `0.28.12` | `0.28.16` | 4 patches (**security**) | devDependency / peerDependency |
| `re2` | `1.23.3` | `1.24.0` | 1 minor | production dependency |
| `vitest` | `4.1.0` | `4.1.4` | 4 patches (transitive vuln fix) | devDependency |
| `@vitest/coverage-v8` | `4.1.0` | `4.1.4` | 4 patches | devDependency |
| `@types/pg` | `8.18.0` | `8.20.0` | 2 patches | devDependency |

---

## Abandoned / Unmaintained Packages

These are all **transitive dependencies** pulled in via the build/test toolchain (`tsup`, `prebuild-install`, `vitest`). Direct replacement is not possible without upstream action, but they represent long-term risk.

| Package | Installed Version | Est. Last Release | Dependency Path | Notes |
|---|---|---|---|---|
| `any-promise` | `1.3.0` | ~2016 (~10 yrs) | `tsup` → `mz` → `any-promise` | Effectively abandoned; superseded by native Promises |
| `object-assign` | `4.1.1` | ~2017 (~9 yrs) | `tsup` → build chain | Superseded by `Object.assign()` natively in Node.js |
| `file-uri-to-path` | `1.0.0` | ~2017 (~9 yrs) | `bindings` → `file-uri-to-path` | No longer needed for modern Node.js |
| `tunnel-agent` | `0.6.0` | ~2018 (~8 yrs) | `prebuild-install` → `request` chain | `request` itself is deprecated |
| `safe-buffer` | `5.2.1` | ~2020 (~6 yrs) | `readable-stream` → `safe-buffer` | Superseded by native `Buffer` APIs |
| `source-map` | `0.7.6` | ~2021 (~5 yrs) | `sucrase` → `source-map` | Minimal maintenance; `sucrase` is a dev-only tool |

---

## Recommendations

1. **[Critical] Upgrade `kysely` to `≥0.28.14` immediately.** Two HIGH-severity SQL injection vulnerabilities (GHSA-8cpq-38p9-67gx, GHSA-fr9j-6mvq-frcv) affect all versions ≤0.28.13. Update both `devDependencies` and adjust `peerDependencies` range (`"kysely": ">=0.27.0"`) to document the minimum safe version. The fix is available at `0.28.16` (current latest).

2. **[High] Upgrade `vitest` to `≥4.1.4` to pull in patched `vite` (≥8.0.5) and `picomatch` (≥4.0.4).** Three HIGH/moderate vulnerabilities in `vite` (GHSA-p9ff-h696-f583, GHSA-v2wj-q39q-566r, GHSA-4w7w-66w2-5vf9) and two in `picomatch` are fixed by bumping vitest. Although these only run in the dev server context, they pose a real risk in CI or development environments.

3. **[High] Run `npm audit fix` to resolve `brace-expansion` (GHSA-f886-m6hf-6m8v).** This moderate ReDoS/memory-exhaustion vulnerability is in a transitive dep with a straightforward fix available. Running `npm audit fix` should resolve all 4 outstanding advisories once `kysely` and `vitest` are updated first.

4. **[Medium] Upgrade `@types/node` from `22.x` to `24.x` (or `25.x`) in a planned sprint.** The installed version is 3 major versions behind. While `@types/node` bumps rarely break code, staying far behind obscures real type errors and misses new Node.js API typings. Align with the Node.js LTS version in use.

5. **[Medium] Evaluate `TypeScript 6.x` migration.** The project uses `typescript ^5.7.2` while `6.0.2` is now the latest stable release. TypeScript 6 ships breaking changes (notably around module resolution and `erasableSyntaxOnly`). Plan a migration branch to assess impact on the codebase and tsup build config.

6. **[Medium] Update `re2` to `1.24.0`.** `re2` is a **production dependency** — it directly affects the package published to consumers. Patch updates should be applied promptly; `1.24.0` is a minor bump with bug fixes.

7. **[Low] Update peer dependency minimum for `kysely` to `>=0.28.14` in `package.json`.** Even if downstream users manage their own `kysely` install, advertising a range that includes vulnerable versions is irresponsible. Tightening the peer constraint signals the minimum safe version to consumers.

8. **[Low] Audit and potentially remove `prebuild-install` → `tunnel-agent` chain.** `tunnel-agent` is pulled in via `re2`'s native build tooling (`prebuild-install`). Check whether `re2` 1.24.0 still ships prebuilt binaries for all target platforms; if so, `prebuild-install` (and its abandoned transitive deps) may not run at all in production.

9. **[Low] Pin `vitest` and `@vitest/coverage-v8` to matching patch versions** (`4.1.4`). The `^4.1.0` range means CI will auto-install the latest patch, but local developer environments may lag. Lock to a specific version to ensure consistent test environments across machines.

10. **[Informational] No production bundle contamination detected.** All dev dependencies (`vitest`, `tsup`, `typescript`, `@types/*`) are correctly scoped to `devDependencies` and excluded from the published package. The only two production dependencies are `cron-parser` and `re2`, which is appropriately lean for a library.