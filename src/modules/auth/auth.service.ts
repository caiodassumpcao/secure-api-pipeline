import type { Db } from '../../db/database.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { createMembersRepository } from '../members/members.repository.ts';
import { createWorkspacesRepository } from '../workspaces/workspaces.repository.ts';
import { createAuthRepository, type UserRow } from './auth.repository.ts';
import { DEVICE_TTL_MS, REFRESH_TOKEN_TTL_MS, SESSION_TTL_MS } from './policy.ts';
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
  | {
      readonly status: 'failed';
      /** The device cookie was presented with too many wrong passwords and is revoked. */
      readonly deviceRevoked: boolean;
    };

export function createAuthService({ db, passwords, tokens }: AuthServiceDependencies) {
  const repository = createAuthRepository(db);

  return {
    /**
     * Creates an account and its personal workspace, owned by it, in one
     * transaction. The password is hashed before the email is checked, so a
     * taken address does not answer faster than a new one.
     */
    async register(input: { email: string; password: string; name: string }): Promise<User> {
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
      client: { deviceToken: string | undefined },
    ): Promise<LoginResult> {
      const credentials = await repository.findCredentials(input.email);
      const device =
        credentials !== undefined && client.deviceToken !== undefined
          ? await repository.findDevice(credentials.id, client.deviceToken)
          : undefined;
      const lockedOut = credentials !== undefined && credentials.locked && device === undefined;
      const usable = credentials !== undefined && !lockedOut;

      const verified = await passwords.verify(
        usable ? credentials.passwordHash : null,
        input.password,
      );

      if (!usable || !verified) {
        let deviceRevoked = false;
        if (credentials !== undefined && !lockedOut) {
          if (device === undefined) await repository.recordFailure(credentials.id);
          else deviceRevoked = (await repository.recordDeviceFailure(device.id)).revoked;
        }
        return { status: 'failed', deviceRevoked };
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
        return { refreshToken: session, deviceToken: issued };
      });
      const { accessToken, expiresIn } = await tokens.issueAccessToken(credentials.id);
      return { status: 'succeeded', accessToken, expiresIn, refreshToken, deviceToken };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
