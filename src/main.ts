import { buildApp } from './app.ts';
import { loadConfigOrExit, loadSigningKeysOrExit } from './config/load-or-exit.ts';
import { createDatabase } from './db/database.ts';
import { latestMigration } from './db/migrations.ts';
import { runCleanup, scheduleCleanup } from './jobs/cleanup.ts';
import { createLogger } from './lib/logger.ts';
import { createRateLimiter } from './lib/rate-limiter.ts';
import { registerGracefulShutdown } from './lib/shutdown.ts';
import { createPasswordHasher } from './modules/auth/password.ts';
import { createTokenService } from './modules/auth/tokens.ts';
import { createAppMetrics } from './telemetry/metrics.ts';
import { activeTelemetry } from './telemetry/sdk.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfigOrExit();
const logger = createLogger(config.log);
const database = createDatabase(config.database, logger, { expectedMigration: latestMigration() });

const keys = await loadSigningKeysOrExit(config, logger);
const tokens = createTokenService({
  keys,
  issuer: config.jwt.issuer,
  audience: config.jwt.audience,
});

const app = await buildApp({
  logger,
  database,
  auth: { tokens, passwords: createPasswordHasher() },
  docs: config.docs,
  metrics: createAppMetrics(),
  limits: { limiter: createRateLimiter(database.db), global: true },
  http: { corsOrigins: config.cors.origins, trustProxy: config.trustProxy },
});

const cleanup = scheduleCleanup(() => runCleanup(database.db), logger);

app.addHook('onClose', async () => {
  cleanup.stop();
  await database.close();
});

const { shutdown } = registerGracefulShutdown({
  // Stop serving first, then flush the telemetry the last requests produced.
  close: async () => {
    await app.close();
    await activeTelemetry()?.shutdown();
  },
  logger,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
});

try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (err) {
  logger.fatal({ err }, 'server failed to start');
  await shutdown('startup failure', 1);
}
