# Dependency Health Report: stepflow

**Date**: 2026-04-27T09:46:16.032Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 6db344cd-1762-4495-adf1-78b924d7e639
**Session**: e4356f47-4d0d-49dd-b4b3-88a5d4894f14

---

I'll start by detecting package managers and then gather dependency data in parallel.Now I have all the data needed to compile the report.

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 295 | 8 | 0 | **Low** |

**Notes:** 2 direct production dependencies (`cron-parser`, `re2`), 10 direct dev dependencies, 283 transitive. One critical discrepancy: `node_modules/re2` is **out of sync** with `package-lock.json` (installed: 1.23.3 vs. locked: 1.24.0 vs. required: ^1.24.0).

---

## Security Vulnerabilities

No known vulnerabilities detected by `npm audit` as of 2026-04-27.

| Package | Severity | CVE | Description | Fixed In |
|---|---|---|---|---|
| — | — | — | No vulnerabilities found | — |

---

## Outdated Dependencies

Sorted by version-gap significance (major bumps first, then by days since release of current installed version).

| Package | Current | Latest | Age (approx.) | Type |
|---|---|---|---|---|
| `@types/node` | 22.19.5 | 25.6.0 | ~6 months (3 major versions behind) | dev |
| `typescript` | 5.9.3 | 6.0.3 | ~6 months (major version behind; 6.0.3 released 2026-04-16) | dev |
| `re2` | 1.23.3 ⚠️ | 1.24.0 | ~77 days (released 2026-02-09; **INVALID** – violates own `^1.24.0` constraint) | prod |
| `kysely` | 0.28.12 | 0.28.16 | ~3 months (4 patch releases behind) | dev/peer |
| `better-sqlite3` | 12.8.0 | 12.9.0 | ~44 days (released 2026-03-14) | dev/peer |
| `@types/pg` | 8.18.0 | 8.20.0 | ~2 months (2 patch releases behind) | dev |
| `vitest` | 4.1.0 | 4.1.5 | ~5 weeks (5 patch releases behind) | dev |
| `@vitest/coverage-v8` | 4.1.0 | 4.1.5 | ~5 weeks (5 patch releases behind) | dev |

---

## Abandoned / Unmaintained Packages

The following transitive dependencies have had no releases in 2+ years (before 2024-04-27). Most are "stable-by-design" utilities, but they represent supply-chain risk if vulnerabilities emerge.

| Package | Installed Version | Latest Version | Last Release | Pull Path |
|---|---|---|---|---|
| `fs-constants` | 1.0.0 | 1.0.0 | 2022-05-02 (4.0 yrs) | re2 → tar-fs → fs-constants |
| `mkdirp-classic` | 0.5.3 | 0.5.3 | 2022-05-09 (4.0 yrs) | re2 → tar-fs → mkdirp-classic |
| `pg-int8` | 1.0.1 | 1.0.1 | 2022-05-12 (4.0 yrs) | pg → pg-types → pg-int8 |
| `any-promise` | 1.3.0 | 1.3.0 | 2022-06-13 (3.9 yrs) | tsup → sucrase → mz → any-promise |
| `postgres-date` | 1.0.7 | 2.1.0 | 2022-06-24 (3.8 yrs) | pg → pg-types → postgres-date (outdated version locked by pg-types) |
| `tunnel-agent` | 0.6.0 | 0.6.0 | 2022-06-27 (3.8 yrs) | re2 → prebuild-install → tunnel-agent |
| `github-from-package` | 0.0.0 | 0.0.0 | 2022-11-11 (3.4 yrs) | re2 → prebuild-install → github-from-package |
| `inherits` | 2.0.4 | 2.0.4 | 2023-06-09 (2.9 yrs) | pg → readable-stream → inherits |
| `wrappy` | 1.0.2 | 1.0.2 | 2023-06-22 (2.8 yrs) | npm internals → once → wrappy |
| `resolve-from` | 5.0.0 | 5.0.0 | 2023-06-22 (2.8 yrs) | tsup → sucrase → resolve-from |
| `safe-buffer` | 5.2.1 | 5.2.1 | 2023-07-10 (2.8 yrs) | pg → readable-stream → safe-buffer |
| `xtend` | 4.0.2 | 4.0.2 | 2023-07-10 (2.8 yrs) | pg → readable-stream → xtend |
| `ts-interface-checker` | 0.1.13 | 1.0.2 | 2023-07-22 (2.8 yrs) | tsup → sucrase → ts-interface-checker (outdated minor version) |

