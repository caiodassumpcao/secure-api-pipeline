import type { Db } from '../../db/database.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import type { Role } from '../../db/schema.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import type { RateLimiter } from '../../lib/rate-limiter.ts';
import type { AppMetrics } from '../../telemetry/metrics.ts';
import { recordAuditEvent, type RequestContext } from '../audit/audit.ts';
import { createMembersRepository } from '../members/members.repository.ts';
import { createWorkspacesRepository } from '../workspaces/workspaces.repository.ts';

/** Memberships listed by `/v1/me`; `/v1/workspaces` paginates through all of them. */
export const ME_MEMBERSHIPS_LIMIT = 100;
import { createAuthRepository, type UserRow } from './auth.repository.ts';
import { DEVICE_TTL_MS, LOGIN_PER_EMAIL, REFRESH_TOKEN_TTL_MS, SESSION_TTL_MS } from './policy.ts';
import { passwordPolicyIssues, type PasswordHasher } from './password.ts';
import type { TokenService } from './tokens.ts';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthServiceDependencies {
  readonly db: Db;
  readonly passwords: PasswordHasher;
  readonly tokens: TokenService;
  readonly limiter: RateLimiter;
  readonly metrics: AppMetrics;
}

export interface Me extends User {
  memberships: { workspaceId: string; name: string; slug: string; role: Role }[];
}

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.createdAt.toISOString() };
}

/** Name of the workspace every account starts with. */
const PERSONAL_WORKSPACE_NAME = 'Personal';

/** Same answer for an unknown email, a wrong password and a locked account. */
export const INVALID_CREDENTIALS = 'The email or password is incorrect.';

export interface Session {
  readonly accessToken: string;
  readonly expiresIn: number;
  /** Opaque refresh token, for the refresh cookie. */
  readonly refreshToken: string;
}

export type LoginResult =
  | (Session & {
      readonly status: 'succeeded';
      /** A new device cookie to set, when the client had no valid one. */
      readonly deviceToken: string | undefined;
    })
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | {
      readonly status: 'failed';
      /** The device cookie was presented with too many wrong passwords and is revoked. */
      readonly deviceRevoked: boolean;
    };

export type RefreshResult =
  | (Session & { readonly status: 'rotated'; readonly refreshExpiresAt: Date })
  | {
      readonly status: 'rejected';
      /** False during the rotation grace period: the client already holds the newer token. */
      readonly clearCookie: boolean;
    }
  | { readonly status: 'reuse_detected'; readonly userId: string; readonly familyId: string };

