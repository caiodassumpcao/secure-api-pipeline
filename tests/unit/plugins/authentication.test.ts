import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPE_BASE_URI } from '../../../src/lib/problem.ts';
import {
  createBearerAuthenticator,
  currentUser,
  registerAuthentication,
} from '../../../src/plugins/authentication.ts';
import { registerErrorHandler } from '../../../src/plugins/error-handler.ts';
import { createTestTokenService } from '../../helpers/keys.ts';
import { buildTestApp } from '../../helpers/test-app.ts';

const USER_ID = '0190f3b2-7c1e-7d2a-9f00-1234567890ab';
const requestWith = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

describe('bearer authenticator', () => {
  it('identifies the caller from a valid access token', async () => {
    const tokens = await createTestTokenService();
    const { accessToken } = await tokens.issueAccessToken(USER_ID);
    const authenticate = createBearerAuthenticator(tokens);

    expect(await authenticate(requestWith(`Bearer ${accessToken}`))).toEqual({ id: USER_ID });
    expect(await authenticate(requestWith(`bearer ${accessToken}`))).toEqual({ id: USER_ID });
  });

  it.each([
    ['no header', undefined],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['an empty token', 'Bearer '],
    ['garbage', 'Bearer not-a-token'],
  ])('authenticates nobody with %s', async (_case, header) => {
    const authenticate = createBearerAuthenticator(await createTestTokenService());

    expect(await authenticate(requestWith(header))).toBeNull();
  });

  it('rejects a token signed by another key', async () => {
    const other = await createTestTokenService();
    const { accessToken } = await other.issueAccessToken(USER_ID);
    const authenticate = createBearerAuthenticator(await createTestTokenService());

    expect(await authenticate(requestWith(`Bearer ${accessToken}`))).toBeNull();
  });
});

describe('protected routes', () => {
  async function protectedApp() {
    const tokens = await createTestTokenService();
    const app = Fastify();
    registerErrorHandler(app);
    registerAuthentication(app, createBearerAuthenticator(tokens));
    app.get('/whoami', (request) => currentUser(request));
    return { app, tokens };
  }

  it('let authenticated callers through', async () => {
    const { app, tokens } = await protectedApp();
    const { accessToken } = await tokens.issueAccessToken(USER_ID);

    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.json()).toEqual({ id: USER_ID });
  });

  it('answer 401 with a challenge when credentials are missing', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/v1/workspaces' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="secure-api"');
    expect(response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_BASE_URI}unauthorized`,
      detail: 'Authentication is required.',
    });
  });

  it('flag a rejected token as invalid_token, so clients refresh it', async () => {
    const { app } = await protectedApp();

    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer expired.or.forged' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="secure-api", error="invalid_token"',
    );
  });

  it('do not cover the health endpoints', async () => {
    const { app } = await buildTestApp();

    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('currentUser', () => {
  it('throws 401 when the request is not authenticated', () => {
    expect(() => currentUser({ user: null } as FastifyRequest)).toThrow(
      'Authentication is required.',
    );
  });
});
