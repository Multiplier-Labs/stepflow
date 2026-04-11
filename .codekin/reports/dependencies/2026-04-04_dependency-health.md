# Dependency Health Report: stepflow

**Date**: 2026-04-04T06:58:47.515Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: caf445eb-aa6a-4887-a75d-0068f9ea47ac
**Session**: 40a62583-ab64-444b-be60-b6caef82eab5

---

Now I have all the data needed. Here is the full dependency health assessment:

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 296 | 7 | 3 (2 high, 1 moderate) | **High** |

**Notes:** 296 total installed packages (64 prod, 231 dev, 87 optional). Direct production dependencies: `cron-parser`, `re2`. Direct devDependencies: 10 packages. Peer dependencies: `better-sqlite3`, `kysely`, `pg`.

---

## Security Vulnerabilities

| Package | Severity | Advisory | Description | Fixed In |
|---|---|---|---|---|
| `kysely` | **HIGH** (CVSS 8.1) | [GHSA-8cpq-38p9-67gx](https://github.com/advisories/GHSA-8cpq-38p9-67gx) | MySQL SQL Injection via insufficient backslash escaping in `sql.lit(string)` and similar string-literal methods | `>=0.28.14` |
| `kysely` | **HIGH** (CVSS 8.1) | [GHSA-fr9j-6mvq-frcv](https://github.com/advisories/GHSA-fr9j-6mvq-frcv) | MySQL SQL Injection via backslash escape bypass in non-type-safe JSON path key usage | `>=0.28.14` |
| `picomatch` | **HIGH** (CVSS 7.5) | [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) | ReDoS vulnerability via extglob quantifiers — denial-of-service via malicious glob patterns (indirect dep of `chokidar`/`tsup`) | `>=4.0.4` |
| `brace-expansion` | **MODERATE** (CVSS 6.5) | [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v) | Zero-step sequence (e.g. `{1..0}`) causes process hang and memory exhaustion (indirect dep) | `>=5.0.5` |
| `picomatch` | MODERATE (CVSS 5.3) | [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) | Method injection via POSIX character classes causing incorrect glob matching (indirect dep of `chokidar`/`tsup`) | `>=4.0.4` |

**Scope assessment:** The `kysely` vulnerabilities are in a peer dependency used for the PostgreSQL/MySQL adapter path. They affect MySQL dialect users who pass unsanitised input via `sql.lit()` or JSON path keys. SQLite users are not affected. The `picomatch` and `brace-expansion` issues are in dev toolchain transitive deps (`tsup` → `chokidar`) and do not affect the published package.

---

## Outdated Dependencies

| Package | Current | Latest | Age of Current | Type |
|---|---|---|---|---|
| `@types/node` | 22.19.5 | 25.5.2 | ~84 days (3 major versions behind) | devDependency |
| `typescript` | 5.9.3 | 6.0.2 | — (1 major version behind; v6 released 2026-03-23) | devDependency |
| `re2` | 1.23.3 | 1.24.0 | ~54 days (released 2026-02-09) | dependency (prod) |
| `kysely` | 0.28.12 | 0.28.15 | ~22 days (released 2026-03-13) | peerDependency / devDependency |
| `vitest` | 4.1.0 | 4.1.2 | ~23 days (released 2026-03-12) | devDependency |
| `@vitest/coverage-v8` | 4.1.0 | 4.1.2 | ~23 days | devDependency |
| `@types/pg` | 8.18.0 | 8.20.0 | — (2 minor versions behind) | devDependency |

---

## Abandoned / Unmaintained Packages

All items below are **transitive/indirect** dependencies — none are direct. Most trace back to the `prebuild-install` → `node-pre-gyp` chain used by `better-sqlite3` and `re2` for native addon installation.

| Package | Installed Version | Last npm Publish | Age |
|---|---|---|---|
| `any-promise` | 1.3.0 | 2022-06-13 | ~3.8 years |
| `tunnel-agent` | 0.6.0 | 2022-06-27 | ~3.8 years |
| `util-deprecate` | 1.0.2 | 2022-06-28 | ~3.8 years |
| `thenify` | 3.3.1 | 2022-06-27 | ~3.8 years |
| `github-from-package` | 0.1.1 | 2022-11-11 | ~3.4 years |
| `deep-extend` | 0.6.0 | 2023-07-10 | ~2.7 years |
| `safe-buffer` | 5.2.1 | 2023-07-10 | ~2.7 years |
| `bindings` | 1.5.0 | 2023-07-10 | ~2.7 years |
| `file-uri-to-path` | 2.0.0 | 2023-07-10 | ~2.7 years |
| `mz` | 2.7.0 | 2023-11-07 | ~2.4 years |

These packages are effectively stable and in maintenance-only mode (no API surface changes expected). Their abandonment is low operational risk, but they represent supply-chain exposure if they are ever compromised on npm.

---

## Recommendations

1. **[CRITICAL] Update `kysely` to `>=0.28.14` immediately.** Two high-severity SQL injection CVEs (GHSA-8cpq-38p9-67gx, GHSA-fr9j-6mvq-frcv) affect all versions `<=0.28.13`. The fix is available in `0.28.15` (released 2026-03-31). Since `kysely` is a peer dependency, consumers must update their own `kysely` version; update the peer/dev dep range floor in `package.json` to `>=0.28.14` and run `npm install` to update the lockfile.

2. **[HIGH] Update `picomatch` to `>=4.0.4`.** Two CVEs (ReDoS GHSA-c2c7-rcm5-vvqj at CVSS 7.5, method injection GHSA-3v7f-55p6-f55p) are present in the installed `4.0.x` range. This is pulled in transitively by `tsup`/`chokidar`. Run `npm update picomatch` or update `chokidar` when a version that pins `picomatch>=4.0.4` is released.

3. **[MODERATE] Update `brace-expansion` to `>=5.0.5`.** The installed range `4.0.0–5.0.4` is vulnerable to a process-hanging ReDoS (GHSA-f886-m6hf-6m8v, CVSS 6.5). Run `npm update brace-expansion` to pull in the patched version.

4. **[HIGH] Plan migration to TypeScript 6.** TypeScript 6.0.2 is now available and includes breaking changes (stricter inference, removed deprecated emit options). Schedule an upgrade cycle: run `tsc` against the new compiler on a branch, address any new type errors, then merge. TypeScript 5.9 will not receive bug fixes once support ends.

5. **[MEDIUM] Update `@types/node` from `22.x` to `22.x` latest (semver-wanted), and plan a roadmap to `25.x`.** The installed version (`22.19.5`) is 3 major type-definition versions behind `25.5.2`. While types don't affect runtime, using stale `@types/node` means missing Node.js API types and incorrect/missing signatures for newer APIs. Update to the wanted `22.19.17` now, then evaluate a bump to `24.x` or `25.x` after the TypeScript 6 migration.

6. **[MEDIUM] Update `re2` to `1.24.0`.** The production `re2` package (a direct dependency) has a new minor release. As a native addon that is loaded at runtime, staying current ensures compatibility with newer Node.js ABI versions and any security fixes in the C++ RE2 library.

7. **[LOW] Update `vitest` and `@vitest/coverage-v8` to `4.1.2`.** These are patch releases that likely include bug fixes. They are low-risk to update (`npm update vitest @vitest/coverage-v8`) and should be kept in sync since mismatched versions can cause coverage reporting failures.

8. **[LOW] Audit the `prebuild-install` dependency chain.** Ten transitive packages in the native addon prebuilt-install chain (`tunnel-agent`, `any-promise`, `github-from-package`, etc.) have not been published in 2–4 years. Consider whether `better-sqlite3` or `re2` have moved to alternative install mechanisms that shed these deps, and upgrade those packages to their latest versions to reduce supply-chain surface area.

9. **[INFO] Verify `kysely` peer dependency minimum version in `package.json`.** The current `peerDependencies` floor is `>=0.27.0`, which includes the now-vulnerable range `<=0.28.13`. Update the peer dep constraint to `>=0.28.14` to prevent downstream consumers from inadvertently installing a vulnerable version of `kysely` when using this library.

10. **[INFO] Consider replacing `tunnel-agent` and `safe-buffer` transitive deps long-term.** Both are effectively superseded by Node.js built-ins (`https.Agent` and `Buffer` respectively). They persist only as transitive deps of `prebuild-install`. File upstream issues or switch to alternative prebuilt strategies (e.g., `node-gyp-build` with bundled binaries) if those deps cannot be shed through normal upgrades.