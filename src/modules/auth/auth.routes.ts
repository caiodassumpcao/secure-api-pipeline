import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { ROLES } from '../../db/schema.ts';
import { idSchema, noContentSchema, problemResponses, timestampSchema } from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import { INVALID_CREDENTIALS, type AuthService } from './auth.service.ts';
import {
  clearDeviceCookie,
  clearRefreshCookie,
  DEVICE_COOKIE,
  readTokenCookie,
  REFRESH_COOKIE,
  setDeviceCookie,
  setRefreshCookie,
} from './cookies.ts';
import { assertNotCrossSite } from './csrf.ts';
import { DEVICE_TTL_MS, REFRESH_TOKEN_TTL_MS } from './policy.ts';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/**
 * Bounded only against abuse; the password policy reports length problems
 * (counted in characters, not bytes) on registration.
 */
export const passwordSchema = z.string().min(1).max(1_024);

export const userSchema = z
  .object({
    id: idSchema,
    email: z.string(),
    name: z.string(),
    createdAt: timestampSchema,
  })
  .meta({ id: 'User' });

export const accessTokenSchema = z
  .object({
    accessToken: z.string().describe('Send as `Authorization: Bearer <accessToken>`.'),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().describe('Seconds until the access token expires.'),
  })
  .meta({ id: 'AccessToken' });

const tags = ['auth'];

/** RFC 9110 requires a challenge with every 401. */
const CHALLENGE = 'Bearer realm="secure-api"';

export interface AuthRoutesOptions {
  readonly service: AuthService;
  /** Browser origins allowed to use the refresh cookie, besides the API's own. */
  readonly allowedOrigins: readonly string[];
}

const refreshCookieSecurity = [{ refreshCookie: [] }];

/** Public routes under `/v1/auth`: no access token needed. */
export const authRoutes: FastifyPluginCallbackZod<AuthRoutesOptions> = (
  app,
  { service, allowedOrigins },
  done,
) => {
  app.post(
    '/register',
    {
      schema: {
        tags,
        summary: 'Create an account, with a personal workspace it owns',
        security: [],
        body: z
          .object({
            email: emailSchema,
            password: passwordSchema.describe(
              '12 to 128 characters; common breached passwords are refused.',
            ),
            name: z.string().trim().min(1).max(100),
          })
          .strict(),
        response: { 201: userSchema, ...problemResponses(400, 409) },
      },
    },
    async (request, reply) => {
      const user = await service.register(request.body);
      return reply.code(201).header('location', '/v1/me').send(user);
    },
  );

  app.post(
    '/login',
    {
      schema: {
        tags,
        summary: 'Log in: returns an access token and sets the refresh-token cookie',
        description:
          'Also sets a device cookie: clients that already logged in are not locked out when someone else keeps failing to log in to the account.',
        security: [],
        body: z.object({ email: emailSchema, password: passwordSchema }).strict(),
        response: { 200: accessTokenSchema, ...problemResponses(400, 401) },
      },
    },
    async (request, reply) => {
      const result = await service.login(request.body, {
        deviceToken: readTokenCookie(request, DEVICE_COOKIE),
      });
      if (result.status === 'failed') {
        if (result.deviceRevoked) clearDeviceCookie(reply);
        reply.header('www-authenticate', CHALLENGE);
        throw new HttpProblem(ProblemTypes.unauthorized, INVALID_CREDENTIALS);
      }
      if (result.deviceToken !== undefined) {
        setDeviceCookie(reply, result.deviceToken, DEVICE_TTL_MS);
      }
      setRefreshCookie(reply, result.refreshToken, REFRESH_TOKEN_TTL_MS);
      return {
        accessToken: result.accessToken,
        tokenType: 'Bearer' as const,
        expiresIn: result.expiresIn,
      };
    },
  );

  app.post(
    '/refresh',
    {
      schema: {
        tags,
        summary: 'Exchange the refresh-token cookie for a new access token and a new cookie',
        description:
          'Each refresh token works once. Presenting one that was already exchanged ends the whole session (reuse detection), unless it was exchanged in the last seconds.',
        security: refreshCookieSecurity,
        response: { 200: accessTokenSchema, ...problemResponses(401, 403) },
      },
    },
    async (request, reply) => {
      assertNotCrossSite(request, allowedOrigins);
      const result = await service.refresh(readTokenCookie(request, REFRESH_COOKIE));
      if (result.status !== 'rotated') {
        if (result.status === 'reuse_detected' || result.clearCookie) clearRefreshCookie(reply);
        reply.header('www-authenticate', CHALLENGE);
        throw new HttpProblem(ProblemTypes.unauthorized, 'The session has ended; log in again.');
      }
      setRefreshCookie(reply, result.refreshToken, result.refreshExpiresAt.getTime() - Date.now());
      return {
        accessToken: result.accessToken,
        tokenType: 'Bearer' as const,
        expiresIn: result.expiresIn,
      };
    },
  );

  app.post(
    '/logout',
    {
      schema: {
        tags,
        summary: 'End the session of the refresh-token cookie',
        description:
          'Always 204, whether or not a session was found. Access tokens already issued stay valid until they expire.',
        security: refreshCookieSecurity,
        response: { 204: noContentSchema, ...problemResponses(403) },
      },
    },
    async (request, reply) => {
      assertNotCrossSite(request, allowedOrigins);
      await service.logout(readTokenCookie(request, REFRESH_COOKIE));
      clearRefreshCookie(reply);
      return reply.code(204).send(null);
    },
  );

  done();
};

export const meSchema = userSchema
  .extend({
    memberships: z
      .array(
        z.object({
          workspaceId: idSchema,
          name: z.string(),
          slug: z.string(),
          role: z.enum(ROLES),
        }),
      )
      .describe('Up to 100 workspaces; `GET /v1/workspaces` lists them all with pagination.'),
  })
  .meta({ id: 'Me' });

export interface MeRoutesOptions {
  readonly service: AuthService;
}

/** `/v1/me`, behind authentication. */
export const meRoutes: FastifyPluginCallbackZod<MeRoutesOptions> = (app, { service }, done) => {
  app.get(
    '/me',
    {
      schema: {
        tags,
        summary: 'The caller: account and workspace memberships',
        response: { 200: meSchema, ...problemResponses(401) },
      },
    },
    async (request) => service.me(currentUser(request).id),
  );
  done();
};
