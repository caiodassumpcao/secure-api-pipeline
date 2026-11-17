import type { FastifyRequest } from 'fastify';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';

/**
 * Refuses cross-site requests to the routes that act on the refresh cookie
 * (DESIGN §5.1), on top of SameSite=Strict. Browsers announce a cross-site
 * request with `Sec-Fetch-Site` and say where it comes from in `Origin`; a
 * request with neither (curl, a mobile app) cannot be a forged browser request.
 * Allowed origins: the API's own and those listed in CORS_ORIGINS.
 */
export function assertNotCrossSite(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): void {
  const crossSite = request.headers['sec-fetch-site'] === 'cross-site';
  const origin = request.headers.origin;
  const foreignOrigin =
    origin !== undefined &&
    origin !== `${request.protocol}://${request.host}` &&
    !allowedOrigins.includes(origin);
  if (crossSite || foreignOrigin) {
    throw new HttpProblem(ProblemTypes.forbidden, 'Cross-site requests are not accepted here.');
  }
}
