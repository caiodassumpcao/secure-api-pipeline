import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { NodeEnv } from '../config/config.ts';
import { HttpProblem, ProblemTypes } from '../lib/problem.ts';

export interface AuthenticatedUser {
  readonly id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

/** Resolves the caller of a request, or `null` when it is not authenticated. */
export type Authenticator = (request: FastifyRequest) => AuthenticatedUser | null;

export const TEST_USER_HEADER = 'x-test-user-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Temporary identity stub until real authentication lands (DESIGN §13, Phase 2):
 * trusts the user id in `x-test-user-id`. It cannot be created outside
 * NODE_ENV=test, so it can never be reachable in development or production.
 */
export function createTestAuthenticator(env: NodeEnv): Authenticator {
  if (env !== 'test') {
    throw new Error('The test authenticator is only available with NODE_ENV=test');
  }
  return (request) => {
    const userId = request.headers['x-test-user-id'];
    return typeof userId === 'string' && UUID.test(userId) ? { id: userId.toLowerCase() } : null;
  };
}

/** Until Phase 2, outside tests nobody is authenticated. */
export const denyAllAuthenticator: Authenticator = () => null;

/** Every route of the calling plugin scope requires an authenticated user. */
export function registerAuthentication(app: FastifyInstance, authenticate: Authenticator): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    const user = authenticate(request);
    if (user === null) {
      reply.header('www-authenticate', 'Bearer realm="secure-api"');
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
