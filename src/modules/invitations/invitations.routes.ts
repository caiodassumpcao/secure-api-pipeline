import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLES } from '../../db/schema.ts';
import { opaqueTokenSchema } from '../../lib/opaque-token.ts';
import { pageSchema, paginationQuery } from '../../lib/pagination.ts';
import { rateLimitBy, type RateLimiter } from '../../lib/rate-limiter.ts';
import { idSchema, noContentSchema, problemResponses, timestampSchema } from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import { requestContext } from '../audit/audit.ts';
import { emailSchema } from '../auth/auth.routes.ts';
import { workspaceSchema } from '../workspaces/workspaces.routes.ts';
import type { InvitationsService } from './invitations.service.ts';

const MINUTE = 60_000;
/** Invitations created per user and hour (ADR-0009). */
export const INVITE_PER_USER = { name: 'invite-user', max: 20, windowMs: 60 * MINUTE } as const;
/** Acceptance attempts per user and minute: links are 256-bit, this caps the noise. */
export const ACCEPT_PER_USER = { name: 'accept-user', max: 10, windowMs: MINUTE } as const;

export const invitationSchema = z
  .object({
    id: idSchema,
    role: z.enum(ROLES),
    email: z.string().nullable().describe('Only the account with this email can accept.'),
    invitedBy: idSchema.nullable(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .meta({ id: 'Invitation' });

const createdInvitationSchema = invitationSchema
  .extend({
    token: z
      .string()
      .describe(
        'Single-use secret for POST /v1/invitations/accept. Returned only here: share it with the invitee over a channel you trust.',
      ),
  })
  .meta({ id: 'CreatedInvitation' });

const workspaceParams = z.object({ wsId: idSchema }).strict();
const tags = ['members'];

export interface InvitationRoutesOptions {
  readonly service: InvitationsService;
  readonly limiter: RateLimiter;
}

export const invitationRoutes: FastifyPluginCallbackZod<InvitationRoutesOptions> = (
  app,
  { service, limiter },
  done,
) => {
  app.post(
    '/workspaces/:wsId/invitations',
    {
      schema: {
        tags,
        summary: 'Invite someone with a single-use link (owner, admin; only owners invite owners)',
        params: workspaceParams,
        body: z.object({ role: z.enum(ROLES), email: emailSchema.optional() }).strict(),
        response: { 201: createdInvitationSchema, ...problemResponses(400, 401, 403, 404, 429) },
      },
      preHandler: rateLimitBy(limiter, INVITE_PER_USER, (request) => currentUser(request).id),
    },
    async (request, reply) => {
      const invitation = await service.create(
        currentUser(request).id,
        request.params.wsId,
        request.body,
        requestContext(request),
      );
      return reply.code(201).send(invitation);
    },
  );

  app.get(
    '/workspaces/:wsId/invitations',
    {
      schema: {
        tags,
        summary: 'List pending invitations (owner, admin)',
        params: workspaceParams,
        querystring: z.object(paginationQuery).strict(),
        response: { 200: pageSchema(invitationSchema), ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      service.list(currentUser(request).id, request.params.wsId, {
        limit: request.query.limit,
        after: request.query.cursor,
      }),
  );

  app.delete(
    '/workspaces/:wsId/invitations/:invitationId',
    {
      schema: {
        tags,
        summary: 'Revoke a pending invitation (owner, admin; only owners revoke owner invitations)',
        params: z.object({ wsId: idSchema, invitationId: idSchema }).strict(),
        response: { 204: noContentSchema, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request, reply) => {
      await service.revoke(
        currentUser(request).id,
        request.params.wsId,
        request.params.invitationId,
        requestContext(request),
      );
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/invitations/accept',
    {
      schema: {
        tags,
        summary: 'Accept an invitation link and join its workspace',
        body: z.object({ token: opaqueTokenSchema }).strict(),
        response: { 201: workspaceSchema, ...problemResponses(400, 401, 404, 409, 429) },
      },
      preHandler: rateLimitBy(limiter, ACCEPT_PER_USER, (request) => currentUser(request).id),
    },
    async (request, reply) => {
      const workspace = await service.accept(
        currentUser(request).id,
        request.body.token,
        requestContext(request),
      );
      return reply.code(201).header('location', `/v1/workspaces/${workspace.id}`).send(workspace);
    },
  );

  done();
};