---

## Additional Issues

### node_modules / lockfile out of sync
`package-lock.json` records `re2@1.24.0` and `package.json` requires `^1.24.0`, but the installed `node_modules/re2` is `1.23.3`. npm itself reports this as `invalid`. Running `npm ci` will resolve this.

### Dev dependencies in production bundle
The `tsup.config.ts` does not call `noExternal`, so tsup treats `node_modules` as external by default. `cron-parser` and `re2` ship as peer runtime deps (externalized), and dev deps (`vitest`, `typescript`, etc.) are not bundled. **No dev-dependency leakage detected.**

### Native module risk (`re2`, `better-sqlite3`)
Both production dep `re2` and peer dep `better-sqlite3` are native Node.js addons compiled with `node-gyp`. They use `prebuild-install` to download pre-built binaries, which introduces supply-chain surface area (GitHub artifact fetching at install time). The `tunnel-agent`, `github-from-package`, and `prebuild-install` chain is entirely driven by these native deps.

---

## Recommendations

1. **Run `npm ci` immediately** — node_modules is out of sync with the lockfile. `re2@1.23.3` is installed but `^1.24.0` is required and locked at `1.24.0`. This is an invalid state that could cause subtle runtime differences from what the lockfile guarantees.

2. **Evaluate TypeScript 6.0 upgrade** — TypeScript 6.0.3 was released 2026-04-16. This is a major version with potential breaking changes in type resolution and strict mode. Assess the changelog against this codebase and schedule a planned upgrade rather than leaving the project on a stale major version.

3. **Update `@types/node` to v22 latest within the declared range first, then plan v25 migration** — The installed `22.19.5` is far behind both the latest in-range `22.19.17` and the latest overall `25.6.0`. Update the range in `package.json` to `^22` to get `22.19.17` immediately; evaluate whether Node.js 24/25 runtime support is needed for the `^25` types.

4. **Apply all patch-level updates in one batch** — `kysely` (0.28.12 → 0.28.16), `better-sqlite3` (12.8.0 → 12.9.0), `vitest` + `@vitest/coverage-v8` (4.1.0 → 4.1.5), and `@types/pg` (8.18.0 → 8.20.0) are all safe patch bumps. Run `npm update` and commit the updated lockfile.

5. **Add `npm ci` to CI/CD pipeline** — Use `npm ci` (not `npm install`) in all CI environments to guarantee the lockfile is authoritative. The current re2 mismatch would have been caught immediately.

6. **Monitor `ts-interface-checker` upgrade path** — The installed version `0.1.13` is two major releases behind (latest `1.0.2`). This is a `sucrase` dependency; when `sucrase` updates to require the newer version, it may pull in breaking changes. Track the `sucrase` changelog.

7. **Evaluate replacing `sucrase` dependency chain** — `tsup` uses `sucrase` for dev-time TypeScript transforms, which carries several stale transitive deps (`any-promise`, `ts-interface-checker`, `resolve-from`, `mz`, `thenify`). Check whether the current `tsup@8.x` / `esbuild@0.27` setup can run without `sucrase`, or whether upgrading tsup eliminates it.

8. **Track `postgres-date` version locked by `pg-types`** — The installed `postgres-date@1.0.7` (last updated 2022) is well behind the current `2.1.0`. This is controlled by `pg-types`'s own dependency range. When upgrading `pg` to a future major, verify that `pg-types` pulls in the modern `postgres-date`.

9. **Pin native module versions in CI artifacts** — Because `re2` and `better-sqlite3` download pre-built binaries from GitHub at install time (via `prebuild-install`), a supply-chain compromise of those GitHub release artifacts would be invisible to `npm audit`. Consider committing pre-built `.node` binaries to a private artifact store or using `--ignore-scripts` with explicit binary verification in security-sensitive deployments.

10. **Set a recurring dependency review cadence** — The project has zero vulnerabilities today, but several deep transitive deps (especially in the `prebuild-install`/`tunnel-agent` chain) are fully frozen. Schedule a quarterly `npm audit` + `npm outdated` review to catch CVEs before they accumulate.