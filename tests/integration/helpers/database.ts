import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase, type Database } from '../../../src/db/database.ts';
import { latestMigration } from '../../../src/db/migrations.ts';
import { createLogger } from '../../../src/lib/logger.ts';

export interface TestDatabase {
  readonly database: Database;
  readonly url: string;
  drop(): Promise<void>;
}

/** Runs one statement on the server's maintenance database. */
async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('postgres').adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * A database for one test file: migrated (copied from the template) or empty.
 * Files run in parallel without sharing state.
 */
export async function createTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const { adminUrl, template } = inject('postgres');
  // Generated name: safe to interpolate as an identifier.
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin(
    options.migrated === false
      ? `CREATE DATABASE "${name}"`
      : `CREATE DATABASE "${name}" TEMPLATE "${template}"`,
  );

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = createDatabase({ url: url.toString() }, createLogger({ level: 'silent' }), {
    expectedMigration: latestMigration(),
  });

  return {
    database,
    url: url.toString(),
    async drop() {
      await database.close();
      await admin(`DROP DATABASE "${name}" WITH (FORCE)`);
    },
  };
}

/**
 * Resolves once a session of the pool's database is blocked on a lock held by
 * another transaction: lets a test interleave two transactions deterministically.
 */
export async function waitForLockWait(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No session waited for a lock within ${timeoutMs} ms`);
}
