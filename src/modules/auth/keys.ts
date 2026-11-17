import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose';
import { ConfigError, type JwtConfig, type ReadFile } from '../../config/config.ts';

/** JOSE algorithm of access tokens: Ed25519 (RFC 9864; replaces the older `EdDSA`). */
export const ACCESS_TOKEN_ALGORITHM = 'Ed25519';

export interface KeyPems {
  readonly privateKey: string;
  readonly publicKey: string;
  /** Public key of the previous signing key, still accepted during a rotation. */
  readonly previousPublicKey?: string | undefined;
}

export interface SigningKeys {
  readonly privateKey: KeyObject;
  /** RFC 7638 thumbprint of the current public key. */
  readonly kid: string;
  /** Public keys accepted when verifying, each with its `kid`: current first. */
  readonly verificationKeys: readonly JWK[];
}

function ed25519(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519')
    throw new ConfigError([`${name}: must be an Ed25519 key`]);
  return key;
}

async function verificationKey(publicKey: KeyObject): Promise<JWK> {
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk, 'sha256');
  return { ...jwk, kid, alg: ACCESS_TOKEN_ALGORITHM, use: 'sig' };
}

function parse<T>(name: string, load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // Never include the error: it could quote the key material.
    throw new ConfigError([`${name}: not a valid PEM key`]);
  }
}

/**
 * Loads the Ed25519 signing key and the public keys accepted for verification.
 * Refuses keys of another type and a public key that does not match the
 * private one, so a mistake fails at startup rather than on every request.
 */
export async function loadSigningKeys(pems: KeyPems): Promise<SigningKeys> {
  const privateKey = parse('JWT_PRIVATE_KEY_FILE', () =>
    ed25519(createPrivateKey(pems.privateKey), 'JWT_PRIVATE_KEY_FILE'),
  );
  const publicKey = parse('JWT_PUBLIC_KEY_FILE', () =>
    ed25519(createPublicKey(pems.publicKey), 'JWT_PUBLIC_KEY_FILE'),
  );
  if (!createPublicKey(privateKey).equals(publicKey)) {
    throw new ConfigError(['JWT_PUBLIC_KEY_FILE: does not match JWT_PRIVATE_KEY_FILE']);
  }

  const current = await verificationKey(publicKey);
  const keys = [current];
  if (pems.previousPublicKey !== undefined) {
    const previous = parse('JWT_PREVIOUS_PUBLIC_KEY_FILE', () =>
      ed25519(createPublicKey(pems.previousPublicKey ?? ''), 'JWT_PREVIOUS_PUBLIC_KEY_FILE'),
    );
    keys.push(await verificationKey(previous));
  }
  return { privateKey, kid: current.kid ?? '', verificationKeys: keys };
}

/** Reads the key files named by the configuration, reporting every problem at once. */
export async function loadSigningKeysFromFiles(
  jwt: JwtConfig,
  readFile: ReadFile,
): Promise<SigningKeys> {
  const issues: string[] = [];
  const read = (name: string, path: string | undefined, required: boolean) => {
    if (path === undefined) {
      if (required) issues.push(`${name}: is required to run the API (pnpm keys:generate)`);
      return undefined;
    }
    try {
      return readFile(path);
    } catch {
      issues.push(`${name}: cannot read the file`);
      return undefined;
    }
  };
  const privateKey = read('JWT_PRIVATE_KEY_FILE', jwt.privateKeyFile, true);
  const publicKey = read('JWT_PUBLIC_KEY_FILE', jwt.publicKeyFile, true);
  const previousPublicKey = read('JWT_PREVIOUS_PUBLIC_KEY_FILE', jwt.previousPublicKeyFile, false);
  if (issues.length > 0 || privateKey === undefined || publicKey === undefined) {
    throw new ConfigError(issues);
  }
  return loadSigningKeys({ privateKey, publicKey, previousPublicKey });
}
