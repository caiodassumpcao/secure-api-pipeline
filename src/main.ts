import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config/config.ts';
import { createDatabase } from './db/database.ts';
import { createLogger } from './lib/logger.ts';
import { registerGracefulShutdown } from './lib/shutdown.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    // Issues name the variables but never their values. Any other error is not
    // logged as is: it could carry a raw environment value.
    const issues =
      error instanceof ConfigError ? error.issues : ['the configuration could not be loaded'];
    createLogger({ level: 'info' }).fatal({ issues }, 'invalid configuration');
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const logger = createLogger(config.log);
const database = createDatabase(config.database, logger);
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
