import { vi } from 'vitest';
import { buildApp, type AppDependencies } from '../../src/app.ts';
import type { Db } from '../../src/db/database.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { createPasswordHasher } from '../../src/modules/auth/password.ts';
import type { TokenService } from '../../src/modules/auth/tokens.ts';
import { createTestTokenService } from './keys.ts';
import { LogCapture } from './log-capture.ts';
import { unlimited } from '../../src/lib/rate-limiter.ts';
import { createAppMetrics } from '../../src/telemetry/metrics.ts';

export interface TestAppOptions {
  ping?: () => Promise<void>;
  migrationsApplied?: () => Promise<boolean>;
  tokens?: TokenService;
  docs?: boolean;
  globalRateLimit?: boolean;
  http?: Partial<AppDependencies['http']>;
}

// Unit tests never reach a repository: the handle is a placeholder, not a
// Drizzle instance (integration tests use a real database).
const placeholderDb = {} as unknown as Db;

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
    database: { ping, migrationsApplied, db: placeholderDb },
    auth: {
      tokens: options.tokens ?? (await createTestTokenService()),
      passwords: createPasswordHasher(),
    },
    docs: { enabled: options.docs ?? false },
    metrics: createAppMetrics(),
    limits: { limiter: unlimited, global: options.globalRateLimit ?? false },
    http: { corsOrigins: [], trustProxy: false, ...options.http },
  });
  return { app, logs, ping, migrationsApplied };
}
