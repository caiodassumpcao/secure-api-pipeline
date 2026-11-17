import { vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import type { Db } from '../../src/db/database.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { denyAllAuthenticator, type Authenticator } from '../../src/plugins/authentication.ts';
import { LogCapture } from './log-capture.ts';

export interface TestAppOptions {
  ping?: () => Promise<void>;
  migrationsApplied?: () => Promise<boolean>;
  authenticate?: Authenticator;
}

/**
 * Builds the real app with an in-memory log sink and a stubbed database: for
 * unit tests that never reach a repository (integration tests use a real one).
 */
export async function buildTestApp(options: TestAppOptions = {}) {
  const logs = new LogCapture();
  const logger = createLogger({ level: 'trace' }, logs);
  const ping = vi.fn(options.ping ?? (() => Promise.resolve()));
  const migrationsApplied = vi.fn(options.migrationsApplied ?? (() => Promise.resolve(true)));
  const app = await buildApp({
    logger,
    database: { ping, migrationsApplied, db: {} as Db },
    authenticate: options.authenticate ?? denyAllAuthenticator,
  });
  return { app, logs, ping, migrationsApplied };
}
