import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { z } from 'zod';

/** `drizzle/` at the repository root: two levels up from both `src/db` and `dist/db`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Arbitrary application-wide key: only one migration run at a time per database. */
const MIGRATION_LOCK_KEY = 7_394_201_001;

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number().int() })).min(1),
});

/** `when` (epoch ms) of the newest migration in the folder's journal. */
export function latestMigration(folder: string = MIGRATIONS_FOLDER): number {
  const path = `${folder}/meta/_journal.json`;
  // Fixed path inside the build output, not user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const journal = journalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return Math.max(...journal.entries.map((entry) => entry.when));
}

/**
 * Applies pending migrations in one transaction, holding a session advisory lock
 * so concurrent runs (two deploys, a retried job) apply them only once.
 */
export async function runMigrations(
  pool: pg.Pool,
  folder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder: folder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
