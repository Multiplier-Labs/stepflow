# Dependency Health Report: stepflow

**Date**: 2026-03-18T02:20:05.603Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: b15f844a-314b-4293-9627-7c92d87f4e0e
**Session**: 81ec2527-48cf-4402-b4fb-4c9874f56010

---

Now I have all the data needed to write the report.## Dependency Health Assessment Report — `@multiplier-labs/stepflow`

**Date:** 2026-03-18  
**Package Manager:** npm (lock file version 3)

---

## Summary

| Package Manager | Total Deps | Outdated (direct) | Outdated (transitive) | Vulnerabilities | Risk Level |
|---|---|---|---|---|---|
| npm | 239 total (3 prod, 237 dev/optional) | 1 (`@types/node`) | 15+ | 0 | **Low** |

All direct runtime production dependencies (`cron-parser@5.5.0`, `luxon@3.7.2` as a transitive prod dep) are at their current versions. The single direct dev dependency that is outdated is `@types/node`, which lags three major versions behind. All other outdated packages are deep transitive dependencies pulled in by build/test tooling (`prebuild-install` → `tar-fs` → `bl`, `pg` → `pg-types` → `postgres-*`, etc.) and are **not included in the published bundle**.

---

## Security Vulnerabilities

| Package | Severity | CVE | Description | Fixed In |
|---|---|---|---|---|
| — | — | — | No known vulnerabilities detected by `npm audit` | — |

`npm audit` reports **0 vulnerabilities** across all 239 installed packages as of 2026-03-18. There are no critical or high CVEs to remediate.

---

## Outdated Dependencies

Sorted by age of installed version, descending. Transitive deps are marked with their nearest direct-dep parent.

| Package | Current | Latest | Published (current) | Latest Version Age | Type |
|---|---|---|---|---|---|
| `strip-json-comments` | 2.0.1 | 5.0.3 | Feb 2016 | ~10 years behind | dev transitive (`rc` dep) |
| `file-uri-to-path` | 1.0.0 | 2.0.0 | Jul 2017 | ~9 years behind | dev transitive (`bindings` dep) |
| `pg-int8` | 1.0.1 | 1.0.1 | Nov 2017 | Current but inactive | dev transitive (`pg-types` dep) |
| `postgres-interval` | 1.2.0 | 4.0.2 | Feb 2019 | ~7 years behind | dev transitive (`pg-types` dep) |
| `has-flag` | 4.0.0 | 5.0.1 | Apr 2019 | ~7 years behind | dev transitive (`supports-color` dep) |
| `postgres-array` | 2.0.0 | 3.0.4 | Oct 2018 | ~7 years behind | dev transitive (`pg-types` dep) |
| `chownr` | 1.1.4 | 3.0.0 | Feb 2020 | ~6 years behind | dev transitive (`tar-fs` dep) |
| `postgres-date` | 1.0.7 | 2.1.0 | Aug 2020 | ~5.5 years behind | dev transitive (`pg-types` dep) |
| `supports-color` | 7.2.0 | 10.2.2 | Aug 2020 | ~5.5 years behind | dev transitive (`debug` dep) |
| `tar-stream` | 2.2.0 | 3.1.8 | Dec 2020 | ~5.3 years behind | dev transitive (`tar-fs` dep) |
| `ini` | 1.3.8 | 6.0.0 | Dec 2020 | ~5.3 years behind | dev transitive (`rc` dep) |
| `bl` | 4.1.0 | 6.1.6 | Feb 2021 | ~5 years behind | dev transitive (`tar-stream` dep) |
| `nanoid` | 3.3.11 | 5.1.7 | Mar 2025 | ~12 months behind | dev transitive (`vitest` dep) |
| `tar-fs` | 2.1.4 | 3.1.2 | Sep 2025 | ~6 months behind | dev transitive (`prebuild-install` dep) |
| `acorn` | 8.15.0 | 8.16.0 | Jun 2025 | ~9 months behind | dev transitive |
| `semver` | 7.7.3 | 7.7.4 | Oct 2025 | ~5 months behind | dev transitive |
| `esbuild` | 0.27.2 | 0.27.4 | Dec 2025 | ~3 months behind | dev transitive (`tsup` dep) |
| `postgres-bytea` | 1.0.1 | 3.0.0 | Dec 2025 | 2 major versions | dev transitive (`pg-types` dep) |
| `@types/node` | 22.19.5 | 25.5.0 | Jan 2026 | 3 majors behind | **direct dev dep** |
| `@types/better-sqlite3` | 7.6.13 | 7.6.13 | — | Current ✓ | direct dev dep |

**Note:** All packages in the table above that are transitive dev dependencies will **not** appear in the published npm package bundle. They affect only the local development, testing, and build environment.

---

## Abandoned / Unmaintained Packages

Packages with no npm registry activity for 2 or more years (cutoff: 2024-03-18). All are transitive dev dependencies.

