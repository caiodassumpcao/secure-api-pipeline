import { generateKeyPairSync } from 'node:crypto';
import { decodeProtectedHeader, SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../../src/config/config.ts';
import { loadSigningKeys, loadSigningKeysFromFiles } from '../../../../src/modules/auth/keys.ts';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createTokenService,
} from '../../../../src/modules/auth/tokens.ts';
import { generatePems, TEST_AUDIENCE, TEST_ISSUER } from '../../../helpers/keys.ts';

const USER_ID = '0190f3b2-7c1e-7d2a-9f00-1234567890ab';
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

async function service(options: { pems?: ReturnType<typeof generatePems>; at?: number } = {}) {
  const pems = options.pems ?? generatePems();
  const keys = await loadSigningKeys(pems);
  return {
    pems,
    keys,
    tokens: createTokenService({
      keys,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      clock: () => options.at ?? NOW,
    }),
  };
}

describe('access tokens', () => {
  it('are Ed25519 JWTs typed at+jwt, identified by the key thumbprint', async () => {
    const { tokens, keys } = await service();

    const { accessToken, expiresIn } = await tokens.issueAccessToken(USER_ID);

    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(decodeProtectedHeader(accessToken)).toEqual({
      alg: 'Ed25519',
      typ: 'at+jwt',
      kid: keys.kid,
    });
    expect(keys.kid).toMatch(/^[\w-]{43}$/);
    expect(await tokens.verifyAccessToken(accessToken)).toBe(USER_ID);
  });

  it('expire after 15 minutes, with 5 seconds of clock tolerance', async () => {
    const { tokens, pems } = await service();
    const { accessToken } = await tokens.issueAccessToken(USER_ID);
    const at = async (offsetSeconds: number) =>
      (await service({ pems, at: NOW + offsetSeconds * 1000 })).tokens.verifyAccessToken(
        accessToken,
      );

    expect(await at(ACCESS_TOKEN_TTL_SECONDS + 4)).toBe(USER_ID);
    expect(await at(ACCESS_TOKEN_TTL_SECONDS + 6)).toBeNull();
  });

  it('are rejected when signed by another key', async () => {
    const { tokens } = await service();
    const { tokens: other } = await service();

    const { accessToken } = await other.issueAccessToken(USER_ID);

    expect(await tokens.verifyAccessToken(accessToken)).toBeNull();
  });

  it('are rejected for another issuer or audience', async () => {
    const { tokens, keys } = await service();
    const sign = (issuer: string, audience: string) =>
      createTokenService({ keys, issuer, audience, clock: () => NOW }).issueAccessToken(USER_ID);

    for (const { accessToken } of [
      await sign('someone-else', TEST_AUDIENCE),
      await sign(TEST_ISSUER, 'another-api'),
    ]) {
      expect(await tokens.verifyAccessToken(accessToken)).toBeNull();
    }
  });

  it('reject algorithm confusion, unsigned tokens and other token types', async () => {
    const { tokens, pems, keys } = await service();
    const iat = NOW / 1000;
    const claims = <T extends SignJWT | UnsecuredJWT>(jwt: T): T =>
      jwt
        .setSubject(USER_ID)
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_AUDIENCE)
        .setIssuedAt(iat)
        .setExpirationTime(iat + 60) as T;

    const hmacWithPublicKey = await claims(
      new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: keys.kid }),
    ).sign(new TextEncoder().encode(pems.publicKey));
    const unsigned = claims(new UnsecuredJWT({})).encode();
    const idTokenTyped = await claims(
      new SignJWT({}).setProtectedHeader({ alg: 'Ed25519', typ: 'JWT', kid: keys.kid }),
    ).sign(keys.privateKey);

    for (const token of [hmacWithPublicKey, unsigned, idTokenTyped, 'not.a.jwt', '']) {
      expect(await tokens.verifyAccessToken(token)).toBeNull();
    }
  });

  it('reject a subject that is not a user id', async () => {
    const { tokens, keys } = await service();
    const iat = NOW / 1000;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'Ed25519', typ: 'at+jwt', kid: keys.kid })
      .setSubject('admin')
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(keys.privateKey);

    expect(await tokens.verifyAccessToken(token)).toBeNull();
  });

  it('signed by the previous key stay valid during a rotation, and only then', async () => {
    const before = await service();
    const { accessToken } = await before.tokens.issueAccessToken(USER_ID);
    const next = generatePems();

    const rotating = await service({
      pems: { ...next, previousPublicKey: before.pems.publicKey },
    });
    const rotated = await service({ pems: next });

    expect(await rotating.tokens.verifyAccessToken(accessToken)).toBe(USER_ID);
    expect(await rotated.tokens.verifyAccessToken(accessToken)).toBeNull();
    const fresh = await rotating.tokens.issueAccessToken(USER_ID);
    expect(decodeProtectedHeader(fresh.accessToken).kid).toBe(rotating.keys.kid);
  });
});

describe('signing keys', () => {
  const issuesOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ConfigError) return error.issues;
      throw error;
    }
    throw new Error('expected a ConfigError');
  };

  it('must be Ed25519', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    expect(await issuesOf(loadSigningKeys({ privateKey, publicKey }))).toEqual([
      'JWT_PRIVATE_KEY_FILE: must be an Ed25519 key',
    ]);
  });

  it('must form a pair', async () => {
    const pems = { privateKey: generatePems().privateKey, publicKey: generatePems().publicKey };

    expect(await issuesOf(loadSigningKeys(pems))).toEqual([
      'JWT_PUBLIC_KEY_FILE: does not match JWT_PRIVATE_KEY_FILE',
    ]);
  });

  it('reports invalid PEM without quoting it', async () => {
    const pems = { ...generatePems(), privateKey: 'not a key but maybe a secret' };

    const issues = await issuesOf(loadSigningKeys(pems));

    expect(issues).toEqual(['JWT_PRIVATE_KEY_FILE: not a valid PEM key']);
    expect(JSON.stringify(issues)).not.toContain('secret');
  });

  it('are read from the configured files, every problem reported at once', async () => {
    const jwt = {
      privateKeyFile: undefined,
      publicKeyFile: '/run/secrets/public',
      previousPublicKeyFile: '/run/secrets/previous',
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    };
    const unreadable = () => {
      throw new Error('ENOENT');
    };

    expect(await issuesOf(loadSigningKeysFromFiles(jwt, unreadable))).toEqual([
      'JWT_PRIVATE_KEY_FILE: is required to run the API (pnpm keys:generate)',
      'JWT_PUBLIC_KEY_FILE: cannot read the file',
      'JWT_PREVIOUS_PUBLIC_KEY_FILE: cannot read the file',
    ]);
  });

  it('load from files when they are valid', async () => {
    const pems = generatePems();
    const files = new Map([
      ['private', pems.privateKey],
      ['public', pems.publicKey],
    ]);
    const jwt = {
      privateKeyFile: 'private',
      publicKeyFile: 'public',
      previousPublicKeyFile: undefined,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    };

    const keys = await loadSigningKeysFromFiles(jwt, (path) => files.get(path) ?? '');

    expect(keys.verificationKeys).toHaveLength(1);
    expect(keys.verificationKeys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: keys.kid });
  });
});