export function createAuthService({
  db,
  passwords,
  tokens,
  limiter,
  metrics,
}: AuthServiceDependencies) {
  const repository = createAuthRepository(db);

  return {
    /**
     * Creates an account and its personal workspace, owned by it, in one
     * transaction. The password is hashed before the email is checked, so a
     * taken address does not answer faster than a new one.
     */
    async register(
      input: { email: string; password: string; name: string },
      context: RequestContext,
    ): Promise<User> {
      const issues = passwordPolicyIssues(input.password, { email: input.email });
      if (issues.length > 0) {
        throw new HttpProblem(
          ProblemTypes.validation,
          'The password does not meet the password policy.',
          issues.map((message) => ({ path: 'body.password', message })),
        );
      }
      const passwordHash = await passwords.hash(input.password);

      try {
        return await db.transaction(async (tx) => {
          const user = await createAuthRepository(tx).insertUser({
            id: uuidv7(),
            email: input.email,
            name: input.name,
            passwordHash,
          });
          const workspaceId = uuidv7();
          await createWorkspacesRepository(tx).insert({
            id: workspaceId,
            name: PERSONAL_WORKSPACE_NAME,
            slug: `personal-${workspaceId.replaceAll('-', '')}`,
          });
          await createMembersRepository(tx).insert(workspaceId, user.id, 'owner');
          await recordAuditEvent(
            tx,
            {
              action: 'auth.registered',
              actorId: user.id,
              target: `user:${user.id}`,
              metadata: { personalWorkspaceId: workspaceId },
            },
            context,
          );
          return toUser(user);
        });
      } catch (error) {
        if (isUniqueViolation(error, 'users_email_unique')) {
          // Discloses that the address has an account (threat model RR-3).
          throw new HttpProblem(
            ProblemTypes.conflict,
            'An account already uses this email address.',
          );
        }
        throw error;
      }
    },

    /**
     * Brute-force protection (ADR-0009): consecutive failures from clients
     * without a device cookie lock the account for them; a client that already
     * logged in (valid device cookie) is not locked out, and only its own
     * cookie is revoked after repeated failures. argon2 runs on every attempt,
     * against a dummy hash for an unknown email or a locked account, so the
     * response time does not reveal which case it is.
     */
    async login(
      input: { email: string; password: string },
      client: { deviceToken: string | undefined } & RequestContext,
    ): Promise<LoginResult> {
      const credentials = await repository.findCredentials(input.email);
      const device =
        credentials !== undefined && client.deviceToken !== undefined
          ? await repository.findDevice(credentials.id, client.deviceToken)
          : undefined;
      if (device === undefined) {
        // Counted whether or not the account exists, so the limit reveals nothing.
        const limit = await limiter.hit(LOGIN_PER_EMAIL, input.email);
        if (!limit.allowed) {
          metrics.loginFailed('rate_limited');
          return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
        }
      }
      const lockedOut = credentials !== undefined && credentials.locked && device === undefined;
      const usable = credentials !== undefined && !lockedOut;

      const verified = await passwords.verify(
        usable ? credentials.passwordHash : null,
        input.password,
      );

      if (!usable || !verified) {
        // The email of an unknown account is not recorded: it may be a typo'd
        // address of someone else, or a password typed in the wrong field.
        const reason =
          credentials === undefined ? 'unknown_account' : lockedOut ? 'locked' : 'wrong_password';
        const failed = await db.transaction(async (tx) => {
          const auth = createAuthRepository(tx);
          let deviceRevoked = false;
          let locked = false;
          if (credentials !== undefined && !lockedOut) {
            if (device === undefined) locked = (await auth.recordFailure(credentials.id)).locked;
            else deviceRevoked = (await auth.recordDeviceFailure(device.id)).revoked;
          }
          const target = credentials === undefined ? null : `user:${credentials.id}`;
          await recordAuditEvent(
            tx,
            {
              action: 'auth.login.failed',
              target,
              metadata: { reason, trustedDevice: device !== undefined, deviceRevoked },
            },
            client,
          );
          if (locked) await recordAuditEvent(tx, { action: 'auth.locked', target }, client);
          return { status: 'failed', deviceRevoked } as const;
        });
        metrics.loginFailed(reason);
        return failed;
      }

      const rehashed = passwords.needsRehash(credentials.passwordHash)
        ? await passwords.hash(input.password)
        : undefined;
      const { refreshToken, deviceToken } = await db.transaction(async (tx) => {
        const auth = createAuthRepository(tx);
        if (rehashed !== undefined) await auth.updatePasswordHash(credentials.id, rehashed);
        let issued: string | undefined;
        if (device === undefined) {
          await auth.resetFailures(credentials.id);
          issued = await auth.insertDevice(credentials.id, DEVICE_TTL_MS);
        } else {
          // A trusted device only clears its own count: the account stays
          // locked for other clients if someone else is guessing.
          await auth.touchDevice(device.id);
        }
        const session = await auth.createSession(credentials.id, {
          sessionMs: SESSION_TTL_MS,
          tokenMs: REFRESH_TOKEN_TTL_MS,
        });
        await recordAuditEvent(
          tx,
          {
            action: 'auth.login.succeeded',
            actorId: credentials.id,
            target: `user:${credentials.id}`,
            metadata: { trustedDevice: device !== undefined },
          },
          client,
        );
        return { refreshToken: session, deviceToken: issued };
      });
      const { accessToken, expiresIn } = await tokens.issueAccessToken(credentials.id);
      return { status: 'succeeded', accessToken, expiresIn, refreshToken, deviceToken };
    },

    /**
     * Rotation with reuse detection (ADR-0004): each refresh token works once.
     * Presenting a token that was already exchanged means two parties hold it,
     * so the whole session is revoked, unless the exchange happened within the
     * last seconds, which is two tabs refreshing at once.
     */
    async refresh(
      refreshToken: string | undefined,
      context: RequestContext,
    ): Promise<RefreshResult> {
      if (refreshToken === undefined) return { status: 'rejected', clearCookie: false };

      const outcome = await db.transaction(async (tx) => {
        const auth = createAuthRepository(tx);
        const stored = await auth.findRefreshTokenForUpdate(refreshToken);
        if (stored === undefined || stored.sessionEnded) {
          return { status: 'rejected', clearCookie: true } as const;
        }
        if (stored.rotated) {
          if (stored.rotatedWithinGrace) return { status: 'rejected', clearCookie: false } as const;
          await auth.revokeFamily(stored.familyId, 'reuse');
          // Whoever presented the token is unknown: it may be the thief or the owner.
          await recordAuditEvent(
            tx,
            {
              action: 'auth.refresh.reuse_detected',
              target: `user:${stored.userId}`,
              metadata: { sessionId: stored.familyId },
            },
            context,
          );
          return {
            status: 'reuse_detected',
            userId: stored.userId,
            familyId: stored.familyId,
          } as const;
        }
        if (stored.expired) return { status: 'rejected', clearCookie: true } as const;
        const next = await auth.rotateRefreshToken(stored, REFRESH_TOKEN_TTL_MS);
        return { status: 'rotated', userId: stored.userId, next } as const;
      });

      if (outcome.status === 'reuse_detected') metrics.refreshTokenReuseDetected();
      if (outcome.status !== 'rotated') return outcome;
      const { accessToken, expiresIn } = await tokens.issueAccessToken(outcome.userId);
      return {
        status: 'rotated',
        accessToken,
        expiresIn,
        refreshToken: outcome.next.token,
        refreshExpiresAt: outcome.next.expiresAt,
      };
    },

    /**
     * Ends the session the refresh cookie belongs to. Idempotent: an unknown,
     * expired or already revoked session is not an error. Access tokens already
     * issued stay valid until they expire (15 minutes, ADR-0004).
     */
    async logout(refreshToken: string | undefined, context: RequestContext): Promise<void> {
      if (refreshToken === undefined) return;
      const session = await repository.findSession(refreshToken);
      if (session === undefined) return;
      await db.transaction(async (tx) => {
        await createAuthRepository(tx).revokeFamily(session.familyId, 'logout');
        await recordAuditEvent(
          tx,
          {
            action: 'auth.logout',
            actorId: session.userId,
            target: `user:${session.userId}`,
            metadata: { sessionId: session.familyId },
          },
          context,
        );
      });
    },

    async me(userId: string): Promise<Me> {
      const user = await repository.findUser(userId);
      if (user === undefined) {
        throw new HttpProblem(ProblemTypes.unauthorized, 'The account no longer exists.');
      }
      const workspaces = await createWorkspacesRepository(db).listForUser(userId, {
        limit: ME_MEMBERSHIPS_LIMIT,
      });
      return {
        ...toUser(user),
        memberships: workspaces.slice(0, ME_MEMBERSHIPS_LIMIT).map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          role: workspace.role,
        })),
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
