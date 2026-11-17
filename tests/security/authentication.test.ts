import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, createTokenService } from '../../src/modules/auth/tokens.ts';
import { createTestTokenService, TEST_AUDIENCE, TEST_ISSUER } from '../helpers/keys.ts';
import { LogCapture } from '../helpers/log-capture.ts';
import { expectStatus, TestApi } from '../integration/helpers/api.ts';

/**
 * Authentication against an attacker (DESIGN §11): secrets never reach the
 * logs or the database in clear, and forged or stale credentials are refused
 * over HTTP. Reuse detection, lockout and rate limits have their own suites
 * (tests/integration/auth.test.ts, rate-limits.test.ts).
 */

const logs = new LogCapture();
let api: TestApi;

beforeAll(async () => {
  api = await TestApi.start({ logs });
});

afterAll(async () => {
  await api.stop();
});

const PASSWORD = 'a very secret passphrase indeed';

interface Flow {
  readonly secrets: string[];
  readonly userId: string;
}

/** Registers, logs in, refreshes, invites and accepts, logs out: every secret it saw. */
async function fullFlow(): Promise<Flow> {
  const email = `flow-${Date.now()}@example.test`;
  const inject = api.app.inject.bind(api.app);
  const registered = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, name: 'Ana' },
  });
  expectStatus(registered, 201);
  const login = await inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expectStatus(login, 200);
  const cookieValue = (name: string) =>
    login.cookies.find((cookie) => cookie.name === name)?.value ?? '';
  const refreshToken = cookieValue('__Secure-refresh');
  const deviceToken = cookieValue('__Secure-device');
  const refreshed = await inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: { cookie: `__Secure-refresh=${refreshToken}` },
  });
  expectStatus(refreshed, 200);
  const accessToken = refreshed.json<{ accessToken: string }>().accessToken;
  const user = { id: registered.json<{ id: string }>().id, email, name: 'Ana' };
  const team = await api.createTeam();
  const invitation = await api.invite(team.owner, team.workspaceId, 'member');
  expectStatus(await api.as(user).post('/v1/invitations/accept', { token: invitation.token }), 201);
  await inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: { cookie: `__Secure-refresh=${refreshed.cookies[0]?.value ?? ''}` },
  });
  await inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: `${PASSWORD} but wrong` },
  });
  return {
    userId: user.id,
    secrets: [PASSWORD, refreshToken, deviceToken, accessToken, invitation.token].filter(
      (secret) => secret.length > 0,
    ),
  };
}

describe('secrets', () => {
  it('never appear in the logs, whatever the flow', async () => {
    logs.lines.length = 0;
    const { secrets } = await fullFlow();

    expect(logs.lines.length).toBeGreaterThan(10);
    for (const secret of secrets) {
      expect(logs.text).not.toContain(secret);
    }
  });

  it('are stored as hashes only', async () => {
    const { secrets } = await fullFlow();

    const { rows } = await api.testDatabase.database.pool.query<{ dump: string }>(
      `SELECT concat_ws(' ',
          (SELECT string_agg(token_hash, ' ') FROM refresh_tokens),
          (SELECT string_agg(token_hash, ' ') FROM trusted_devices),
          (SELECT string_agg(token_hash, ' ') FROM invitations),
          (SELECT string_agg(password_hash, ' ') FROM users),
          (SELECT string_agg(metadata::text, ' ') FROM audit_events)) AS dump`,
    );
    for (const secret of secrets) {
      expect(rows[0]?.dump).not.toContain(secret);
    }
  });
});

describe('access tokens over HTTP', () => {
  async function me(accessToken: string) {
    return api.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function expectRejected(response: Awaited<ReturnType<typeof me>>) {
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="secure-api", error="invalid_token"',
    );
  }

  it('are refused once expired', async () => {
    const user = await api.createUser();
    const issuedEarlier = createTokenService({
      keys: api.keys,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      clock: () => Date.now() - (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000,
    });

    expectRejected(await me((await issuedEarlier.issueAccessToken(user.id)).accessToken));
  });

  it('are refused when signed by another key or for another audience', async () => {
    const user = await api.createUser();
    const otherKey = await createTestTokenService();
    const otherAudience = createTokenService({
      keys: api.keys,
      issuer: TEST_ISSUER,
      audience: 'another-api',
    });

    expectRejected(await me((await otherKey.issueAccessToken(user.id)).accessToken));
    expectRejected(await me((await otherAudience.issueAccessToken(user.id)).accessToken));
  });

  it('cannot be altered to impersonate someone else', async () => {
    const victim = await api.createUser('Victim');
    const attacker = await api.createUser('Attacker');
    const token = await api.accessToken(attacker);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: victim.id,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');

    expectRejected(await me(`${header}.${forgedPayload}.${signature}`));
  });

  it('cannot be swapped for an HMAC token keyed with the public key', async () => {
    const user = await api.createUser();
    const publicJwk = api.keys.verificationKeys[0];
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: publicJwk?.kid ?? '' })
      .setSubject(user.id)
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));

    expectRejected(await me(forged));
  });
});

describe('authentication responses', () => {
  it('are never cached and carry the security headers, errors included', async () => {
    const responses = [
      await api.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'nobody@example.test', password: PASSWORD },
      }),
      await api.app.inject({ method: 'POST', url: '/v1/auth/refresh' }),
      await api.app.inject({ method: 'POST', url: '/v1/auth/logout' }),
      await api.app.inject({ method: 'GET', url: '/v1/me' }),
    ];

    for (const response of responses) {
      expect(response.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': expect.stringContaining("default-src 'none'"),
      });
    }
  });
});
