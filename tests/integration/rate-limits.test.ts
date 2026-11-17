import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCleanup } from '../../src/jobs/cleanup.ts';
import { createRateLimiter } from '../../src/lib/rate-limiter.ts';
import {
  LOGIN_PER_EMAIL,
  LOGIN_PER_IP,
  REFRESH_PER_IP,
  REGISTER_PER_IP,
} from '../../src/modules/auth/policy.ts';
import { expectStatus, TestApi } from './helpers/api.ts';

let api: TestApi;

beforeAll(async () => {
  api = await TestApi.start({ rateLimits: true });
});

afterAll(async () => {
  await api.stop();
});

const PASSWORD = 'correct horse battery staple';
let ipSequence = 0;
/** A fresh client address per test, so tests do not share per-IP counters. */
const nextIp = () => {
  ipSequence += 1;
  return `198.51.100.${ipSequence}`;
};
let emailSequence = 0;
const uniqueEmail = () => {
  emailSequence += 1;
  return `limited-${emailSequence}-${Date.now()}@example.test`;
};

function post(url: string, remoteAddress: string, payload?: object, cookie?: string) {
  return api.app.inject({
    method: 'POST',
    url,
    remoteAddress,
    ...(payload === undefined ? {} : { payload }),
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function register(email: string) {
  expectStatus(
    await post('/v1/auth/register', nextIp(), { email, password: PASSWORD, name: 'Ana' }),
    201,
  );
}

function expectLimited(response: { statusCode: number; headers: Record<string, unknown> }) {
  expect(response.statusCode).toBe(429);
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
}

describe('PostgreSQL rate limiter', () => {
  const rule = { name: 'test', max: 3, windowMs: 60_000 };

  it('counts hits atomically across concurrent requests', async () => {
    const limiter = createRateLimiter(api.db);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.hit(rule, 'concurrent')),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(rule.max);
  });

  it('starts a new window once the previous one ended', async () => {
    const limiter = createRateLimiter(api.db);
    for (let index = 0; index < rule.max; index += 1) await limiter.hit(rule, 'window');
    expect((await limiter.hit(rule, 'window')).allowed).toBe(false);

    await api.testDatabase.database.pool.query(
      `UPDATE rate_limits SET reset_at = now() - interval '1 hour' WHERE key LIKE 'test:%'`,
    );

    expect((await limiter.hit(rule, 'window')).allowed).toBe(true);
  });

  it('stores hashed keys, never addresses or emails', async () => {
    await createRateLimiter(api.db).hit(rule, 'ana@example.test');

    const { rows } = await api.testDatabase.database.pool.query<{ key: string }>(
      'SELECT key FROM rate_limits',
    );
    expect(rows.map((row) => row.key)).not.toContainEqual(expect.stringContaining('@'));
    expect(rows.every((row) => /^[\w-]+:[0-9a-f]{64}$/.test(row.key))).toBe(true);
  });
});

describe('authentication limits', () => {
  it('limit login attempts per IP address', async () => {
    const ip = nextIp();
    for (let index = 0; index < LOGIN_PER_IP.max; index += 1) {
      await post('/v1/auth/login', ip, { email: uniqueEmail(), password: PASSWORD });
    }

    expectLimited(await post('/v1/auth/login', ip, { email: uniqueEmail(), password: PASSWORD }));
    expect(
      (await post('/v1/auth/login', nextIp(), { email: uniqueEmail(), password: PASSWORD }))
        .statusCode,
    ).toBe(401);
  });

  it('limit login attempts per email from untrusted clients, known account or not', async () => {
    const known = uniqueEmail();
    await register(known);
    const unknown = uniqueEmail();

    for (const email of [known, unknown]) {
      for (let index = 0; index < LOGIN_PER_EMAIL.max; index += 1) {
        await post('/v1/auth/login', nextIp(), { email, password: 'wrong password!' });
      }
      expectLimited(await post('/v1/auth/login', nextIp(), { email, password: PASSWORD }));
    }
  });

  it('do not hold a client with a device cookie to the per-email limit', async () => {
    const email = uniqueEmail();
    await register(email);
    const first = await post('/v1/auth/login', nextIp(), { email, password: PASSWORD });
    const device = first.cookies.find((cookie) => cookie.name === '__Secure-device')?.value;
    for (let index = 0; index < LOGIN_PER_EMAIL.max; index += 1) {
      await post('/v1/auth/login', nextIp(), { email, password: 'an attacker guessing' });
    }

    const owner = await post(
      '/v1/auth/login',
      nextIp(),
      { email, password: PASSWORD },
      `__Secure-device=${device}`,
    );

    expectStatus(owner, 200);
  });

  it('limit registrations per IP address', async () => {
    const ip = nextIp();
    for (let index = 0; index < REGISTER_PER_IP.max; index += 1) {
      expectStatus(
        await post('/v1/auth/register', ip, {
          email: uniqueEmail(),
          password: PASSWORD,
          name: 'A',
        }),
        201,
      );
    }

    expectLimited(
      await post('/v1/auth/register', ip, { email: uniqueEmail(), password: PASSWORD, name: 'A' }),
    );
  });

  it('limit refreshes per IP address', async () => {
    const ip = nextIp();
    for (let index = 0; index < REFRESH_PER_IP.max; index += 1) {
      expect((await post('/v1/auth/refresh', ip)).statusCode).toBe(401);
    }

    expectLimited(await post('/v1/auth/refresh', ip));
  });
});

describe('cleanup', () => {
  it('deletes expired windows, sessions and devices, and keeps the rest', async () => {
    const email = uniqueEmail();
    await register(email);
    await post('/v1/auth/login', nextIp(), { email, password: PASSWORD });
    await post('/v1/auth/login', nextIp(), { email, password: PASSWORD });
    const { pool } = api.testDatabase.database;
    await pool.query(
      `UPDATE refresh_token_families SET expires_at = now() - interval '1 hour'
        WHERE id = (SELECT min(id::text)::uuid FROM refresh_token_families)`,
    );
    await pool.query(
      `UPDATE trusted_devices SET revoked_at = now()
        WHERE id = (SELECT min(id::text)::uuid FROM trusted_devices)`,
    );
    await pool.query(`UPDATE rate_limits SET reset_at = now() - interval '1 hour'`);
    const count = async (table: string) =>
      Number((await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count);
    const before = {
      families: await count('refresh_token_families'),
      devices: await count('trusted_devices'),
    };

    const report = await runCleanup(api.db);

    expect(report.skipped).toBe(false);
    expect(report.deleted.refresh_token_families).toBe(1);
    expect(report.deleted.trusted_devices).toBe(1);
    expect(await count('rate_limits')).toBe(0);
    expect(await count('refresh_token_families')).toBe(before.families - 1);
    expect(await count('trusted_devices')).toBe(before.devices - 1);
  });

  it('skips the round while another instance holds the lock', async () => {
    const other = await api.testDatabase.database.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(7394201002)');

      expect(await runCleanup(api.db)).toEqual({ skipped: true, deleted: {} });
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
  });
});
