import { buildApp } from './app.ts';
import { loadConfigOrExit } from './config/load-or-exit.ts';
import { createDatabase } from './db/database.ts';
import { latestMigration } from './db/migrations.ts';
import { createLogger } from './lib/logger.ts';
import { registerGracefulShutdown } from './lib/shutdown.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfigOrExit();
const logger = createLogger(config.log);
const database = createDatabase(config.database, logger, { expectedMigration: latestMigration() });
const app = await buildApp({ logger, database });

app.addHook('onClose', async () => {
  await database.close();
});

const { shutdown } = registerGracefulShutdown({
  close: () => app.close(),
  logger,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
});

try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (err) {
  logger.fatal({ err }, 'server failed to start');
  await shutdown('startup failure', 1);
}
