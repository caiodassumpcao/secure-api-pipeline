import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { refreshTokenFamilies, refreshTokens, trustedDevices, users } from '../../db/schema.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { generateOpaqueToken, hashOpaqueToken } from '../../lib/opaque-token.ts';
import { DEVICE_FAILURE_LIMIT, LOCKOUT_DURATION_MS, LOCKOUT_THRESHOLD } from './policy.ts';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Credentials {
  readonly id: string;
  readonly passwordHash: string;
  /** Locked against clients without a device cookie, per the database clock. */
  readonly locked: boolean;
}

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  createdAt: users.createdAt,
};

/** `now() + ms`, on the database clock shared by every API instance. */
export const nowPlus = (ms: number) => sql<Date>`now() + ${ms}::bigint * interval '1 millisecond'`;

/**
 * Accounts, sessions and devices. Not workspace-scoped: they belong to a user,
 * whatever their workspaces (ADR-0005 exception).
 */
export function createAuthRepository(db: Executor) {
  return {
    async insertUser(values: {
      id: string;
      email: string;
      name: string;
      passwordHash: string;
    }): Promise<UserRow> {
      const [row] = await db.insert(users).values(values).returning(userColumns);
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return row;
    },

    async findUser(userId: string): Promise<UserRow | undefined> {
      const [row] = await db.select(userColumns).from(users).where(eq(users.id, userId));
      return row;
    },

    async findCredentials(email: string): Promise<Credentials | undefined> {
      const [row] = await db
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          locked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)`,
        })
        .from(users)
        .where(eq(users.email, email));
      return row;
    },

    /**
     * Counts a failure from a client without a device cookie and locks the
     * account at the threshold, in one statement so concurrent attempts are
     * all counted. Attempts while locked neither count nor extend the lock.
     * Returns whether this attempt locked the account.
     */
    async recordFailure(userId: string): Promise<{ locked: boolean }> {
      const reachesThreshold = sql`${users.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD}`;
      const [row] = await db
        .update(users)
        .set({
          failedLoginAttempts: sql`CASE WHEN ${reachesThreshold} THEN 0 ELSE ${users.failedLoginAttempts} + 1 END`,
          lockedUntil: sql`CASE WHEN ${reachesThreshold} THEN ${nowPlus(LOCKOUT_DURATION_MS)} ELSE ${users.lockedUntil} END`,
        })
        .where(
          and(
            eq(users.id, userId),
            or(isNull(users.lockedUntil), lte(users.lockedUntil, sql`now()`)),
          ),
        )
        .returning({ locked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)` });
      return { locked: row?.locked ?? false };
    },

    /** A login without a device cookie succeeded: the failure count starts over. */
    async resetFailures(userId: string): Promise<void> {
      await db
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, userId));
    },

    async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
      await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
    },

    /** The trusted device a cookie stands for, if it belongs to this user and is still valid. */
    async findDevice(userId: string, token: string): Promise<{ id: string } | undefined> {
      const [row] = await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(
          and(
            eq(trustedDevices.userId, userId),
            eq(trustedDevices.tokenHash, hashOpaqueToken(token)),
            isNull(trustedDevices.revokedAt),
            gt(trustedDevices.expiresAt, sql`now()`),
          ),
        );
      return row;
    },

    async insertDevice(userId: string, ttlMs: number): Promise<string> {
      const token = generateOpaqueToken();
      await db.insert(trustedDevices).values({
        id: uuidv7(),
        userId,
        tokenHash: hashOpaqueToken(token),
        expiresAt: nowPlus(ttlMs),
      });
      return token;
    },

    async touchDevice(deviceId: string): Promise<void> {
      await db
        .update(trustedDevices)
        .set({ failedAttempts: 0, lastUsedAt: sql`now()` })
        .where(eq(trustedDevices.id, deviceId));
    },

    /** Counts a failure with this device cookie; at the limit the device is no longer trusted. */
    async recordDeviceFailure(deviceId: string): Promise<{ revoked: boolean }> {
      const reachesLimit = sql`${trustedDevices.failedAttempts} + 1 >= ${DEVICE_FAILURE_LIMIT}`;
      const [row] = await db
        .update(trustedDevices)
        .set({
          failedAttempts: sql`${trustedDevices.failedAttempts} + 1`,
          revokedAt: sql`CASE WHEN ${reachesLimit} THEN now() ELSE ${trustedDevices.revokedAt} END`,
        })
        .where(eq(trustedDevices.id, deviceId))
        .returning({ revokedAt: trustedDevices.revokedAt });
      return { revoked: row?.revokedAt !== null && row?.revokedAt !== undefined };
    },

    /** Starts a session: a token family with an absolute lifetime and its first refresh token. */
    async createSession(
      userId: string,
      ttl: { sessionMs: number; tokenMs: number },
    ): Promise<string> {
      const familyId = uuidv7();
      await db.insert(refreshTokenFamilies).values({
        id: familyId,
        userId,
        expiresAt: nowPlus(ttl.sessionMs),
      });
      const token = generateOpaqueToken();
      await db.insert(refreshTokens).values({
        id: uuidv7(),
        familyId,
        tokenHash: hashOpaqueToken(token),
        expiresAt: nowPlus(Math.min(ttl.tokenMs, ttl.sessionMs)),
      });
      return token;
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
