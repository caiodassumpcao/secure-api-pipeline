import { generateKeyPairSync } from 'node:crypto';
import { loadSigningKeys, type KeyPems, type SigningKeys } from '../../src/modules/auth/keys.ts';
import { createTokenService, type TokenService } from '../../src/modules/auth/tokens.ts';

export const TEST_ISSUER = 'secure-api-test';
export const TEST_AUDIENCE = 'secure-api-test';

/** A fresh Ed25519 key pair as PEM strings. */
export function generatePems(): KeyPems {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** Real token service with an ephemeral key pair, for tests. */
export async function createTestTokenService(
  options: { keys?: SigningKeys; clock?: () => number } = {},
): Promise<TokenService> {
  return createTokenService({
    keys: options.keys ?? (await loadSigningKeys(generatePems())),
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
