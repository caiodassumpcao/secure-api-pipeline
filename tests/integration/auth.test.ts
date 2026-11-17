import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BLOCKLIST } from '../../src/modules/auth/blocklist.ts';
import {
  ARGON2_PARAMS,
  createPasswordHasher,
  type PasswordHasher,
} from '../../src/modules/auth/password.ts';
import { DEVICE_FAILURE_LIMIT, LOCKOUT_THRESHOLD } from '../../src/modules/auth/policy.ts';
import { expectStatus, TestApi } from './helpers/api.ts';

let api: TestApi;

/** Real argon2, recording whether each check ran against a stored hash or the dummy one. */
const hasher = createPasswordHasher();
const verifications: ('stored' | 'dummy')[] = [];
const spyingHasher: PasswordHasher = {
  ...hasher,
  verify: (passwordHash, password) => {
    verifications.push(passwordHash === null ? 'dummy' : 'stored');
    return hasher.verify(passwordHash, password);
  },
};

beforeAll(async () => {
  api = await TestApi.start({ passwords: spyingHasher });
});

afterAll(async () => {
  await api.stop();
});

const PASSWORD = 'correct horse battery staple';
/** A known-breached password, taken from the blocklist rather than spelled out here. */
const BREACHED = [...BLOCKLIST][0] ?? '';
let sequence = 0;
const uniqueEmail = () => {
  sequence += 1;
  return `person-${sequence}-${Date.now()}@example.test`;
};

describe('POST /v1/auth/register', () => {
  it('creates an account with a personal workspace it owns', async () => {
    const email = uniqueEmail();

    const response = await api.as(null).post('/v1/auth/register', {
      email: `  ${email.toUpperCase()} `,
      password: PASSWORD,
      name: ' Ana ',
    });

    expectStatus(response, 201);
    const user = response.json<{ id: string }>();
    expect(user).toEqual({ id: user.id, email, name: 'Ana', createdAt: expect.any(String) });
    expect(response.headers.location).toBe('/v1/me');
    expect(response.body).not.toContain('passwordHash');

    const { rows } = await api.testDatabase.database.pool.query<{
      role: string;
      name: string;
      slug: string;
      password_hash: string;
    }>(
      `SELECT m.role, w.name, w.slug, u.password_hash FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1`,
      [user.id],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        role: 'owner',
        name: 'Personal',
        slug: expect.stringMatching(/^personal-[0-9a-f]{32}$/),
      }),
    ]);
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('answers 409 for an address already in use, whatever its case', async () => {
    const email = uniqueEmail();
    expectStatus(
      await api.as(null).post('/v1/auth/register', { email, password: PASSWORD, name: 'One' }),
      201,
    );

    const response = await api
      .as(null)
      .post('/v1/auth/register', { email: email.toUpperCase(), password: PASSWORD, name: 'Two' });

    expect(response.statusCode).toBe(409);
  });

  it.each([
    [{ password: 'too short' }, 'body.password', 'Must have at least 12 characters'],
    [
      { password: BREACHED },
      'body.password',
      'Too common: it appears in lists of breached passwords',
    ],
    [{ email: 'not-an-email' }, 'body.email', expect.any(String)],
    [{ name: '   ' }, 'body.name', expect.any(String)],
    [{ role: 'owner' }, 'body', expect.any(String)],
  ])('rejects %o', async (override, path, message) => {
    const response = await api.as(null).post('/v1/auth/register', {
      email: uniqueEmail(),
      password: PASSWORD,
      name: 'Ana',
      ...override,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([{ path, message }]);
  });
});

interface Account {
  readonly id: string;
  readonly email: string;
}

async function register(): Promise<Account> {
  const email = uniqueEmail();
  const response = await api
    .as(null)
    .post('/v1/auth/register', { email, password: PASSWORD, name: 'Ana' });
  expectStatus(response, 201);
  return { id: response.json<{ id: string }>().id, email };
}

function cookie(response: LightMyRequestResponse, name: string) {
  return response.cookies.find((candidate) => candidate.name === name);
}

const DEVICE = '__Secure-device';
const REFRESH = '__Secure-refresh';

function login(email: string, password: string, deviceToken?: string) {
  return api.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
    headers: deviceToken === undefined ? {} : { cookie: `${DEVICE}=${deviceToken}` },
  });
}

async function failTimes(email: string, times: number, deviceToken?: string) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    expectStatus(await login(email, 'wrong password, again', deviceToken), 401);
  }
}

