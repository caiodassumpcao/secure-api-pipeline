import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthRoutes, type ReadinessProbe } from './modules/health/health.routes.ts';
import { generateRequestId, registerRequestIdHeader } from './plugins/request-id.ts';

/** Request body cap (DoS control, DESIGN §5.1). */
export const BODY_LIMIT_BYTES = 100 * 1024;

/** Upper bound for receiving a whole request, slow clients included. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface AppDependencies {
  readonly logger: FastifyBaseLogger;
  readonly database: ReadinessProbe;
}

/**
 * Creates the Fastify instance with all plugins and routes, without listening.
 * Tests use it with `app.inject()`; `main.ts` adds the process lifecycle.
 */
export async function buildApp({ logger, database }: AppDependencies) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: generateRequestId,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerRequestIdHeader(app);

  await app.register(healthRoutes, { database });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
