import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requestContext } from '../../../../src/modules/audit/audit.ts';

const request = (ip: string, userAgent?: string) =>
  ({ ip, headers: userAgent === undefined ? {} : { 'user-agent': userAgent } }) as FastifyRequest;

describe('requestContext', () => {
  it('keeps the client IP and user agent', () => {
    expect(requestContext(request('203.0.113.7', 'curl/8.5.0'))).toEqual({
      ip: '203.0.113.7',
      userAgent: 'curl/8.5.0',
    });
    expect(requestContext(request('2001:db8::1')).ip).toBe('2001:db8::1');
  });

  it('drops an IP that is not an address and truncates long user agents', () => {
    const context = requestContext(request('unknown', 'x'.repeat(1_000)));

    expect(context).toEqual({ ip: null, userAgent: 'x'.repeat(256) });
  });
});
