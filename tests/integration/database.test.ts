import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { latestMigration, runMigrations } from '../../src/db/migrations.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { denyAllAuthenticator } from '../../src/plugins/authentication.ts';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';

let empty: TestDatabase;

beforeAll(async () => {
  empty = await createTestDatabase({ migrated: false });
});

afterAll(async () => {
  await empty.drop();
});

async function ready(testDatabase: TestDatabase) {
  const app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    database: testDatabase.database,
    authenticate: denyAllAuthenticator,
  });
  try {
    return await app.inject({ method: 'GET', url: '/health/ready' });
  } finally {
    await app.close();
  }
}

describe('migrations and readiness', () => {
  it('reports not ready until the migrations are applied, then ready', async () => {
    const before = await ready(empty);
    expect(before.statusCode).toBe(503);
    expect(before.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'ok', migrations: 'pending' },
    });

    // Concurrent runs (two deploys, a retried job) apply each migration once.
    const pools = [1, 2].map(() => new pg.Pool({ connectionString: empty.url, max: 1 }));
    try {
      await Promise.all(pools.map((pool) => runMigrations(pool)));
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }

    const after = await ready(empty);
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ status: 'ok', checks: { database: 'ok', migrations: 'ok' } });

    const { rows } = await empty.database.pool.query<{ applied: string; latest: string }>(
      'SELECT count(*)::text AS applied, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations',
    );
    expect(rows[0]).toEqual({ applied: '2', latest: String(latestMigration()) });
  });

  it('enforces tenant consistency in the schema itself', async () => {
    const migrated = await createTestDatabase();
    try {
      const { rows } = await migrated.database.pool.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid = 'tasks'::regclass AND contype = 'f' ORDER BY conname`,
      );
      expect(rows.map((row) => row.name)).toEqual(
        expect.arrayContaining(['tasks_assignee_membership_fk', 'tasks_project_fk']),
      );
    } finally {
      await migrated.drop();
    }
  });
});
