import { describe, expect, it } from 'vitest';
import { countStatuses, summary } from '../../../scripts/api-status.ts';

const line = (entry: object) => JSON.stringify(entry);

describe('countStatuses', () => {
  it('counts the completed requests of a JSON request log by status', () => {
    const log = [
      'Starting secure-api…',
      line({ level: 'info', msg: 'incoming request', req: { method: 'GET' } }),
      line({ level: 'info', msg: 'request completed', res: { statusCode: 200 } }),
      line({ level: 'info', msg: 'request completed', res: { statusCode: 500 } }),
      line({ level: 'error', msg: 'request failed', res: { statusCode: 500 } }),
      line({ level: 'info', msg: 'request completed', res: { statusCode: 200 } }),
      '{"partial',
      '',
    ].join('\n');

    expect(countStatuses(log)).toEqual({ '200': 2, '500': 1 });
  });

  it('counts a completed request without a numeric status as none', () => {
    expect(countStatuses(line({ msg: 'request completed', res: {} }))).toEqual({ none: 1 });
  });

  it('returns no counts for a log without requests', () => {
    expect(countStatuses('not json\n')).toEqual({});
  });
});

describe('summary', () => {
  it('lists the counts for the job summary', () => {
    expect(summary({ '200': 2, '500': 1 })).toBe(
      'API responses by status (whole job): 200: 2, 500: 1.',
    );
    expect(summary({})).toBe('API responses by status (whole job): none.');
  });
});
