import type { Db } from '../../db/database.ts';
import { isForeignKeyViolation } from '../../db/errors.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { toPage, type Page, type PageRequest } from '../../lib/pagination.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { authorize, roleOf } from '../auth/access.ts';
import { can } from '../auth/permissions.ts';
import { createProjectsRepository } from '../projects/projects.repository.ts';
import { PROJECT_NOT_FOUND } from '../projects/projects.service.ts';
import {
  createTasksRepository,
  type TaskFields,
  type TaskFilters,
  type TaskRow,
} from './tasks.repository.ts';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskRow['status'];
  priority: TaskRow['priority'];
  assigneeId: string | null;
  dueDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TASK_NOT_FOUND = 'The task does not exist.';

function toTask(row: TaskRow): Task {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invalidAssignee(): HttpProblem {
  return new HttpProblem(
    ProblemTypes.validation,
    'The assignee must be a member of the workspace.',
    [{ path: 'body.assigneeId', message: 'Must be a member of the workspace' }],
  );
}

export function createTasksService(db: Db) {
  const repository = createTasksRepository(db);
  const projects = createProjectsRepository(db);

  async function projectOrThrow(workspaceId: string, projectId: string) {
    const project = await projects.find(workspaceId, projectId);
    if (project === undefined) throw new HttpProblem(ProblemTypes.notFound, PROJECT_NOT_FOUND);
    return project;
  }

  async function writableProject(workspaceId: string, projectId: string) {
    const project = await projectOrThrow(workspaceId, projectId);
    if (project.archivedAt !== null) {
      throw new HttpProblem(
        ProblemTypes.conflict,
        'The project is archived; its tasks are read-only.',
      );
    }
  }

  async function assertAssignable(workspaceId: string, assigneeId: string | null | undefined) {
    if (assigneeId !== undefined && assigneeId !== null) {
      if ((await roleOf(db, workspaceId, assigneeId)) === undefined) throw invalidAssignee();
    }
  }

  /** The membership check above runs first; the composite foreign key closes the race. */
  async function mapAssigneeRace<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (isForeignKeyViolation(error, 'tasks_assignee_membership_fk')) throw invalidAssignee();
      throw error;
    }
  }

  return {
    async list(
      userId: string,
      workspaceId: string,
      projectId: string,
      filters: TaskFilters,
      page: PageRequest,
    ): Promise<Page<Task>> {
      await authorize(db, workspaceId, userId, 'task:read');
      await projectOrThrow(workspaceId, projectId);
      const rows = await repository.list(workspaceId, projectId, filters, page);
      return toPage(rows.map(toTask), page.limit, (task) => task.id);
    },

    async get(userId: string, workspaceId: string, taskId: string): Promise<Task> {
      await authorize(db, workspaceId, userId, 'task:read');
      const row = await repository.find(workspaceId, taskId);
      if (row === undefined) throw new HttpProblem(ProblemTypes.notFound, TASK_NOT_FOUND);
      return toTask(row);
    },

    async create(
      userId: string,
      workspaceId: string,
      projectId: string,
      input: TaskFields & { title: string },
    ): Promise<Task> {
      await authorize(db, workspaceId, userId, 'task:write');
      await writableProject(workspaceId, projectId);
      await assertAssignable(workspaceId, input.assigneeId);
      const row = await mapAssigneeRace(
        repository.insert(workspaceId, { ...input, id: uuidv7(), projectId, createdBy: userId }),
      );
      return toTask(row);
    },

    async update(
      userId: string,
      workspaceId: string,
      taskId: string,
      patch: TaskFields,
    ): Promise<Task> {
      await authorize(db, workspaceId, userId, 'task:write');
      const task = await repository.find(workspaceId, taskId);
      if (task === undefined) throw new HttpProblem(ProblemTypes.notFound, TASK_NOT_FOUND);
      await writableProject(workspaceId, task.projectId);
      await assertAssignable(workspaceId, patch.assigneeId);
      const row = await mapAssigneeRace(repository.update(workspaceId, taskId, patch));
      if (row === undefined) throw new HttpProblem(ProblemTypes.notFound, TASK_NOT_FOUND);
      return toTask(row);
    },

    /**
     * Owners and admins delete any task; members only the tasks they created.
     * Tasks of an archived project are frozen, deletion included.
     */
    async delete(userId: string, workspaceId: string, taskId: string): Promise<void> {
      const role = await authorize(db, workspaceId, userId, 'task:delete-own');
      const task = await repository.find(workspaceId, taskId);
      if (task === undefined) throw new HttpProblem(ProblemTypes.notFound, TASK_NOT_FOUND);
      if (!can(role, 'task:delete-any') && task.createdBy !== userId) {
        throw new HttpProblem(
          ProblemTypes.forbidden,
          'Members can only delete tasks they created.',
        );
      }
      await writableProject(workspaceId, task.projectId);
      await repository.delete(workspaceId, taskId);
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;
