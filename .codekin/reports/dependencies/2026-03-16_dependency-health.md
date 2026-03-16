# Dependency Health Report: stepflow

**Date**: 2026-03-16T14:53:42.500Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: ffd57a8f-8669-41fd-83de-b35ab637794d
**Session**: d9460b95-f282-4ba8-871f-fb9814f23062

---

Now I have all data needed to compile the report.

## Dependency Health Assessment — `@multiplier-labs/stepflow`
_Generated: 2026-03-16_

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 201 (3 prod, 199 dev, 53 optional) | 8 direct | 1 High | **Medium** |

---

## Security Vulnerabilities

| Package | Severity | Advisory | Description | Fixed In |
|---|---|---|---|---|
| `rollup` | **High** | [GHSA-mw96-cpmx-2vgc](https://github.com/advisories/GHSA-mw96-cpmx-2vgc) | Arbitrary File Write via Path Traversal (CWE-22) in rollup's plugin API. Affects `rollup` ≥4.0.0 <4.59.0. Transitive: pulled in by `tsup@8.5.1` → `rollup@4.55.1` and `vite` (via vitest). | `4.59.0` |

> **Note:** This vulnerability affects build tooling only (devDependency chain). It is not shipped in the published package. However it can be exploited if untrusted rollup plugin input is processed during local development or CI builds.

---

## Outdated Dependencies

| Package | Current | Latest | Age (est.) | Type |
|---|---|---|---|---|
| `cron-parser` | 4.9.0 | 5.5.0 | ~2 years (major) | production |
| `better-sqlite3` | 11.10.0 | 12.8.0 | ~9–12 months (major) | devDep / peer |
| `@types/node` | 22.19.5 | 25.5.0 | ~12+ months (spec pinned to v22) | devDep |
| `kysely` | 0.27.6 | 0.28.12 | ~4–6 months (minor) | devDep / peer |
| `pg` | 8.16.3 | 8.20.0 | ~2–4 months (minor) | devDep / peer |
| `@types/pg` | 8.16.0 | 8.18.0 | ~2–3 months (minor) | devDep |
| `vitest` | 4.0.18 | 4.1.0 | ~2–4 weeks (minor) | devDep |
| `@vitest/coverage-v8` | 4.0.18 | 4.1.0 | ~2–4 weeks (minor) | devDep |

---

## Abandoned / Unmaintained Packages

All entries below are **transitive** devDependency-chain packages — none are published in the library's production bundle.

| Package | Version | Last Release | Age | Pulled In Via |
|---|---|---|---|---|
| `any-promise` | 1.3.0 | 2016-05-08 | ~10 years | `tsup` → `sucrase` → `mz` |
| `object-assign` | 4.1.1 | 2017-01-16 | ~9 years | `tsup` → `sucrase` → `mz` |
| `tunnel-agent` | 0.6.0 | 2017-03-05 | ~9 years | `better-sqlite3` → `prebuild-install` |
| `deep-extend` | 0.6.0 | 2018-05-22 | ~8 years | `better-sqlite3` → `prebuild-install` → `rc` |

> `mz` (2019) and `rc` (2022) are also low-activity packages in these chains. However, all four packages listed above are widely considered "finished" utilities with stable APIs rather than actively dangerous abandonware. Their main risk is unpatched future CVEs.

---

## Recommendations

1. **[High — Immediate] Fix the `rollup` path traversal vulnerability.**
   Run `npm audit fix` to upgrade `rollup` to ≥4.59.0 via a compatible `tsup` update. Verify `tsup` 8.5.1 already resolves to a fixed rollup by checking `npm ls rollup` after the fix. If `tsup` does not yet resolve a fixed version, pin rollup with an `overrides` entry in `package.json`:
   ```json
   "overrides": { "rollup": ">=4.59.0" }
   ```

2. **[Medium — Next sprint] Upgrade `cron-parser` from v4 → v5.**
   `cron-parser` is the **only production dependency** bundled into the published package. v5 contains API changes (the expression API shifted to a more functional style). Review the [migration guide](https://github.com/harrisiirak/cron-parser), update usages in `src/scheduler/`, and bump the `package.json` spec from `^4.9.0` to `^5.5.0`.

3. **[Medium — Next sprint] Upgrade `better-sqlite3` from v11 → v12.**
   v12 drops some legacy Node.js compatibility shims and updates the native addon for newer Node ABI versions. Since `better-sqlite3` is both a devDep (used in tests) and a peer dep, test suite coverage should catch any breaking changes. Update both the devDep version and the `peerDependencies` minimum range.

4. **[Low — Routine] Update `pg`, `@types/pg`, and `kysely` to latest minor/patch.**
   These peer dependencies have minor updates available (`pg` 8.16.3→8.20.0, `kysely` 0.27.6→0.28.12). These are low-risk patch/minor bumps. Also bump the `peerDependencies` minimum versions to reflect current baselines.

5. **[Low — Routine] Update `vitest` and `@vitest/coverage-v8` to 4.1.0.**
   Minor release with bug fixes. Both packages should be upgraded together to keep versions in sync. Run `npm install vitest@4.1.0 @vitest/coverage-v8@4.1.0 --save-dev`.

6. **[Low — Routine] Loosen or update the `@types/node` constraint.**
   The spec `^22.0.0` locks type definitions to the Node 22.x API surface while Node.js 24/25 are current. If Node 22 LTS is the intentional target runtime, the current constraint is acceptable — but update to `^22.19.15` (latest v22 types). If newer Node is a target, relax to `^22.0.0 || ^24.0.0`.

7. **[Low — Monitor] Watch the `sucrase` / `mz` abandonment chain.**
   `tsup` depends on `sucrase`, which pulls in the unmaintained `mz` package (last release 2019) and its dependencies (`any-promise`, `object-assign`). Monitor `tsup` release notes for a replacement; if `tsup` v9+ resolves this chain, schedule the upgrade.

8. **[Low — Monitor] Watch the `prebuild-install` / `rc` chain in `better-sqlite3`.**
   `better-sqlite3`'s native binary installer pulls in the unmaintained `rc` (2022), `deep-extend` (2018), and `tunnel-agent` (2017). These are isolated to the install-time script and do not affect runtime. No action needed now, but if a CVE is published against `deep-extend` or `tunnel-agent`, an `overrides` pin or switch to a different SQLite binding (e.g. `node-sqlite3-wasm`) would be the mitigation path.

9. **[Info] Production bundle has a single direct dependency.**
   Only `cron-parser` is listed in `dependencies`; all other packages are `devDependencies` or optional `peerDependencies`. This is a healthy pattern — consumers are not burdened with transitive installs. Ensure `tsup` is configured to externalize `better-sqlite3`, `pg`, and `kysely` (peer deps) so they are never accidentally inlined into the `dist/` bundle.