/**
 * Shared lazy-loader for PostgreSQL dependencies (kysely + pg).
 *
 * Both `PostgresStorageAdapter` and `PostgresSchedulePersistence` need the same
 * set of optional peer dependencies. This module loads them once and caches the
 * result so the logic isn't duplicated across files.
 */

/**
 * Dynamic imports prevent static type resolution for these modules;
 * `any` is intentional here — callers cast to the appropriate Kysely/pg types.
 */
export interface PostgresDeps {
  Kysely: any;
  PostgresDialect: any;
  sql: any;
  pgModule: any;
}

let cached: PostgresDeps | undefined;
let loadingPromise: Promise<PostgresDeps> | undefined;

/**
 * Lazily load and cache the PostgreSQL peer dependencies (kysely + pg).
 * @returns The cached `{Kysely, PostgresDialect, sql, pgModule}` object.
 * @throws {Error} If the `kysely` optional peer dependency is not installed.
 * @throws {Error} If the `pg` optional peer dependency is not installed.
 */
export async function loadPostgresDeps(): Promise<PostgresDeps> {
  if (cached) return cached;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    let Kysely: any;
    let PostgresDialect: any;
    let sql: any;
    let pgModule: any;

    try {
      const kyselyMod = await import("kysely");
      Kysely = kyselyMod.Kysely;
      PostgresDialect = kyselyMod.PostgresDialect;
      sql = kyselyMod.sql;
    } catch {
      throw new Error(
        'PostgreSQL support requires the "kysely" package. Install it with: npm install kysely',
      );
    }
    try {
      const pg = await import("pg");
      pgModule = pg.default ?? pg;
    } catch {
      throw new Error(
        'PostgreSQL support requires the "pg" package. Install it with: npm install pg',
      );
    }

    cached = { Kysely, PostgresDialect, sql, pgModule };
    return cached;
  })();

  return loadingPromise;
}
