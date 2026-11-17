// Type augmentation of request.cookies and reply.setCookie; registered in app.ts.
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { opaqueTokenSchema } from '../../lib/opaque-token.ts';

/**
 * `__Secure-` cookies: browsers only accept them with `Secure`, so they are
 * never sent over plain HTTP (localhost aside). HttpOnly keeps them away from
 * scripts; SameSite=Strict keeps them off cross-site requests.
 */
export const REFRESH_COOKIE = '__Secure-refresh';
export const DEVICE_COOKIE = '__Secure-device';

/** The refresh token only travels to the routes that use it. */
const REFRESH_PATH = '/v1/auth';
/** The device cookie only matters to the login route. */
const DEVICE_PATH = '/v1/auth/login';

const BASE = { httpOnly: true, secure: true, sameSite: 'strict' } as const;

export function setRefreshCookie(reply: FastifyReply, token: string, maxAgeMs: number): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    ...BASE,
    path: REFRESH_PATH,
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { ...BASE, path: REFRESH_PATH });
}

export function setDeviceCookie(reply: FastifyReply, token: string, maxAgeMs: number): void {
  reply.setCookie(DEVICE_COOKIE, token, {
    ...BASE,
    path: DEVICE_PATH,
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearDeviceCookie(reply: FastifyReply): void {
  reply.clearCookie(DEVICE_COOKIE, { ...BASE, path: DEVICE_PATH });
}

/** An opaque token from a cookie, or `undefined` when absent or malformed. */
export function readTokenCookie(request: FastifyRequest, name: string): string | undefined {
  // `name` is one of the cookie-name constants above, not user input.
  // eslint-disable-next-line security/detect-object-injection
  const parsed = opaqueTokenSchema.safeParse(request.cookies[name]);
  return parsed.success ? parsed.data : undefined;
}
