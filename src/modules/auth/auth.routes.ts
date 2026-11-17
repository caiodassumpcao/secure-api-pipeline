import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { idSchema, problemResponses, timestampSchema } from '../../lib/schemas.ts';
import { INVALID_CREDENTIALS, type AuthService } from './auth.service.ts';
import {
  clearDeviceCookie,
  DEVICE_COOKIE,
  readTokenCookie,
  setDeviceCookie,
  setRefreshCookie,
} from './cookies.ts';
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
}

/** Public routes under `/v1/auth`: no access token needed. */
export const authRoutes: FastifyPluginCallbackZod<AuthRoutesOptions> = (app, { service }, done) => {
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

  done();
};