| Package | Installed | Last Activity | Age | Direct Parent | Notes |
|---|---|---|---|---|---|
| `github-from-package` | 0.0.0 | 2022-11-11 | ~3.4 years | `prebuild-install` | Version `0.0.0` — never formally released; likely a placeholder. No successor project. |
| `mkdirp-classic` | 0.5.3 | 2022-05-09 | ~4 years | `prebuild-install`, `tar-fs@2` | Superseded by `mkdirp@3` which is built into Node.js `fs.mkdir`. |
| `pg-int8` | 1.0.1 | 2022-05-12 | ~4 years | `pg-types@2` | Tiny utility; functionally complete but unmaintained. |
| `tunnel-agent` | 0.6.0 | 2022-06-27 | ~3.7 years | `prebuild-install` | Deprecated in favour of native `https.Agent`. No CVEs currently. |
| `postgres-date` | 1.0.7 (latest: 2.1.0) | 2022-06-24 | ~3.7 years | `pg-types@2` | A v2 exists but `pg-types@2` pins the old v1 range. Resolved by upgrading `pg` to a release that uses `pg-types@4`. |
| `deep-extend` | 0.6.0 | 2023-07-10 | ~2.7 years | `rc` | Functionally stable; no recent CVEs. |
| `bindings` | 1.5.0 | 2023-07-10 | ~2.7 years | `better-sqlite3` (native binding loader) | Stable native-addon loader; no active successor. |
| `wrappy` | 1.0.2 | 2023-06-22 | ~2.7 years | `once` → `prebuild-install` | Trivial wrapper utility; functionally complete. |
| `inherits` | 2.0.4 | 2023-06-09 | ~2.8 years | `readable-stream` | ES5-era prototype inheritance shim; superseded by native `class extends`. |

**Root cause pattern:** The `prebuild-install` chain (`prebuild-install` → `tar-fs@2` → `tar-stream@2` → `bl@4` → `mkdirp-classic` → `github-from-package` → `tunnel-agent`) collectively drags in the majority of old/unmaintained packages. Upgrading `prebuild-install` or migrating away from it would clean up many of these entries at once.

---

## Recommendations

1. **Upgrade `@types/node` to `^24` or `^25`** *(direct dev dep, semver-safe in dev)*  
   The installed `22.19.5` satisfies `^22` but the latest is `25.5.0`. Node.js 22 enters LTS maintenance mode in 2026 and Node.js 24 is the current Active LTS. Update `package.json` to `"@types/node": "^24.0.0"` (or `^25`) and run `npm install`. This is the only directly actionable outdated direct dependency; all others are already current.

2. **Update `better-sqlite3` to track its latest release automatically**  
   The installed dev version is `12.8.0` which matches the latest. However, `better-sqlite3` uses native bindings and pulls in the unmaintained `prebuild-install` → legacy tar/archive chain. Monitor the [better-sqlite3 changelog](https://github.com/WiseLibs/better-sqlite3) for a move to `@mapbox/node-pre-gyp` or a binaries-in-package approach, which would eliminate the `prebuild-install` / `tunnel-agent` / `mkdirp-classic` / `github-from-package` subtree entirely.

3. **Track `pg` major releases to shed old `pg-types@2` transitive deps**  
   The devDep `pg@8.20.0` depends on `pg-types@2`, which in turn pins `postgres-date@1.x`, `postgres-interval@1.x`, `postgres-array@2.x`, and `pg-int8@1.x` — all 3–7 years behind their latest majors. `pg@9` (not yet released) or a future patch of `pg@8` may adopt `pg-types@4`. Watch the [`pg` release notes](https://github.com/brianc/node-postgres) and upgrade `pg` in `devDependencies` when a version that pulls in `pg-types@3` or `@4` becomes available.

4. **Replace the `rc` dev transitive dependency by updating `prebuild-install`**  
   `rc@1.2.8` brings in `strip-json-comments@2.0.1` (a 10-year-old version; current is `5.0.3`) and `ini@1.3.8` (5+ years behind; current is `6.0.0`). This entire chain originates from `prebuild-install`, which is a build-only dependency of `better-sqlite3`. Since `ini@<2.0.0` had a prototype pollution CVE (now patched in `ini@1.3.8`), the current installed version is safe, but the lineage is concerning for future CVEs. Mitigated by item 2 above.

5. **Pin `nanoid` to `^5` via a direct `overrides` entry if vitest falls behind**  
   `vitest@4.1.0` currently installs `nanoid@3.3.11` (v3, Mar 2025), while `nanoid@5.1.7` (a pure-ESM rewrite) is the current latest. This is vitest's internal dependency — wait for vitest to upgrade, or add an `npm` `overrides` block if a CVE is reported in nanoid v3. Currently no known vulnerabilities exist.

6. **Keep `esbuild` (`0.27.2` → `0.27.4`) in sync via `tsup` upgrades**  
   `tsup` manages its own `esbuild` dependency. The two-patch-version gap is minimal risk but `tsup` already at `8.5.1` (matching latest) — this will self-resolve on the next `npm install` once `tsup` bumps its internal esbuild pin.

7. **Adopt `npm audit` as a CI gate to catch future CVEs early**  
   The project currently has 0 vulnerabilities. Add `npm audit --audit-level=high` as a required CI step in the GitHub Actions workflow to prevent regressions. Given the large number of transitive packages from old toolchain lineages, this is a low-cost safety net.

8. **Consider replacing `luxon` (prod transitive dep of `cron-parser`) with a lighter alternative if bundle size is a concern**  
   `luxon@3.7.2` is current and well-maintained, but at ~71 KB minified it is a heavyweight addition for a library whose consumers may not need full datetime manipulation. `cron-parser@5` bundles `luxon` as a production dependency. If bundle size matters for consumers, evaluate `croner` (no external dependencies) or `cron-schedule` as alternatives to `cron-parser`.

9. **Run `npm dedupe` periodically** to eliminate any duplicate sub-dependency instances (e.g. multiple `semver` minor versions installed by different packages), reducing overall install footprint.

10. **Revisit the `prebuild-install`-heavy build stack annually**  
    At the time of this report, `better-sqlite3` (a dev/peer dependency) is the root cause of ~60% of the stale transitive packages. If the project targets Node.js 22+ exclusively, consider switching to [`node-sqlite`](https://nodejs.org/api/sqlite.html) (built into Node.js ≥22.5) for integration tests to eliminate the native-addon dependency chain entirely from the dev environment.