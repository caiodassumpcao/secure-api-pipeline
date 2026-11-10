import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTimeout } from '../../lib/timeout.ts';

export interface ReadinessProbe {
  /** Resolves when the dependency can serve queries; rejects otherwise. */
  ping(): Promise<void>;
}

export interface HealthRoutesOptions {
  readonly database: ReadinessProbe;
  readonly readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

const checkStatus = z.enum(['ok', 'unavailable']);

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});

export const readinessResponseSchema = z.object({
  status: checkStatus,
  checks: z.object({ database: checkStatus }),
});

/**
 * `/health/live`: the process is up and serving HTTP.
 * `/health/ready`: dependencies are reachable; 503 tells load balancers and
 * deploy scripts to hold traffic.
 *
 * Probes run often, so their request logs are only kept at `warn` and above.
 */
export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, options, done) => {
  const { database, readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS } = options;

  app.get(
    '/health/live',
    { logLevel: 'warn', schema: { response: { 200: livenessResponseSchema } } },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      logLevel: 'warn',
      schema: { response: { 200: readinessResponseSchema, 503: readinessResponseSchema } },
    },
    async (request, reply) => {
      try {
        await withTimeout(database.ping(), readinessTimeoutMs);
        return { status: 'ok' as const, checks: { database: 'ok' as const } };
      } catch (err) {
        request.log.warn({ err }, 'readiness check failed: database unavailable');
        return reply.code(503).send({ status: 'unavailable', checks: { database: 'unavailable' } });
      }
    },
  );

  done();
};
