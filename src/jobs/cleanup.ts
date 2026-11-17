import { isNotNull, lte, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/database.ts';
import { rateLimits, refreshTokenFamilies, trustedDevices } from '../db/schema.ts';

/** How often each API instance tries to clean up. */
export const CLEANUP_INTERVAL_MS = 60 * 60_000;

/** Only one instance cleans up at a time; the others skip that round. */
const CLEANUP_LOCK_KEY = 7_394_201_002;

export interface CleanupReport {
  readonly skipped: boolean;
  /** Rows deleted per table. */
  readonly deleted: Readonly<Record<string, number>>;
}

/**
 * Deletes what has expired: rate-limit windows, sessions past their absolute
 * lifetime (revoked ones included) and device cookies that expired or were
 * revoked. Holds a transaction-level advisory lock, so concurrent instances
 * never do the work twice.
 */
export async function runCleanup(db: Db): Promise<CleanupReport> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ acquired: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${CLEANUP_LOCK_KEY}) AS acquired`,
    );
    if (lock.rows[0]?.acquired !== true) return { skipped: true, deleted: {} };

    const count = (result: { rowCount: number | null }) => result.rowCount ?? 0;
    const deleted = {
      rate_limits: count(await tx.delete(rateLimits).where(lte(rateLimits.resetAt, sql`now()`))),
      refresh_token_families: count(
        await tx
          .delete(refreshTokenFamilies)
          .where(lte(refreshTokenFamilies.expiresAt, sql`now()`)),
      ),
      trusted_devices: count(
        await tx
          .delete(trustedDevices)
          .where(
            or(lte(trustedDevices.expiresAt, sql`now()`), isNotNull(trustedDevices.revokedAt)),
          ),
      ),
    };
    return { skipped: false, deleted };
  });
}

/**
 * Runs `cleanup` every `intervalMs` (and soon after startup) until stopped.
 * The timer does not keep the process alive; failures are logged, not thrown.
 */
export function scheduleCleanup(
  cleanup: () => Promise<CleanupReport>,
  logger: Logger,
  intervalMs: number = CLEANUP_INTERVAL_MS,
): { stop(): void } {
  const run = async () => {
    try {
      const report = await cleanup();
      if (!report.skipped) logger.info({ deleted: report.deleted }, 'expired rows cleaned up');
    } catch (err) {
      logger.error({ err }, 'cleanup failed');
    }
  };
  const first = setTimeout(() => void run(), 60_000).unref();
  const timer = setInterval(() => void run(), intervalMs).unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
