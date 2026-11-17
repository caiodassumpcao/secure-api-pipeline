import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTimeout } from '../../lib/timeout.ts';

export interface ReadinessProbe {
  /** Resolves when the database can serve queries; rejects otherwise. */
  ping(): Promise<void>;
  /** Whether the schema this build expects has been migrated. */
  migrationsApplied(): Promise<boolean>;
}

export interface HealthRoutesOptions {
  readonly database: ReadinessProbe;
  readonly readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});

export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: z.enum(['ok', 'unavailable']),
    migrations: z.enum(['ok', 'pending', 'unknown']),
  }),
});

type Readiness = z.infer<typeof readinessResponseSchema>;

const health = { tags: ['health'], security: [] };

/**
 * `/health/live`: the process is up and serving HTTP.
 * `/health/ready`: the database is reachable and migrated; 503 tells load
 * balancers and deploy scripts to hold traffic. Reasons are logged, not returned.
 *
 * Probes run often, so their request logs are only kept at `warn` and above.
 */
export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, options, done) => {
  const { database, readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS } = options;

  app.get(
    '/health/live',
    {
      logLevel: 'warn',
      schema: { ...health, summary: 'Liveness probe', response: { 200: livenessResponseSchema } },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      logLevel: 'warn',
      schema: {
        ...health,
        summary: 'Readiness probe',
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
    },
    async (request, reply) => {
      const unavailable = (checks: Readiness['checks']) =>
        reply.code(503).send({ status: 'unavailable', checks });

      try {
        await withTimeout(database.ping(), readinessTimeoutMs);
      } catch (err) {
        request.log.warn({ err }, 'readiness check failed: database unavailable');
        return unavailable({ database: 'unavailable', migrations: 'unknown' });
      }

      let migrated: boolean;
      try {
        migrated = await withTimeout(database.migrationsApplied(), readinessTimeoutMs);
      } catch (err) {
        request.log.warn({ err }, 'readiness check failed: migration status unknown');
        return unavailable({ database: 'ok', migrations: 'unknown' });
      }
      if (!migrated) {
        request.log.warn('readiness check failed: database migrations pending');
        return unavailable({ database: 'ok', migrations: 'pending' });
      }

      return {
        status: 'ok' as const,
        checks: { database: 'ok' as const, migrations: 'ok' as const },
      };
    },
  );

  done();
};
