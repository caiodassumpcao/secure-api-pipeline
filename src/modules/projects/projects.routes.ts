import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pageSchema, paginationQuery } from '../../lib/pagination.ts';
import {
  idSchema,
  nameSchema,
  noContentSchema,
  problemResponses,
  timestampSchema,
} from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import type { ProjectsService } from './projects.service.ts';

export const projectSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    archivedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .meta({ id: 'Project' });

const workspaceParams = z.object({ wsId: idSchema }).strict();
const projectParams = z.object({ wsId: idSchema, projectId: idSchema }).strict();

const tags = ['projects'];

export interface ProjectRoutesOptions {
  readonly service: ProjectsService;
}

export const projectRoutes: FastifyPluginCallbackZod<ProjectRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.get(
    '/workspaces/:wsId/projects',
    {
      schema: {
        tags,
        summary: 'List projects',
        params: workspaceParams,
        querystring: z
          .object({
            ...paginationQuery,
            includeArchived: z
              .enum(['true', 'false'])
              .default('false')
              .transform((value) => value === 'true')
              .describe('Include archived projects.'),
          })
          .strict(),
        response: { 200: pageSchema(projectSchema), ...problemResponses(400, 401, 404) },
      },
    },
    async (request) =>
      service.list(
        currentUser(request).id,
        request.params.wsId,
        { limit: request.query.limit, after: request.query.cursor },
        { includeArchived: request.query.includeArchived },
      ),
  );

  app.post(
    '/workspaces/:wsId/projects',
    {
      schema: {
        tags,
        summary: 'Create a project (owner, admin)',
        params: workspaceParams,
        body: z.object({ name: nameSchema }).strict(),
        response: { 201: projectSchema, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request, reply) => {
      const project = await service.create(
        currentUser(request).id,
        request.params.wsId,
        request.body,
      );
      return reply
        .code(201)
        .header('location', `/v1/workspaces/${request.params.wsId}/projects/${project.id}`)
        .send(project);
    },
  );

  app.get(
    '/workspaces/:wsId/projects/:projectId',
    {
      schema: {
        tags,
        summary: 'Get a project',
        params: projectParams,
        response: { 200: projectSchema, ...problemResponses(400, 401, 404) },
      },
    },
    async (request) =>
      service.get(currentUser(request).id, request.params.wsId, request.params.projectId),
  );

  app.patch(
    '/workspaces/:wsId/projects/:projectId',
    {
      schema: {
        tags,
        summary: 'Rename a project (owner, admin)',
        params: projectParams,
        body: z.object({ name: nameSchema }).strict(),
        response: { 200: projectSchema, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request) =>
      service.rename(
        currentUser(request).id,
        request.params.wsId,
        request.params.projectId,
        request.body.name,
      ),
  );

  app.delete(
    '/workspaces/:wsId/projects/:projectId',
    {
      schema: {
        tags,
        summary: 'Archive a project; its tasks become read-only (owner, admin)',
        params: projectParams,
        response: { 204: noContentSchema, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request, reply) => {
      await service.archive(currentUser(request).id, request.params.wsId, request.params.projectId);
      return reply.code(204).send(null);
    },
  );

  done();
};
