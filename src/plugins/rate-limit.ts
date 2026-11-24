import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { tooManyRequests } from '../lib/rate-limiter.ts';

/** Requests per minute and client IP across the whole API (in memory, per instance). */
export const GLOBAL_RATE_LIMIT = { max: 600, timeWindow: 60_000 } as const;

/**
 * Coarse per-IP limit on every request but the health probes, as defence in
 * depth behind the proxy's own limit (Phase 5). It is a root `onRequest` hook,
 * so it runs before authentication and also covers unknown routes: route-level
 * limits would only run after a 401 or 404 was already decided. Behind a
 * proxy, TRUST_PROXY must be set, or every client would share the proxy's
 * address. Sensitive routes add stricter limits shared by all instances
 * (src/lib/rate-limiter.ts). RATE_LIMIT_MULTIPLIER raises this limit with the
 * others in test environments.
 */
export async function registerGlobalRateLimit(
  app: FastifyInstance,
  { multiplier = 1 }: { multiplier?: number } = {},
): Promise<void> {
  await app.register(rateLimit, { global: false });
  app.addHook(
    'onRequest',
    app.rateLimit({
      ...GLOBAL_RATE_LIMIT,
      max: GLOBAL_RATE_LIMIT.max * multiplier,
      allowList: (request) => request.url.startsWith('/health/'),
      errorResponseBuilder: (_request, context) => tooManyRequests(Math.ceil(context.ttl / 1000)),
    }),
  );
}
