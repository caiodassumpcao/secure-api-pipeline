import pg from 'pg';
import type { Logger } from 'pino';
import type { ReadinessProbe } from '../modules/health/health.routes.ts';

export interface DatabaseConfig {
  readonly url: string;
}

export interface Database extends ReadinessProbe {
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * PostgreSQL connection pool. Connections are opened lazily, so the API starts
 * (and reports not-ready) while the database is still coming up.
 */
export function createDatabase(config: DatabaseConfig, logger: Logger): Database {
  const pool = new pg.Pool({
    connectionString: config.url,
    application_name: 'secure-api',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  // Without a listener, an error on an idle client (e.g. the server restarting)
  // is emitted as an uncaught 'error' event and crashes the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle database client error');
  });

  return {
    pool,
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
