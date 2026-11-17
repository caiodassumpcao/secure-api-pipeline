import { and, asc, eq, gt } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { memberships, workspaces, type Role } from '../../db/schema.ts';
import type { PageRequest } from '../../lib/pagination.ts';

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
}

export interface WorkspaceWithRole extends WorkspaceRow {
  readonly role: Role;
}

const columns = {
  id: workspaces.id,
  name: workspaces.name,
  slug: workspaces.slug,
  createdAt: workspaces.createdAt,
};

/**
 * Workspaces are the tenant boundary: they are only ever read through the
 * caller's membership, and written after `authorize()` checked it.
 */
export function createWorkspacesRepository(db: Executor) {
  return {
    async listForUser(userId: string, page: PageRequest): Promise<WorkspaceWithRole[]> {
      return db
        .select({ ...columns, role: memberships.role })
        .from(workspaces)
        .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
        .where(
          and(
            eq(memberships.userId, userId),
            page.after === undefined ? undefined : gt(workspaces.id, page.after),
          ),
        )
        .orderBy(asc(workspaces.id))
        .limit(page.limit + 1);
    },

    async findForUser(workspaceId: string, userId: string): Promise<WorkspaceWithRole | undefined> {
      const [row] = await db
        .select({ ...columns, role: memberships.role })
        .from(workspaces)
        .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
        .where(and(eq(workspaces.id, workspaceId), eq(memberships.userId, userId)));
      return row;
    },

    async insert(values: { id: string; name: string; slug: string }): Promise<WorkspaceRow> {
      const [row] = await db.insert(workspaces).values(values).returning(columns);
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return row;
    },

    async update(
      workspaceId: string,
      patch: { name?: string | undefined; slug?: string | undefined },
    ): Promise<WorkspaceRow | undefined> {
      const [row] = await db
        .update(workspaces)
        .set(patch)
        .where(eq(workspaces.id, workspaceId))
        .returning(columns);
      return row;
    },

    async delete(workspaceId: string): Promise<{ name: string; slug: string } | undefined> {
      const [deleted] = await db
        .delete(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .returning({ name: workspaces.name, slug: workspaces.slug });
      return deleted;
    },

    /**
     * Row lock that serializes membership changes of one workspace, so two
     * concurrent requests cannot both remove "the other" owner.
     */
    async lock(workspaceId: string): Promise<void> {
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('update');
    },
  };
}

export type WorkspacesRepository = ReturnType<typeof createWorkspacesRepository>;
