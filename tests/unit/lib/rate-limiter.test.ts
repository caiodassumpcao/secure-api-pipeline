import { describe, expect, it } from 'vitest';
import {
  scaleRateLimits,
  type RateLimiter,
  type RateLimitRule,
} from '../../../src/lib/rate-limiter.ts';

const LOGIN_PER_IP: RateLimitRule = { name: 'login-ip', max: 10, windowMs: 60_000 };

function recording(): RateLimiter & { rules: RateLimitRule[]; subjects: string[] } {
  const rules: RateLimitRule[] = [];
  const subjects: string[] = [];
  return {
    rules,
    subjects,
    hit: (rule, subject) => {
      rules.push(rule);
      subjects.push(subject);
      return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    },
  };
}

describe('scaleRateLimits', () => {
  it('returns the limiter itself when the factor is 1', () => {
    const limiter = recording();

    expect(scaleRateLimits(limiter, 1)).toBe(limiter);
  });

  it('raises the maximum of every rule, keeping its name, window and subject', async () => {
    const limiter = recording();

    await scaleRateLimits(limiter, 100).hit(LOGIN_PER_IP, '203.0.113.7');

    expect(limiter.rules).toEqual([{ name: 'login-ip', max: 1000, windowMs: 60_000 }]);
    expect(limiter.subjects).toEqual(['203.0.113.7']);
    expect(LOGIN_PER_IP.max).toBe(10);
  });
});
