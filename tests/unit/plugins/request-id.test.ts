import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { generateRequestId, REQUEST_ID_HEADER } from '../../../src/plugins/request-id.ts';
import { buildTestApp } from '../../helpers/test-app.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requestWith(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('generateRequestId', () => {
  it.each(['abc-123', '0190f3b2-7c1e-7d2a-9f00-1234567890ab', 'svc.edge:42_a', 'x'.repeat(128)])(
    'reuses a safe incoming id (%s)',
    (id) => {
      expect(generateRequestId(requestWith({ [REQUEST_ID_HEADER]: id }))).toBe(id);
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'x'.repeat(129)],
    ['with spaces', 'abc 123'],
    ['with a newline (log injection)', 'abc\n{"level":"fatal"}'],
    ['with markup', '<script>'],
  ])('generates a UUID when the incoming id is %s', (_case, id) => {
    expect(generateRequestId(requestWith({ [REQUEST_ID_HEADER]: id }))).toMatch(UUID);
  });

  it('generates a UUID when the header is repeated', () => {
    const request = requestWith({ [REQUEST_ID_HEADER]: ['a', 'b'] });
    expect(generateRequestId(request)).toMatch(UUID);
  });
});

describe('request id header', () => {
  it('echoes a valid incoming id and tags every log line of the request', async () => {
    const { app, logs } = await buildTestApp();
    app.get('/hello', (request) => {
      request.log.info('handling');
      return { ok: true };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/hello',
      headers: { [REQUEST_ID_HEADER]: 'trace-me-1' },
    });

    expect(response.headers['x-request-id']).toBe('trace-me-1');
    const requestLogs = logs.entries.filter((entry) => 'request_id' in entry);
    expect(requestLogs.map((entry) => entry.msg)).toEqual([
      'incoming request',
      'handling',
      'request completed',
    ]);
    expect(new Set(requestLogs.map((entry) => entry.request_id))).toEqual(new Set(['trace-me-1']));
  });

  it('replaces an unsafe incoming id with a generated one', async () => {
    const { app } = await buildTestApp();
    app.get('/hello', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/hello',
      headers: { [REQUEST_ID_HEADER]: 'bad id' },
    });

    expect(response.headers['x-request-id']).toMatch(UUID);
  });
});
