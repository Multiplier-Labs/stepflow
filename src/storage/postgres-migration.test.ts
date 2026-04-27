/**
 * Regression tests for PostgresStorageAdapter migration error handling.
 * See audit 2026-04-27 finding C1: schema migrations must surface failures
 * instead of silently swallowing them.
 */

import { describe, it, expect } from 'vitest';
import { PostgresStorageAdapter } from './postgres';

interface QueryHandler {
  (text: string, params: unknown[]): Promise<{ command: string; rowCount: number; rows: unknown[] }>;
}

/**
 * Build the smallest pg.Pool-like object Kysely's PostgresDialect needs:
 * `connect()` returning a client with `query()` and `release()`, plus `end()`.
 */
function buildFakePool(handler: QueryHandler) {
  const client = {
    query: (text: string, params: unknown[] = []) => handler(text, params),
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    end: async () => {},
    on: () => pool,
    off: () => pool,
  };
  return pool;
}

describe('PostgresStorageAdapter — migration error propagation', () => {
  it('rethrows a non-benign migration error with a clear message', async () => {
    const handler: QueryHandler = async (text) => {
      if (/ALTER\s+TABLE/i.test(text)) {
        // Simulate a non-benign migration failure (e.g., permission denied).
        const err: Error & { code?: string } = new Error('permission denied for table runs');
        err.code = '42501'; // insufficient_privilege — not in benign list
        throw err;
      }
      return { command: 'CREATE', rowCount: 0, rows: [] };
    };

    const adapter = new PostgresStorageAdapter({
      pool: buildFakePool(handler) as unknown as import('pg').Pool,
    });

    await expect(adapter.initialize()).rejects.toThrow(/Schema migration failed/);
    await expect(adapter.initialize()).rejects.toThrow(/permission denied/);
  });

  it('tolerates benign duplicate-column errors during idempotent re-runs', async () => {
    const handler: QueryHandler = async (text) => {
      if (/ALTER\s+TABLE/i.test(text)) {
        const err: Error & { code?: string } = new Error('column "priority" of relation "runs" already exists');
        err.code = '42701'; // duplicate_column — benign
        throw err;
      }
      return { command: 'CREATE', rowCount: 0, rows: [] };
    };

    const adapter = new PostgresStorageAdapter({
      pool: buildFakePool(handler) as unknown as import('pg').Pool,
    });

    await expect(adapter.initialize()).resolves.toBeUndefined();
    await adapter.close();
  });
});
