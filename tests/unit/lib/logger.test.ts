import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED, redactUrl } from '../../../src/lib/logger.ts';
import { LogCapture } from '../../helpers/log-capture.ts';

function logOnce(payload: Record<string, unknown>) {
  const logs = new LogCapture();
  createLogger({ level: 'info' }, logs).info(payload, 'event');
  return logs;
}

describe('createLogger', () => {
  it('writes JSON with a level label and an ISO timestamp', () => {
    const [entry] = logOnce({ userId: 'u1' }).entries;

    expect(entry).toMatchObject({ level: 'info', msg: 'event', userId: 'u1' });
    expect(entry?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('respects the configured level', () => {
    const logs = new LogCapture();
    const logger = createLogger({ level: 'warn' }, logs);

    logger.info('hidden');
    logger.warn('shown');

    expect(logs.entries.map((entry) => entry.msg)).toEqual(['shown']);
  });

  it.each([
    ['top level', { password: 'hunter2-top' }, 'hunter2-top'],
    ['one level deep', { body: { password: 'hunter2-one' } }, 'hunter2-one'],
    ['two levels deep', { user: { credentials: { token: 'tok-two' } } }, 'tok-two'],
    ['three levels deep', { err: { config: { headers: { cookie: 'c-three' } } } }, 'c-three'],
    ['access tokens', { session: { accessToken: 'eyJ-access' } }, 'eyJ-access'],
    ['refresh tokens', { session: { refreshToken: 'opaque-refresh' } }, 'opaque-refresh'],
    ['password hashes', { user: { passwordHash: '$argon2id$v=19$hash' } }, '$argon2id$v=19$hash'],
    ['secrets', { config: { secret: 'shh-secret' } }, 'shh-secret'],
  ])('redacts %s', (_case, payload, secret) => {
    const logs = logOnce(payload);

    expect(logs.text).not.toContain(secret);
    expect(logs.text).toContain(REDACTED);
  });

  it('redacts credentials in headers logged by application code', () => {
    const logs = logOnce({
      headers: {
        authorization: 'Bearer eyJ-header',
        cookie: 'refresh_token=opaque-cookie',
        'proxy-authorization': 'Basic cHJveHk=',
        'x-api-key': 'key-123',
        'user-agent': 'vitest-agent',
      },
      upstream: { req: { headers: { authorization: 'Bearer nested-header' } } },
      res: { headers: { 'set-cookie': 'refresh_token=opaque-set-cookie' } },
    });

    for (const secret of [
      'eyJ-header',
      'opaque-cookie',
      'cHJveHk=',
      'key-123',
      'opaque-set-cookie',
      'nested-header',
    ]) {
      expect(logs.text).not.toContain(secret);
    }
    expect(logs.text).toContain('vitest-agent');
  });

  it('serializes requests without headers and with a sanitized URL', () => {
    const [entry] = logOnce({
      req: {
        method: 'GET',
        url: '/v1/tasks?token=abc&status=done',
        host: 'api.local',
        ip: '10.0.0.1',
        socket: { remotePort: 51234 },
        headers: { authorization: 'Bearer eyJ' },
      },
    }).entries;

    expect(entry?.req).toEqual({
      method: 'GET',
      url: `/v1/tasks?token=${REDACTED}&status=done`,
      host: 'api.local',
      remoteAddress: '10.0.0.1',
      remotePort: 51234,
    });
  });
});

describe('redactUrl', () => {
  it.each([
    ['/health/ready', '/health/ready'],
    ['/v1/tasks?status=done&limit=20', '/v1/tasks?status=done&limit=20'],
    ['/cb?token=abc', `/cb?token=${REDACTED}`],
    ['/cb?Access_Token=abc&x=1', `/cb?Access_Token=${REDACTED}&x=1`],
    ['/cb?acc%65ss_token=abc', `/cb?acc%65ss_token=${REDACTED}`],
    ['/cb?password', `/cb?password=${REDACTED}`],
    ['/cb?a=1&&code=xyz', `/cb?a=1&&code=${REDACTED}`],
    ['/cb?%E0%A4%A=1&secret=s', `/cb?%E0%A4%A=1&secret=${REDACTED}`],
    ['/cb?', '/cb?'],
  ])('%s → %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});
