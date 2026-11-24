import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLES } from '../../db/schema.ts';
import { pageSchema, paginationQuery } from '../../lib/pagination.ts';
import {
  idSchema,
  nameSchema,
  noContentSchema,
  NOT_EMPTY_MESSAGE,
  notEmpty,
  problemResponses,
  textSchema,
  timestampSchema,
} from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import { requestContext } from '../audit/audit.ts';
import type { WorkspacesService } from './workspaces.service.ts';

const slugSchema = textSchema
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3–48 lowercase letters, digits or hyphens')
  .describe('Unique, URL-friendly identifier.');

export const workspaceSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    slug: z.string(),
    role: z.enum(ROLES).describe('Role of the caller in this workspace.'),
    createdAt: timestampSchema,
  })
  .meta({ id: 'Workspace' });

const workspaceParams = z.object({ wsId: idSchema }).strict();

const tags = ['workspaces'];

export interface WorkspaceRoutesOptions {
  readonly service: WorkspacesService;
}

export const workspaceRoutes: FastifyPluginCallbackZod<WorkspaceRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.get(
    '/workspaces',
    {
      schema: {
        tags,
        summary: 'List the workspaces the caller belongs to',
        querystring: z.object(paginationQuery).strict(),
        response: { 200: pageSchema(workspaceSchema), ...problemResponses(400, 401) },
      },
    },
    async (request) =>
      service.list(currentUser(request).id, {
        limit: request.query.limit,
        after: request.query.cursor,
      }),
  );

  app.post(
    '/workspaces',
    {
      schema: {
        tags,
        summary: 'Create a workspace; the caller becomes its owner',
        body: z.object({ name: nameSchema, slug: slugSchema }).strict(),
        response: { 201: workspaceSchema, ...problemResponses(400, 401, 409) },
      },
    },
    async (request, reply) => {
      const workspace = await service.create(currentUser(request).id, request.body);
      return reply.code(201).header('location', `/v1/workspaces/${workspace.id}`).send(workspace);
    },
  );

  app.get(
    '/workspaces/:wsId',
    {
      schema: {
        tags,
        summary: 'Get a workspace',
        params: workspaceParams,
        response: { 200: workspaceSchema, ...problemResponses(400, 401, 404) },
      },
    },
    async (request) => service.get(currentUser(request).id, request.params.wsId),
  );

  app.patch(
    '/workspaces/:wsId',
    {
      schema: {
        tags,
        summary: 'Rename a workspace or change its slug (owner, admin)',
        params: workspaceParams,
        body: z
          .object({ name: nameSchema.optional(), slug: slugSchema.optional() })
          .strict()
          .refine(notEmpty, NOT_EMPTY_MESSAGE),
        response: { 200: workspaceSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) => service.update(currentUser(request).id, request.params.wsId, request.body),
  );

  app.delete(
    '/workspaces/:wsId',
    {
      schema: {
        tags,
        summary: 'Delete a workspace and everything in it (owner)',
        params: workspaceParams,
        response: { 204: noContentSchema, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request, reply) => {
      await service.delete(currentUser(request).id, request.params.wsId, requestContext(request));
      return reply.code(204).send(null);
    },
  );

  done();
};
