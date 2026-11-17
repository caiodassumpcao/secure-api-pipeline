import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { projects } from '../../db/schema.ts';
import type { PageRequest } from '../../lib/pagination.ts';

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

const columns = {
  id: projects.id,
  name: projects.name,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
};

/** Every query is scoped by `workspaceId` (ADR-0005). */
export function createProjectsRepository(db: Executor) {
  const inWorkspace = (workspaceId: string, projectId: string) =>
    and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId));

  return {
    async list(
      workspaceId: string,
      page: PageRequest,
      options: { includeArchived: boolean },
    ): Promise<ProjectRow[]> {
      return db
        .select(columns)
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            options.includeArchived ? undefined : isNull(projects.archivedAt),
            page.after === undefined ? undefined : gt(projects.id, page.after),
          ),
        )
        .orderBy(asc(projects.id))
        .limit(page.limit + 1);
    },

    async find(workspaceId: string, projectId: string): Promise<ProjectRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(projects)
        .where(inWorkspace(workspaceId, projectId));
      return row;
    },

    async insert(workspaceId: string, values: { id: string; name: string }): Promise<ProjectRow> {
      const [row] = await db
        .insert(projects)
        .values({ ...values, workspaceId })
        .returning(columns);
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return row;
    },

    async rename(
      workspaceId: string,
      projectId: string,
      name: string,
    ): Promise<ProjectRow | undefined> {
      const [row] = await db
        .update(projects)
        .set({ name })
        .where(inWorkspace(workspaceId, projectId))
        .returning(columns);
      return row;
    },

    /**
     * Idempotent: an archived project keeps its original archive time. Returns
     * `undefined` for an unknown project, else whether this call archived it.
     */
    async archive(workspaceId: string, projectId: string): Promise<boolean | undefined> {
      const [row] = await db
        .update(projects)
        .set({ archivedAt: sql`coalesce(${projects.archivedAt}, now())` })
        .where(inWorkspace(workspaceId, projectId))
        // now() is the transaction start: equal only if this statement set it.
        .returning({ archivedNow: sql<boolean>`${projects.archivedAt} = now()` });
      return row?.archivedNow;
    },
  };
}

export type ProjectsRepository = ReturnType<typeof createProjectsRepository>;
