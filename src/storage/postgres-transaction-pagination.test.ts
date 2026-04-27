/**
 * Regression test for PostgresTransactionAdapter.listRuns pagination total.
 * See audit 2026-04-27 finding C2: when listRuns is called inside a
 * transaction, the returned `total` must reflect the rows visible to that
 * transaction (via COUNT(*) on the same connection), not the size of the
 * returned page.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PostgresStorageAdapter, PostgresTransactionAdapter } from './postgres';

beforeAll(async () => {
  // PostgresTransactionAdapter.listRuns uses the module-level `sql` template
  // tag from postgres.ts, which is only populated when a PostgresStorageAdapter
  // is initialized. Initialize one with a no-op fake pool so the module state
  // is ready for the direct unit test below.
  const noopPool = {
    connect: async () => ({
      query: async () => ({ command: 'SELECT', rowCount: 0, rows: [] }),
      release: () => {},
    }),
    end: async () => {},
    on: () => noopPool,
    off: () => noopPool,
  };
  const bootstrap = new PostgresStorageAdapter({
    pool: noopPool as unknown as import('pg').Pool,
  });
  await bootstrap.initialize();
  await bootstrap.close();
});

/**
 * Build a Kysely-transaction-shaped stub backed by an in-memory row list.
 * It distinguishes the COUNT(*) query (started with `selectFrom().select()`)
 * from the data query (started with `selectFrom().selectAll()`) and replies
 * with the right shape for each.
 */
function buildFakeTrx<T extends Record<string, unknown>>(rows: T[]) {
  function buildCountChain() {
    const chain: any = {};
    chain.where = () => chain;
    chain.executeTakeFirst = async () => ({ count: rows.length });
    return chain;
  }
  function buildDataChain() {
    const chain: any = {};
    let limit: number | undefined;
    let offset = 0;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = (n: number) => { limit = n; return chain; };
    chain.offset = (n: number) => { offset = n; return chain; };
    chain.execute = async () => {
      const sliced = rows.slice(offset, limit !== undefined ? offset + limit : undefined);
      return sliced;
    };
    return chain;
  }
  const qb = {
    selectFrom: () => ({
      select: () => buildCountChain(),
      selectAll: () => buildDataChain(),
    }),
  };
  return { withSchema: () => qb } as any;
}

describe('PostgresTransactionAdapter — listRuns pagination total', () => {
  it('reports total from COUNT(*) on the same transaction, not the page size', async () => {
    // Simulate 7 rows visible in the transaction; ask for a page of 3.
    const fakeRow = {
      id: 'r', kind: 'k', status: 'queued', parent_run_id: null,
      input_json: '{}', metadata_json: '{}', context_json: '{}',
      output_json: null, error_json: null, priority: 0, timeout_ms: null,
      created_at: new Date(), started_at: null, finished_at: null,
    };
    const rows = Array.from({ length: 7 }, (_, i) => ({ ...fakeRow, id: `r${i}` }));
    const trx = buildFakeTrx(rows);

    const adapter = new PostgresTransactionAdapter(trx, 'public');
    const result = await adapter.listRuns({ limit: 3 });

    // Page contains only 3 rows...
    expect(result.items).toHaveLength(3);
    // ...but total reflects all 7 rows visible in the transaction.
    // Pre-fix this returned 3 (rows.length).
    expect(result.total).toBe(7);
  });

  it('total reflects all created rows even when limit exceeds page size', async () => {
    const fakeRow = {
      id: 'r', kind: 'k', status: 'queued', parent_run_id: null,
      input_json: '{}', metadata_json: '{}', context_json: '{}',
      output_json: null, error_json: null, priority: 0, timeout_ms: null,
      created_at: new Date(), started_at: null, finished_at: null,
    };
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...fakeRow, id: `r${i}` }));
    const trx = buildFakeTrx(rows);

    const adapter = new PostgresTransactionAdapter(trx, 'public');
    const result = await adapter.listRuns({ limit: 100 });

    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(5);
  });
});
