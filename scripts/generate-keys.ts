/**
 * Generates the Ed25519 key pair that signs access tokens, for local
 * development and CI. Production keys are created and stored as secrets by the
 * operator (docs/runbook.md, Phase 5), never with this script in the image.
 *
 *   pnpm keys:generate [directory] [--force]
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE_KEY_FILE = 'jwt-private.pem';
export const PUBLIC_KEY_FILE = 'jwt-public.pem';

export interface GeneratedKeys {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
}

/**
 * Writes a new key pair to `directory`. The private key is readable by its
 * owner only. Existing keys are kept unless `force` is set: replacing them
 * invalidates every token signed with the old key.
 */
export function generateKeyFiles(directory: string, { force = false } = {}): GeneratedKeys {
  const privateKeyPath = join(directory, PRIVATE_KEY_FILE);
  const publicKeyPath = join(directory, PUBLIC_KEY_FILE);
  // Paths come from the developer's command line, not from user input.
  /* eslint-disable security/detect-non-literal-fs-filename */
  if (!force && (existsSync(privateKeyPath) || existsSync(publicKeyPath))) {
    throw new Error(`Keys already exist in ${directory}; pass --force to replace them`);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });
  /* eslint-enable security/detect-non-literal-fs-filename */
  return { privateKeyPath, publicKeyPath };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const directory = args.find((arg) => !arg.startsWith('--')) ?? 'keys';
  try {
    const { privateKeyPath, publicKeyPath } = generateKeyFiles(directory, {
      force: args.includes('--force'),
    });
    process.stdout.write(`Ed25519 key pair written:\n  ${privateKeyPath}\n  ${publicKeyPath}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
