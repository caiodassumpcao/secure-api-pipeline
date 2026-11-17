import { and, asc, count, eq, gt } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { memberships, users, type Role } from '../../db/schema.ts';
import type { PageRequest } from '../../lib/pagination.ts';

export interface MemberRow {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly joinedAt: Date;
}

const columns = {
  userId: memberships.userId,
  email: users.email,
  name: users.name,
  role: memberships.role,
  joinedAt: memberships.createdAt,
};

/** Every query is scoped by `workspaceId` (ADR-0005). */
export function createMembersRepository(db: Executor) {
  return {
    async list(workspaceId: string, page: PageRequest): Promise<MemberRow[]> {
      return db
        .select(columns)
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            page.after === undefined ? undefined : gt(memberships.userId, page.after),
          ),
        )
        .orderBy(asc(memberships.userId))
        .limit(page.limit + 1);
    },

    async find(workspaceId: string, userId: string): Promise<MemberRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
      return row;
    },

    /** Returns false when the user is already a member. */
    async insert(workspaceId: string, userId: string, role: Role): Promise<boolean> {
      const inserted = await db
        .insert(memberships)
        .values({ workspaceId, userId, role })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      return inserted.length > 0;
    },

    async updateRole(workspaceId: string, userId: string, role: Role): Promise<void> {
      await db
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    },

    /**
     * Locks the membership row until the transaction ends. A concurrent task
     * assignment to this member holds a key-share lock on it through the
     * assignee foreign key: the removal waits for it to commit, then sees and
     * unassigns that task, and later assignments fail the foreign key check.
     */
    async lock(workspaceId: string, userId: string): Promise<void> {
      await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
        .for('update');
    },

    async delete(workspaceId: string, userId: string): Promise<void> {
      await db
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    },

    async countOwners(workspaceId: string): Promise<number> {
      const [row] = await db
        .select({ owners: count() })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')));
      return row?.owners ?? 0;
    },
  };
}

export type MembersRepository = ReturnType<typeof createMembersRepository>;
