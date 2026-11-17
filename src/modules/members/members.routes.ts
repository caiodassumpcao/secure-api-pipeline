import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLES } from '../../db/schema.ts';
import { pageSchema, paginationQuery } from '../../lib/pagination.ts';
import { idSchema, noContentSchema, problemResponses, timestampSchema } from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import { requestContext } from '../audit/audit.ts';
import type { MembersService } from './members.service.ts';

const roleSchema = z.enum(ROLES);

export const memberSchema = z
  .object({
    userId: idSchema,
    email: z.string(),
    name: z.string(),
    role: roleSchema,
    joinedAt: timestampSchema,
  })
  .meta({ id: 'Member' });

const workspaceParams = z.object({ wsId: idSchema }).strict();
const memberParams = z.object({ wsId: idSchema, userId: idSchema }).strict();

const tags = ['members'];

export interface MemberRoutesOptions {
  readonly service: MembersService;
}

export const memberRoutes: FastifyPluginCallbackZod<MemberRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.get(
    '/workspaces/:wsId/members',
    {
      schema: {
        tags,
        summary: 'List members',
        params: workspaceParams,
        querystring: z.object(paginationQuery).strict(),
        response: { 200: pageSchema(memberSchema), ...problemResponses(400, 401, 404) },
      },
    },
    async (request) =>
      service.list(currentUser(request).id, request.params.wsId, {
        limit: request.query.limit,
        after: request.query.cursor,
      }),
  );

  app.get(
    '/workspaces/:wsId/members/:userId',
    {
      schema: {
        tags,
        summary: 'Get a member',
        params: memberParams,
        response: { 200: memberSchema, ...problemResponses(400, 401, 404) },
      },
    },
    async (request) =>
      service.get(currentUser(request).id, request.params.wsId, request.params.userId),
  );

  app.patch(
    '/workspaces/:wsId/members/:userId',
    {
      schema: {
        tags,
        summary: 'Change a member’s role (owner, admin; only owners change owners)',
        params: memberParams,
        body: z.object({ role: roleSchema }).strict(),
        response: { 200: memberSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      service.changeRole(
        currentUser(request).id,
        request.params.wsId,
        request.params.userId,
        request.body.role,
        requestContext(request),
      ),
  );

  app.delete(
    '/workspaces/:wsId/members/:userId',
    {
      schema: {
        tags,
        summary:
          'Remove a member and unassign their tasks (owner, admin; only owners remove owners)',
        params: memberParams,
        response: { 204: noContentSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await service.remove(
        currentUser(request).id,
        request.params.wsId,
        request.params.userId,
        requestContext(request),
      );
      return reply.code(204).send(null);
    },
  );

  done();
};
