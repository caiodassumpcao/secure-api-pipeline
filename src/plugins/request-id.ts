import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Accept a caller-provided id only if it is short and made of safe characters,
 * so it cannot inject content into logs or response headers.
 */
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Fastify `genReqId`: reuse a valid `x-request-id` header or generate a UUID. */
export function generateRequestId(request: IncomingMessage): string {
  const incoming = request.headers['x-request-id'];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Echoes the request id on every response, including errors and 404s. */
export function registerRequestIdHeader(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
}
