import { createLogger } from '../lib/logger.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';

/**
 * Loads the configuration for a process entry point, or logs why it is invalid
 * and exits 1. Issues name the variables but never their values; any other
 * error is not logged as is, because it could carry a raw environment value.
 */
export function loadConfigOrExit(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = (code) => process.exit(code),
): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    const issues =
      error instanceof ConfigError ? error.issues : ['the configuration could not be loaded'];
    createLogger({ level: 'info' }).fatal({ issues }, 'invalid configuration');
    return exit(1);
  }
}
