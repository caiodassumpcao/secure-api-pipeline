import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { TrustProxy } from '../config/config.ts';

export interface SecurityOptions {
  /** Browser origins allowed to call the API; none by default. */
  readonly corsOrigins: readonly string[];
}

/**
 * Response headers for a JSON API (DESIGN §5.1): a CSP that allows nothing,
 * no framing, no MIME sniffing, HSTS, and `Cache-Control: no-store` unless a
 * route chose otherwise, since responses carry account and workspace data.
 * Swagger UI replaces the CSP on its own routes with one that allows its assets.
 *
 * CORS is off unless origins are listed. Credentials are allowed for the
 * listed origins only, for the refresh-token cookie.
 */
export async function registerSecurity(app: FastifyInstance, options: SecurityOptions) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(cors, {
    origin: options.corsOrigins.length === 0 ? false : [...options.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['location', 'retry-after', 'x-request-id'],
    maxAge: 600,
  });

  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
}

/**
 * Fastify `trustProxy` from the configuration. Never `true`: with it, any
 * client could set `X-Forwarded-For` and choose the IP that rate limits and the
 * audit log see. A hop count trusts that many proxies in front of the API
 * (Fastify's own semantics, written as a function because its types omit it).
 */
export function trustProxyOption(
  trustProxy: TrustProxy,
): false | string[] | ((address: string, hop: number) => boolean) {
  if (trustProxy === false) return false;
  if (typeof trustProxy === 'number') return (_address, hop) => hop < trustProxy;
  return [...trustProxy];
}
