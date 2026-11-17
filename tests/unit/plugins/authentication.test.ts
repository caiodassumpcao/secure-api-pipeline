import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createTestAuthenticator,
  currentUser,
  denyAllAuthenticator,
  TEST_USER_HEADER,
} from '../../../src/plugins/authentication.ts';

const USER_ID = '0190F3B2-7C1E-7D2A-9F00-1234567890AB';
const requestWith = (headers: FastifyRequest['headers']) => ({ headers }) as FastifyRequest;

describe('createTestAuthenticator', () => {
  it.each(['development', 'production'] as const)('refuses to exist with NODE_ENV=%s', (env) => {
    expect(() => createTestAuthenticator(env)).toThrow('only available with NODE_ENV=test');
  });

  it('identifies the caller from the test header, normalized', () => {
    const authenticate = createTestAuthenticator('test');

    expect(authenticate(requestWith({ [TEST_USER_HEADER]: USER_ID }))).toEqual({
      id: USER_ID.toLowerCase(),
    });
  });

  it.each([
    ['missing', undefined],
    ['not a UUID', 'admin'],
    ['repeated', [USER_ID, USER_ID]],
  ])('treats a %s header as unauthenticated', (_case, value) => {
    const authenticate = createTestAuthenticator('test');

    expect(authenticate(requestWith({ [TEST_USER_HEADER]: value }))).toBeNull();
  });
});

describe('denyAllAuthenticator', () => {
  it('authenticates nobody, whatever the headers', () => {
    expect(denyAllAuthenticator(requestWith({ [TEST_USER_HEADER]: USER_ID }))).toBeNull();
  });
});

describe('currentUser', () => {
  it('throws 401 when the request is not authenticated', () => {
    expect(() => currentUser({ user: null } as FastifyRequest)).toThrow(
      'Authentication is required.',
    );
  });
});
