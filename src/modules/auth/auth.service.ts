import type { Db } from '../../db/database.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { createMembersRepository } from '../members/members.repository.ts';
import { createWorkspacesRepository } from '../workspaces/workspaces.repository.ts';
import { createAuthRepository, type UserRow } from './auth.repository.ts';
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

export function createAuthService({ db, passwords }: AuthServiceDependencies) {
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
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
