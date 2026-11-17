import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { Logger } from 'pino';
import type { ReadinessProbe } from '../modules/health/health.routes.ts';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

/** The database or an open transaction: repositories accept either. */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface DatabaseConfig {
  readonly url: string;
}

export interface Database extends ReadinessProbe {
  readonly pool: pg.Pool;
  readonly db: Db;
  close(): Promise<void>;
}

/**
 * PostgreSQL connection pool and Drizzle client. Connections are opened lazily,
 * so the API starts (and reports not-ready) while the database is coming up.
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
    db: drizzle({ client: pool, schema }),
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
