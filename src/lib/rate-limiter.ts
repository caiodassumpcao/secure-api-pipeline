import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Executor } from '../db/database.ts';
import { rateLimits } from '../db/schema.ts';
import { HttpProblem, ProblemTypes } from './problem.ts';

export interface RateLimitRule {
  /** Namespace of the counters, e.g. `login-ip`. */
  readonly name: string;
  readonly max: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the window resets. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one request of `subject` (an IP address, a user id, an email) against `rule`. */
  hit(rule: RateLimitRule, subject: string): Promise<RateLimitResult>;
}

/** Counters are keyed by a hash: the table never holds addresses or emails. */
function keyOf(rule: RateLimitRule, subject: string): string {
  return `${rule.name}:${createHash('sha256').update(subject).digest('hex')}`;
}

/**
 * Fixed-window counters in PostgreSQL (ADR-0009), shared by every API
 * instance: one upsert per request, atomic under concurrency. Only the routes
 * worth protecting use it; the global per-IP limit stays in memory.
 */
export function createRateLimiter(db: Executor): RateLimiter {
  return {
    async hit(rule, subject) {
      const windowEnd = sql`now() + ${rule.windowMs}::bigint * interval '1 millisecond'`;
      const expired = sql`${rateLimits.resetAt} <= now()`;
      const [row] = await db
        .insert(rateLimits)
        .values({ key: keyOf(rule, subject), hits: 1, resetAt: windowEnd })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            hits: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimits.hits} + 1 END`,
            resetAt: sql`CASE WHEN ${expired} THEN ${windowEnd} ELSE ${rateLimits.resetAt} END`,
          },
        })
        .returning({
          hits: rateLimits.hits,
          retryAfterSeconds: sql<number>`greatest(ceil(extract(epoch FROM ${rateLimits.resetAt} - now())), 1)::int`,
        });
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return { allowed: row.hits <= rule.max, retryAfterSeconds: row.retryAfterSeconds };
    },
  };
}

/** Lets every request through: for tests that are not about rate limits. */
export const unlimited: RateLimiter = {
  hit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
};

export function tooManyRequests(retryAfterSeconds: number): HttpProblem {
  return new HttpProblem(
    ProblemTypes.tooManyRequests,
    `Too many requests; retry in ${retryAfterSeconds} seconds.`,
  );
}

/** Route hook that answers 429 (with `Retry-After`) once the subject exceeds the rule. */
export function rateLimitBy(
  limiter: RateLimiter,
  rule: RateLimitRule,
  subjectOf: (request: FastifyRequest) => string,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const result = await limiter.hit(rule, subjectOf(request));
    if (!result.allowed) {
      reply.header('retry-after', String(result.retryAfterSeconds));
      throw tooManyRequests(result.retryAfterSeconds);
    }
  };
}
