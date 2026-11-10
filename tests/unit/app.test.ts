import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/lib/logger.ts';
import { buildTestApp } from '../helpers/test-app.ts';

describe('buildApp', () => {
  it('never writes credentials from a request to the logs', async () => {
    const { app, logs } = await buildTestApp();
    app.post('/v1/auth/login', (request) => {
      request.log.info({ body: request.body, headers: request.headers }, 'login attempt');
      throw new Error('boom');
    });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/login?token=query-token-secret',
      headers: {
        authorization: 'Bearer header-token-secret',
        cookie: 'refresh_token=cookie-secret',
      },
      payload: { email: 'ana@example.com', password: 'body-password-secret' },
    });

    expect(logs.lines.length).toBeGreaterThan(0);
    for (const secret of [
      'query-token-secret',
      'header-token-secret',
      'cookie-secret',
      'body-password-secret',
    ]) {
      expect(logs.text).not.toContain(secret);
    }
    expect(logs.text).toContain(REDACTED);
  });

  it('closes cleanly', async () => {
    const { app } = await buildTestApp();
    await app.ready();

    await expect(app.close()).resolves.toBeUndefined();
  });
});
