/**
 * Process preload: `node --import ./dist/telemetry/instrument.js dist/main.js`.
 * Starts OpenTelemetry before any application module is imported, so the
 * instrumented libraries are patched when the app first loads them. Only the
 * API process loads it: `migrate` and the container health check do not.
 */
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { register } from 'import-in-the-middle/register-hooks.mjs';
import { ConfigError } from '../config/config.ts';
import { loadTelemetryConfig, type TelemetryConfig } from './config.ts';

/** Libraries imported by the app as ESM whose instrumentation patches them. */
const INSTRUMENTED_MODULES = ['pg', 'pino'];
import { createInstrumentations } from './instrumentations.ts';
import { startTelemetry } from './sdk.ts';

async function exitWithInvalidConfig(error: unknown): Promise<never> {
  const { createLogger } = await import('../lib/logger.ts');
  const issues =
    error instanceof ConfigError ? error.issues : ['telemetry could not be configured'];
  createLogger({ level: 'info' }).fatal({ issues }, 'invalid telemetry configuration');
  process.exit(1);
}

let config: TelemetryConfig;
try {
  config = loadTelemetryConfig();
} catch (error) {
  config = await exitWithInvalidConfig(error);
}

if (config.enabled) {
  // Synchronous, in-thread loader hooks (Node.js >= 24.11.1), limited to the
  // ESM imports of the instrumented libraries; CommonJS ones (Fastify's http,
  // pg-pool) are patched through require.
  register({ include: INSTRUMENTED_MODULES });
  startTelemetry(config, { instrumentations: createInstrumentations() });

  // Loaded after the SDK started, so the instrumented pino is the one used.
  const { createLogger } = await import('../lib/logger.ts');
  const logger = createLogger({ level: 'warn' }).child({ component: 'opentelemetry' });
  diag.setLogger(
    {
      error: (message) => {
        logger.error(message);
      },
      warn: (message) => {
        logger.warn(message);
      },
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    DiagLogLevel.WARN,
  );
}
