import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { tasks, type TaskPriority, type TaskStatus } from '../../db/schema.ts';
import type { PageRequest } from '../../lib/pagination.ts';

export interface TaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TaskFilters {
  readonly status?: TaskStatus | undefined;
  readonly priority?: TaskPriority | undefined;
  readonly assigneeId?: string | undefined;
}

export interface TaskFields {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  assigneeId?: string | null | undefined;
  dueDate?: string | null | undefined;
}

const columns = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  assigneeId: tasks.assigneeId,
  dueDate: tasks.dueDate,
  createdBy: tasks.createdBy,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

/** Every query is scoped by `workspaceId` (ADR-0005). */
export function createTasksRepository(db: Executor) {
  const inWorkspace = (workspaceId: string, taskId: string) =>
    and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId));

  return {
    async list(
      workspaceId: string,
      projectId: string,
      filters: TaskFilters,
      page: PageRequest,
    ): Promise<TaskRow[]> {
      return db
        .select(columns)
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.projectId, projectId),
            filters.status === undefined ? undefined : eq(tasks.status, filters.status),
            filters.priority === undefined ? undefined : eq(tasks.priority, filters.priority),
            filters.assigneeId === undefined ? undefined : eq(tasks.assigneeId, filters.assigneeId),
            page.after === undefined ? undefined : gt(tasks.id, page.after),
          ),
        )
        .orderBy(asc(tasks.id))
        .limit(page.limit + 1);
    },

    async find(workspaceId: string, taskId: string): Promise<TaskRow | undefined> {
      const [row] = await db.select(columns).from(tasks).where(inWorkspace(workspaceId, taskId));
      return row;
    },

    async insert(
      workspaceId: string,
      values: TaskFields & { id: string; projectId: string; title: string; createdBy: string },
    ): Promise<TaskRow> {
      const [row] = await db
        .insert(tasks)
        .values({ ...values, workspaceId })
        .returning(columns);
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return row;
    },

    async update(
      workspaceId: string,
      taskId: string,
      patch: TaskFields,
    ): Promise<TaskRow | undefined> {
      const [row] = await db
        .update(tasks)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(inWorkspace(workspaceId, taskId))
        .returning(columns);
      return row;
    },

    async delete(workspaceId: string, taskId: string): Promise<boolean> {
      const deleted = await db
        .delete(tasks)
        .where(inWorkspace(workspaceId, taskId))
        .returning({ id: tasks.id });
      return deleted.length > 0;
    },

    async unassignMember(workspaceId: string, userId: string): Promise<void> {
      await db
        .update(tasks)
        .set({ assigneeId: null, updatedAt: sql`now()` })
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.assigneeId, userId)));
    },
  };
}

export type TasksRepository = ReturnType<typeof createTasksRepository>;