describe('POST /v1/auth/login', () => {
  beforeEach(() => {
    verifications.length = 0;
  });

  it('returns an access token for /v1 and sets the session cookies', async () => {
    const account = await register();

    const response = await login(account.email.toUpperCase(), PASSWORD);

    expectStatus(response, 200);
    const body = response.json<{ accessToken: string; tokenType: string; expiresIn: number }>();
    expect(body).toEqual({ accessToken: expect.any(String), tokenType: 'Bearer', expiresIn: 900 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(cookie(response, REFRESH)).toMatchObject({
      path: '/v1/auth',
      maxAge: 7 * 24 * 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    expect(cookie(response, DEVICE)).toMatchObject({
      path: '/v1/auth/login',
      maxAge: 90 * 24 * 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });

    const workspaces = await api.app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(workspaces.json<{ data: { role: string }[] }>().data).toEqual([
      expect.objectContaining({ name: 'Personal', role: 'owner' }),
    ]);
  });

  it('answers a wrong password, an unknown email and a locked account the same way', async () => {
    const account = await register();
    const locked = await register();
    await failTimes(locked.email, LOCKOUT_THRESHOLD);

    const responses = [
      await login(account.email, 'not the password'),
      await login(uniqueEmail(), PASSWORD),
      await login(locked.email, PASSWORD),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="secure-api"');
      const { instance, traceId, ...problem } = response.json<Record<string, unknown>>();
      expect(problem).toEqual({
        type: expect.stringContaining('#unauthorized'),
        title: 'Unauthorized',
        status: 401,
        detail: 'The email or password is incorrect.',
      });
      expect([instance, traceId]).toEqual([expect.any(String), expect.any(String)]);
      expect(response.cookies).toEqual([]);
    }
  });

  it('runs argon2 for an unknown email and a locked account too, so timing tells nothing', async () => {
    const locked = await register();
    await failTimes(locked.email, LOCKOUT_THRESHOLD);
    verifications.length = 0;

    await login(uniqueEmail(), PASSWORD);
    await login(locked.email, PASSWORD);

    expect(verifications).toEqual(['dummy', 'dummy']);
  });

  it('locks an account after consecutive failures from clients without a device cookie', async () => {
    const account = await register();

    await failTimes(account.email, LOCKOUT_THRESHOLD);

    expect((await login(account.email, PASSWORD)).statusCode).toBe(401);
    const { rows } = await api.testDatabase.database.pool.query<{ minutes: number }>(
      `SELECT round(extract(epoch FROM locked_until - now()) / 60)::int AS minutes
         FROM users WHERE id = $1`,
      [account.id],
    );
    expect(rows[0]?.minutes).toBe(15);
  });

  it('lets a client that already logged in through while the account is locked', async () => {
    const account = await register();
    const device = cookie(await login(account.email, PASSWORD), DEVICE)?.value;

    await failTimes(account.email, LOCKOUT_THRESHOLD); // an attacker, without the cookie

    expectStatus(await login(account.email, PASSWORD, device), 200);
    expect((await login(account.email, PASSWORD)).statusCode).toBe(401);
  });

  it('stops trusting a device cookie after repeated failures, without locking the account', async () => {
    const account = await register();
    const device = cookie(await login(account.email, PASSWORD), DEVICE)?.value;

    await failTimes(account.email, DEVICE_FAILURE_LIMIT - 1, device);
    const last = await login(account.email, 'still wrong', device);

    expect(last.statusCode).toBe(401);
    expect(cookie(last, DEVICE)).toMatchObject({ value: '', path: '/v1/auth/login' });
    await failTimes(account.email, LOCKOUT_THRESHOLD - 1); // untrusted failures still count apart
    const again = await login(account.email, PASSWORD, device);
    expectStatus(again, 200);
    expect(cookie(again, DEVICE)?.value).not.toBe(device); // a new device cookie
  });

  it('does not let the device cookie of another account bypass the lock', async () => {
    const owner = await register();
    const victim = await register();
    const device = cookie(await login(owner.email, PASSWORD), DEVICE)?.value;
    await failTimes(victim.email, LOCKOUT_THRESHOLD);

    expect((await login(victim.email, PASSWORD, device)).statusCode).toBe(401);
  });

  it('resets the failure count on success, and lets the lock expire', async () => {
    const account = await register();
    await failTimes(account.email, LOCKOUT_THRESHOLD - 1);
    expectStatus(await login(account.email, PASSWORD), 200);
    await failTimes(account.email, LOCKOUT_THRESHOLD - 1);
    expectStatus(await login(account.email, PASSWORD), 200);

    await failTimes(account.email, LOCKOUT_THRESHOLD);
    await api.testDatabase.database.pool.query(
      `UPDATE users SET locked_until = now() - interval '1 hour' WHERE id = $1`,
      [account.id],
    );

    expectStatus(await login(account.email, PASSWORD), 200);
  });

  it('rehashes a password stored with older parameters', async () => {
    const account = await register();
    const weaker = createPasswordHasher({ ...ARGON2_PARAMS, memoryCost: 8_192 });
    await api.testDatabase.database.pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [await weaker.hash(PASSWORD), account.id],
    );

    expectStatus(await login(account.email, PASSWORD), 200);

    const { rows } = await api.testDatabase.database.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [account.id],
    );
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
});

function refresh(refreshToken: string | undefined, headers: Record<string, string> = {}) {
  return api.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: {
      ...headers,
      ...(refreshToken === undefined ? {} : { cookie: `${REFRESH}=${refreshToken}` }),
    },
  });
}

/** Logs a new account in and returns its refresh token. */
async function session(): Promise<{ account: Account; refreshToken: string }> {
  const account = await register();
  const response = await login(account.email, PASSWORD);
  expectStatus(response, 200);
  const refreshToken = cookie(response, REFRESH)?.value;
  if (refreshToken === undefined) throw new Error('no refresh cookie');
  return { account, refreshToken };
}

async function familyOf(refreshToken: string) {
  const { rows } = await api.testDatabase.database.pool.query<{
    revoked_reason: string | null;
  }>(
    `SELECT f.revoked_reason FROM refresh_tokens t
       JOIN refresh_token_families f ON f.id = t.family_id
      WHERE t.token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [refreshToken],
  );
  return rows[0];
}

/** Makes a rotation look older than the reuse grace period. */
async function ageRotation(refreshToken: string) {
  await api.testDatabase.database.pool.query(
    `UPDATE refresh_tokens SET rotated_at = now() - interval '1 hour'
      WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [refreshToken],
  );
}

describe('POST /v1/auth/refresh', () => {
  it('exchanges the cookie for a new access token and a new refresh token', async () => {
    const { refreshToken } = await session();

    const response = await refresh(refreshToken);

    expectStatus(response, 200);
    const next = cookie(response, REFRESH);
    expect(next?.value).toMatch(/^[\w-]{43}$/);
    expect(next?.value).not.toBe(refreshToken);
    expect(next).toMatchObject({
      path: '/v1/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    const { accessToken } = response.json<{ accessToken: string }>();
    const me = await api.app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('revokes the whole session when an exchanged token is presented again', async () => {
    const { refreshToken } = await session();
    const next = cookie(await refresh(refreshToken), REFRESH)?.value;
    await ageRotation(refreshToken);

    const reuse = await refresh(refreshToken);

    expect(reuse.statusCode).toBe(401);
    expect(cookie(reuse, REFRESH)).toMatchObject({ value: '' });
    expect(await familyOf(refreshToken)).toEqual({ revoked_reason: 'reuse' });
    // The legitimate holder of the newer token is logged out too.
    expect((await refresh(next)).statusCode).toBe(401);
  });

  it('does not treat two tabs refreshing at once as reuse', async () => {
    const { refreshToken } = await session();

    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    const loser = results.find((response) => response.statusCode === 401);
    expect(loser?.cookies).toEqual([]); // keeps the newer cookie the winner set
    expect(await familyOf(refreshToken)).toEqual({ revoked_reason: null });
    const winner = results.find((response) => response.statusCode === 200);
    expectStatus(await refresh(winner && cookie(winner, REFRESH)?.value), 200);
  });

  it('rejects an idle token and a session past its absolute lifetime', async () => {
    const idle = await session();
    await api.testDatabase.database.pool.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 hour'
        WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [idle.refreshToken],
    );
    const ended = await session();
    await api.testDatabase.database.pool.query(
      `UPDATE refresh_token_families SET expires_at = now() - interval '1 hour'
        WHERE user_id = $1`,
      [ended.account.id],
    );

    for (const response of [await refresh(idle.refreshToken), await refresh(ended.refreshToken)]) {
      expect(response.statusCode).toBe(401);
      expect(cookie(response, REFRESH)).toMatchObject({ value: '' });
    }
  });

  it('never extends a token past the end of the session', async () => {
    const { account, refreshToken } = await session();
    await api.testDatabase.database.pool.query(
      `UPDATE refresh_token_families SET expires_at = now() + interval '1 hour' WHERE user_id = $1`,
      [account.id],
    );

    const response = await refresh(refreshToken);

    expectStatus(response, 200);
    expect(cookie(response, REFRESH)?.maxAge).toBeGreaterThan(3_500);
    expect(cookie(response, REFRESH)?.maxAge).toBeLessThanOrEqual(3_600);
  });

  it.each([
    ['no cookie', undefined],
    ['a malformed cookie', 'not-a-token'],
    ['an unknown token', 'x'.repeat(43)],
  ])('answers 401 to %s', async (_case, token) => {
    const response = await refresh(token);

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="secure-api"');
  });

  it('refuses cross-site requests, before touching the token', async () => {
    const { refreshToken } = await session();

    const forged = [
      await refresh(refreshToken, { origin: 'https://evil.example' }),
      await refresh(refreshToken, { 'sec-fetch-site': 'cross-site' }),
      await refresh(refreshToken, { origin: 'null' }),
    ];

    expect(forged.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expectStatus(await refresh(refreshToken, { origin: 'http://localhost:80' }), 200);
  });
});
