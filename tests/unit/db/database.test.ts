import { beforeEach, describe, expect, it, vi } from 'vitest';

const pools = vi.hoisted(() => [] as FakePool[]);

interface FakePool {
  options: Record<string, unknown>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  listeners: Map<string, (error: Error) => void>;
}

vi.mock('pg', () => {
  class Pool {
    options: Record<string, unknown>;
    query = vi.fn(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));
    end = vi.fn(() => Promise.resolve());
    listeners = new Map<string, (error: Error) => void>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      pools.push(this);
    }

    on(event: string, listener: (error: Error) => void) {
      this.listeners.set(event, listener);
      return this;
    }
  }
  return { default: { Pool } };
});

const { createDatabase } = await import('../../../src/db/database.ts');

function setup() {
  const logger = { error: vi.fn() };
  const database = createDatabase(
    { url: 'postgres://app:pw@localhost:5432/app' },
    logger as unknown as Parameters<typeof createDatabase>[1],
  );
  const pool = pools.at(-1)!;
  return { database, pool, logger };
}

describe('createDatabase', () => {
  beforeEach(() => {
    pools.length = 0;
  });

  it('creates a bounded pool with fail-fast connection timeouts', () => {
    const { pool } = setup();

    expect(pool.options).toEqual({
      connectionString: 'postgres://app:pw@localhost:5432/app',
      application_name: 'secure-api',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
  });

  it('pings with a trivial query', async () => {
    const { database, pool } = setup();

    await database.ping();

    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('propagates ping failures', async () => {
    const { database, pool } = setup();
    pool.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(database.ping()).rejects.toThrow('ECONNREFUSED');
  });

  it('closes the pool', async () => {
    const { database, pool } = setup();

    await database.close();

    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('logs idle client errors instead of crashing the process', () => {
    const { pool, logger } = setup();
    const failure = new Error('terminating connection due to administrator command');

    pool.listeners.get('error')?.(failure);

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, 'idle database client error');
  });
});
