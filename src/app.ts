import cookie from '@fastify/cookie';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { TrustProxy } from './config/config.ts';
import type { RateLimiter } from './lib/rate-limiter.ts';
import type { Db } from './db/database.ts';
import { healthRoutes, type ReadinessProbe } from './modules/health/health.routes.ts';
import { memberRoutes } from './modules/members/members.routes.ts';
import { createMembersService } from './modules/members/members.service.ts';
import { projectRoutes } from './modules/projects/projects.routes.ts';
import { createProjectsService } from './modules/projects/projects.service.ts';
import { taskRoutes } from './modules/tasks/tasks.routes.ts';
import { createTasksService } from './modules/tasks/tasks.service.ts';
import { workspaceRoutes } from './modules/workspaces/workspaces.routes.ts';
import { createWorkspacesService } from './modules/workspaces/workspaces.service.ts';
import { authRoutes, meRoutes } from './modules/auth/auth.routes.ts';
import { createAuthService } from './modules/auth/auth.service.ts';
import type { PasswordHasher } from './modules/auth/password.ts';
import type { TokenService } from './modules/auth/tokens.ts';
import { createBearerAuthenticator, registerAuthentication } from './plugins/authentication.ts';
import { frameworkErrorHandler, registerErrorHandler } from './plugins/error-handler.ts';
import { registerOpenApi } from './plugins/openapi.ts';
import { registerGlobalRateLimit } from './plugins/rate-limit.ts';
import { generateRequestId, registerRequestIdHeader } from './plugins/request-id.ts';
import { registerSecurity, trustProxyOption } from './plugins/security.ts';

/** Request body cap (DoS control, DESIGN §5.1). */
export const BODY_LIMIT_BYTES = 100 * 1024;

/** Upper bound for receiving a whole request, slow clients included. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface AppDependencies {
  readonly logger: FastifyBaseLogger;
  readonly database: ReadinessProbe & { readonly db: Db };
  readonly auth: {
    /** Issues and verifies the access tokens that authenticate `/v1` routes. */
    readonly tokens: TokenService;
    readonly passwords: PasswordHasher;
  };
  /** Serve `/docs` and `/openapi.json` (off in production unless enabled). */
  readonly docs: { readonly enabled: boolean };
  readonly limits: {
    /** Shared counters for the sensitive routes (PostgreSQL in production). */
    readonly limiter: RateLimiter;
    /** Coarse in-memory per-IP limit on every route. */
    readonly global: boolean;
  };
  readonly http: {
    /** Browser origins allowed by CORS. */
    readonly corsOrigins: readonly string[];
    /** Proxies trusted to report the client IP (`X-Forwarded-For`); off by default. */
    readonly trustProxy: TrustProxy;
  };
}

/**
 * Creates the Fastify instance with all plugins and routes, without listening.
 * Tests use it with `app.inject()`; `main.ts` adds the process lifecycle.
 */
export async function buildApp({ logger, database, auth, docs, limits, http }: AppDependencies) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: generateRequestId,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: frameworkErrorHandler,
    trustProxy: trustProxyOption(http.trustProxy),
  }).withTypeProvider<ZodTypeProvider>();

  // JSON only (DESIGN §3): other media types get a 415 problem.
  app.removeContentTypeParser('text/plain');

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerRequestIdHeader(app);
  registerErrorHandler(app);
  await registerSecurity(app, { corsOrigins: http.corsOrigins });
  // Unsigned: cookie values are random tokens checked against their stored hash.
  await app.register(cookie);
  if (limits.global) await registerGlobalRateLimit(app);

  // Before any route, so every route is documented.
  if (docs.enabled) await registerOpenApi(app);

  await app.register(healthRoutes, { database });

  const authService = createAuthService({ db: database.db, ...auth, limiter: limits.limiter });
  await app.register(authRoutes, {
    prefix: '/v1/auth',
    service: authService,
    allowedOrigins: http.corsOrigins,
    limiter: limits.limiter,
  });

  await app.register(
    async (v1) => {
      registerAuthentication(v1, createBearerAuthenticator(auth.tokens));
      await v1.register(meRoutes, { service: authService });
      await v1.register(workspaceRoutes, { service: createWorkspacesService(database.db) });
      await v1.register(memberRoutes, { service: createMembersService(database.db) });
      await v1.register(projectRoutes, { service: createProjectsService(database.db) });
      await v1.register(taskRoutes, { service: createTasksService(database.db) });
    },
    { prefix: '/v1' },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
