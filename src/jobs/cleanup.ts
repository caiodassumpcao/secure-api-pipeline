import { inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db, Executor } from '../db/database.ts';
import {
  AUDIT_RETENTION_DAYS,
  auditEvents,
  invitations,
  rateLimits,
  refreshTokenFamilies,
  trustedDevices,
} from '../db/schema.ts';

/** How often each API instance tries to clean up. */
export const CLEANUP_INTERVAL_MS = 60 * 60_000;

/** Only one instance cleans up at a time; the others skip that round. */
const CLEANUP_LOCK_KEY = 7_394_201_002;

/** Audit events deleted per statement, to keep each one short. */
const AUDIT_BATCH_SIZE = 5_000;

export interface CleanupReport {
  readonly skipped: boolean;
  /** Rows deleted per table. */
  readonly deleted: Readonly<Record<string, number>>;
}

/**
 * Deletes what has expired: rate-limit windows, sessions past their absolute
 * lifetime (revoked ones included), device cookies that expired or were
 * revoked, invitations past their expiry, and audit events older than the retention period (the only deletes
 * the audit trigger allows). Holds a transaction-level advisory lock, so
 * concurrent instances never do the work twice.
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
      invitations: count(
        await tx.delete(invitations).where(lte(invitations.expiresAt, sql`now()`)),
      ),
      audit_events: await deleteExpiredAuditEvents(tx),
    };
    return { skipped: false, deleted };
  });
}

async function deleteExpiredAuditEvents(tx: Executor): Promise<number> {
  const cutoff = sql`now() - make_interval(days => ${AUDIT_RETENTION_DAYS})`;
  let total = 0;
  for (;;) {
    const batch = tx
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(lt(auditEvents.createdAt, cutoff))
      .limit(AUDIT_BATCH_SIZE);
    const deleted =
      (await tx.delete(auditEvents).where(inArray(auditEvents.id, batch))).rowCount ?? 0;
    total += deleted;
    if (deleted < AUDIT_BATCH_SIZE) return total;
  }
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
