import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idSchema, problemResponses, timestampSchema } from '../../lib/schemas.ts';
import type { AuthService } from './auth.service.ts';

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

const tags = ['auth'];

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

  done();
};
