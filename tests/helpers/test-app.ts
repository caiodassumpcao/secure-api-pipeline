import { vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { LogCapture } from './log-capture.ts';

export interface TestAppOptions {
  ping?: () => Promise<void>;
  migrationsApplied?: () => Promise<boolean>;
}

/** Builds the real app with an in-memory log sink and a stubbed database probe. */
export async function buildTestApp(options: TestAppOptions = {}) {
  const logs = new LogCapture();
  const logger = createLogger({ level: 'trace' }, logs);
  const ping = vi.fn(options.ping ?? (() => Promise.resolve()));
  const migrationsApplied = vi.fn(options.migrationsApplied ?? (() => Promise.resolve(true)));
  const app = await buildApp({ logger, database: { ping, migrationsApplied } });
  return { app, logs, ping, migrationsApplied };
}
