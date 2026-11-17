import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKLIST } from '../../src/modules/auth/blocklist.ts';
import { expectStatus, TestApi } from './helpers/api.ts';

let api: TestApi;

beforeAll(async () => {
  api = await TestApi.start();
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
