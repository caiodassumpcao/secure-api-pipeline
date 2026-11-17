/**
 * Applies database migrations and exits (Compose `migrate` service, deploys).
 * Runs before the API starts and never as part of it.
 */
import pg from 'pg';
import { loadConfigOrExit } from './config/load-or-exit.ts';
import { latestMigration, runMigrations } from './db/migrations.ts';
import { createLogger } from './lib/logger.ts';

const config = loadConfigOrExit();
const logger = createLogger(config.log);
const pool = new pg.Pool({
  connectionString: config.database.url,
  application_name: 'secure-api-migrate',
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  await runMigrations(pool);
  logger.info({ latest: latestMigration() }, 'database migrations applied');
} catch (err) {
  logger.fatal({ err }, 'database migrations failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
