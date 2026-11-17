import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { users } from '../../db/schema.ts';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  createdAt: users.createdAt,
};

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
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
