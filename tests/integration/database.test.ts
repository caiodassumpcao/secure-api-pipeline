import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { latestMigration, runMigrations } from '../../src/db/migrations.ts';
import { AUDIT_RETENTION_DAYS } from '../../src/db/schema.ts';
import { uuidv7 } from '../../src/lib/ids.ts';
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
    docs: { enabled: false },
    http: { corsOrigins: [], trustProxy: false },
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
    expect(rows[0]).toEqual({ applied: '4', latest: String(latestMigration()) });
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

  describe('audit events', () => {
    let migrated: TestDatabase;

    beforeAll(async () => {
      migrated = await createTestDatabase();
    });

    afterAll(async () => {
      await migrated.drop();
    });

    /** Inserts an event created `ageMinutes` ago and returns its id. */
    async function eventAged(ageMinutes: number): Promise<string> {
      const id = uuidv7();
      await migrated.database.pool.query(
        `INSERT INTO audit_events (id, action, created_at)
         VALUES ($1, 'test.event', now() - make_interval(mins => $2))`,
        [id, ageMinutes],
      );
      return id;
    }

    const retentionMinutes = AUDIT_RETENTION_DAYS * 24 * 60;
    const rejected = expect.objectContaining({ code: '42501' });

    it('rejects UPDATE and TRUNCATE, whatever the age of the rows', async () => {
      const recent = await eventAged(1);
      const old = await eventAged(retentionMinutes + 60);
      const { pool } = migrated.database;

      for (const id of [recent, old]) {
        await expect(
          pool.query(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [id]),
        ).rejects.toEqual(rejected);
      }
      await expect(pool.query('TRUNCATE audit_events')).rejects.toEqual(rejected);
    });

    it('deletes only events past the retention period', async () => {
      const inside = await eventAged(retentionMinutes - 5);
      const past = await eventAged(retentionMinutes + 5);
      const { pool } = migrated.database;

      await expect(pool.query('DELETE FROM audit_events WHERE id = $1', [inside])).rejects.toEqual(
        rejected,
      );
      const deleted = await pool.query('DELETE FROM audit_events WHERE id = $1', [past]);

      expect(deleted.rowCount).toBe(1);
    });
  });
});
