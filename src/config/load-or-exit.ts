import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { createLogger } from '../lib/logger.ts';
import { loadSigningKeysFromFiles, type SigningKeys } from '../modules/auth/keys.ts';
import { ConfigError, loadConfig, type Config, type ReadFile } from './config.ts';

type Exit = (code: number) => never;

const exitProcess: Exit = (code) => process.exit(code);

// The path comes from the operator-controlled environment, not from user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const readFileUtf8: ReadFile = (path) => readFileSync(path, 'utf8');

function issuesOf(error: unknown, fallback: string): readonly string[] {
  return error instanceof ConfigError ? error.issues : [fallback];
}

/**
 * Loads the configuration for a process entry point, or logs why it is invalid
 * and exits 1. Issues name the variables but never their values; any other
 * error is not logged as is, because it could carry a raw environment value.
 */
export function loadConfigOrExit(
  env: NodeJS.ProcessEnv = process.env,
  exit: Exit = exitProcess,
): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    const issues = issuesOf(error, 'the configuration could not be loaded');
    createLogger({ level: 'info' }).fatal({ issues }, 'invalid configuration');
    return exit(1);
  }
}

/**
 * Loads the access-token signing keys for the API process, or logs why they
 * are unusable and exits 1, never quoting the key material.
 */
export async function loadSigningKeysOrExit(
  config: Config,
  logger: Logger,
  readFile: ReadFile = readFileUtf8,
  exit: Exit = exitProcess,
): Promise<SigningKeys> {
  try {
    return await loadSigningKeysFromFiles(config.jwt, readFile);
  } catch (error) {
    const issues = issuesOf(error, 'the signing keys could not be loaded');
    logger.fatal({ issues }, 'invalid signing keys');
    return exit(1);
  }
}
