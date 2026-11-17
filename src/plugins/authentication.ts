import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem, ProblemTypes } from '../lib/problem.ts';
import type { TokenService } from '../modules/auth/tokens.ts';

export interface AuthenticatedUser {
  readonly id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

/** Resolves the caller of a request, or `null` when it is not authenticated. */
export type Authenticator = (request: FastifyRequest) => Promise<AuthenticatedUser | null>;

/** RFC 6750 bearer credentials; the scheme name is case-insensitive (RFC 9110). */
const BEARER = /^bearer +([\w.-]+)$/i;

/** Identifies the caller from an access token in `Authorization: Bearer`. */
export function createBearerAuthenticator(tokens: TokenService): Authenticator {
  return async (request) => {
    const credentials = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (credentials === undefined) return null;
    const userId = await tokens.verifyAccessToken(credentials);
    return userId === null ? null : { id: userId };
  };
}

const REALM = 'Bearer realm="secure-api"';

/**
 * Every route of the calling plugin scope requires an authenticated user. A
 * rejected token gets `error="invalid_token"` in the challenge (RFC 6750 §3.1),
 * so clients know to refresh it.
 */
export function registerAuthentication(app: FastifyInstance, authenticate: Authenticator): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    const user = await authenticate(request);
    if (user === null) {
      const presented = request.headers.authorization !== undefined;
      reply.header('www-authenticate', presented ? `${REALM}, error="invalid_token"` : REALM);
      throw new HttpProblem(ProblemTypes.unauthorized, 'Authentication is required.');
    }
    request.user = user;
  });
}

/** The caller of a route protected by {@link registerAuthentication}. */
export function currentUser(request: FastifyRequest): AuthenticatedUser {
  if (request.user === null) {
    throw new HttpProblem(ProblemTypes.unauthorized, 'Authentication is required.');
  }
  return request.user;
}
