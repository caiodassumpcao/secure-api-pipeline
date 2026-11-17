import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUDIT_RETENTION_DAYS } from '../../db/schema.ts';
import { pageSchema, paginationQuery } from '../../lib/pagination.ts';
import { idSchema, problemResponses, timestampSchema } from '../../lib/schemas.ts';
import { currentUser } from '../../plugins/authentication.ts';
import { AUDIT_ACTIONS } from './audit.ts';
import type { AuditService } from './audit.service.ts';

export const auditEventSchema = z
  .object({
    id: idSchema,
    action: z.string(),
    actorId: idSchema.nullable().describe('The user who acted; null when unauthenticated.'),
    target: z.string().nullable().describe('What the action was about, e.g. `user:<id>`.'),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: timestampSchema,
  })
  .meta({ id: 'AuditEvent' });

export interface AuditRoutesOptions {
  readonly service: AuditService;
}

export const auditRoutes: FastifyPluginCallbackZod<AuditRoutesOptions> = (
  app,
  { service },
  done,
) => {
  app.get(
    '/workspaces/:wsId/audit-events',
    {
      schema: {
        tags: ['audit'],
        summary: 'Read the audit log of a workspace, newest first (owner, admin)',
        description: `Events are kept ${AUDIT_RETENTION_DAYS} days; they hold client IP addresses, which are personal data.`,
        params: z.object({ wsId: idSchema }).strict(),
        querystring: z
          .object({ ...paginationQuery, action: z.enum(AUDIT_ACTIONS).optional() })
          .strict(),
        response: { 200: pageSchema(auditEventSchema), ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request) => {
      const { limit, cursor, action } = request.query;
      return service.list(
        currentUser(request).id,
        request.params.wsId,
        { limit, after: cursor },
        { action },
      );
    },
  );
  done();
};
