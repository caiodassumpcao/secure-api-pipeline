import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from '../../db/schema.ts';
import { pageSchema, paginationQuery } from '../../lib/pagination.ts';
import {
  idSchema,
  noContentSchema,
  NOT_EMPTY_MESSAGE,
  notEmpty,
  problemResponses,
  textSchema,
  timestampSchema,
} from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import type { TasksService } from './tasks.service.ts';

const statusSchema = z.enum(TASK_STATUSES);
const prioritySchema = z.enum(TASK_PRIORITIES);
const titleSchema = textSchema.trim().min(1).max(200);
const descriptionSchema = textSchema.max(5_000).nullable();
const dueDateSchema = z.iso.date().nullable().describe('Calendar date (YYYY-MM-DD).');

export const taskSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    title: z.string(),
    description: z.string().nullable(),
    status: statusSchema,
    priority: prioritySchema,
    assigneeId: idSchema.nullable(),
    dueDate: z.string().nullable(),
    createdBy: idSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .meta({ id: 'Task' });

const taskFields = {
  description: descriptionSchema.optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  assigneeId: idSchema.nullable().optional().describe('Must be a member of the workspace.'),
  dueDate: dueDateSchema.optional(),
};

const projectParams = z.object({ wsId: idSchema, projectId: idSchema }).strict();
const taskParams = z.object({ wsId: idSchema, taskId: idSchema }).strict();

const tags = ['tasks'];

export interface TaskRoutesOptions {
  readonly service: TasksService;
}

export const taskRoutes: FastifyPluginCallbackZod<TaskRoutesOptions> = (app, { service }, done) => {
  app.get(
    '/workspaces/:wsId/projects/:projectId/tasks',
    {
      schema: {
        tags,
        summary: 'List the tasks of a project',
        params: projectParams,
        querystring: z
          .object({
            ...paginationQuery,
            status: statusSchema.optional(),
            priority: prioritySchema.optional(),
            assigneeId: idSchema.optional(),
          })
          .strict(),
        response: { 200: pageSchema(taskSchema), ...problemResponses(400, 401, 404) },
      },
    },
    async (request) => {
      const { limit, cursor, ...filters } = request.query;
      return service.list(
        currentUser(request).id,
        request.params.wsId,
        request.params.projectId,
        filters,
        { limit, after: cursor },
      );
    },
  );

  app.post(
    '/workspaces/:wsId/projects/:projectId/tasks',
    {
      schema: {
        tags,
        summary: 'Create a task (owner, admin, member)',
        params: projectParams,
        body: z.object({ title: titleSchema, ...taskFields }).strict(),
        response: { 201: taskSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      const task = await service.create(
        currentUser(request).id,
        request.params.wsId,
        request.params.projectId,
        request.body,
      );
      return reply
        .code(201)
        .header('location', `/v1/workspaces/${request.params.wsId}/tasks/${task.id}`)
        .send(task);
    },
  );

  app.get(
    '/workspaces/:wsId/tasks/:taskId',
    {
      schema: {
        tags,
        summary: 'Get a task',
        params: taskParams,
        response: { 200: taskSchema, ...problemResponses(400, 401, 404) },
      },
    },
    async (request) =>
      service.get(currentUser(request).id, request.params.wsId, request.params.taskId),
  );

  app.patch(
    '/workspaces/:wsId/tasks/:taskId',
    {
      schema: {
        tags,
        summary: 'Update a task (owner, admin, member)',
        params: taskParams,
        body: z
          .object({ title: titleSchema.optional(), ...taskFields })
          .strict()
          .refine(notEmpty, NOT_EMPTY_MESSAGE),
        response: { 200: taskSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) =>
      service.update(
        currentUser(request).id,
        request.params.wsId,
        request.params.taskId,
        request.body,
      ),
  );

  app.delete(
    '/workspaces/:wsId/tasks/:taskId',
    {
      schema: {
        tags,
        summary: 'Delete a task (owner, admin; members only their own)',
        params: taskParams,
        response: { 204: noContentSchema, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request, reply) => {
      await service.delete(currentUser(request).id, request.params.wsId, request.params.taskId);
      return reply.code(204).send(null);
    },
  );

  done();
};
