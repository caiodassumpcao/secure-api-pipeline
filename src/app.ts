import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from './db/database.ts';
import { healthRoutes, type ReadinessProbe } from './modules/health/health.routes.ts';
import { memberRoutes } from './modules/members/members.routes.ts';
import { createMembersService } from './modules/members/members.service.ts';
import { workspaceRoutes } from './modules/workspaces/workspaces.routes.ts';
import { createWorkspacesService } from './modules/workspaces/workspaces.service.ts';
import { registerAuthentication, type Authenticator } from './plugins/authentication.ts';
import { frameworkErrorHandler, registerErrorHandler } from './plugins/error-handler.ts';
import { generateRequestId, registerRequestIdHeader } from './plugins/request-id.ts';

/** Request body cap (DoS control, DESIGN §5.1). */
export const BODY_LIMIT_BYTES = 100 * 1024;

/** Upper bound for receiving a whole request, slow clients included. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface AppDependencies {
  readonly logger: FastifyBaseLogger;
  readonly database: ReadinessProbe & { readonly db: Db };
  /** Resolves the caller of `/v1` routes (test stub until Phase 2). */
  readonly authenticate: Authenticator;
}

/**
 * Creates the Fastify instance with all plugins and routes, without listening.
 * Tests use it with `app.inject()`; `main.ts` adds the process lifecycle.
 */
export async function buildApp({ logger, database, authenticate }: AppDependencies) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: generateRequestId,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: frameworkErrorHandler,
  }).withTypeProvider<ZodTypeProvider>();

  // JSON only (DESIGN §3): other media types get a 415 problem.
  app.removeContentTypeParser('text/plain');

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerRequestIdHeader(app);
  registerErrorHandler(app);

  await app.register(healthRoutes, { database });

  await app.register(
    async (v1) => {
      registerAuthentication(v1, authenticate);
      await v1.register(workspaceRoutes, { service: createWorkspacesService(database.db) });
      await v1.register(memberRoutes, { service: createMembersService(database.db) });
    },
    { prefix: '/v1' },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
