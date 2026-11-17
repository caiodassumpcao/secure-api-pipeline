import type { Db } from '../../db/database.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { toPage, type Page, type PageRequest } from '../../lib/pagination.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { authorize, WORKSPACE_NOT_FOUND } from '../auth/access.ts';
import { createMembersRepository } from '../members/members.repository.ts';
import {
  createWorkspacesRepository,
  type WorkspaceRow,
  type WorkspaceWithRole,
} from './workspaces.repository.ts';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceWithRole['role'];
  createdAt: string;
}

const SLUG_TAKEN = 'This slug is already in use.';

function toWorkspace(row: WorkspaceRow, role: WorkspaceWithRole['role']): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createWorkspacesService(db: Db) {
  const repository = createWorkspacesRepository(db);

  return {
    async list(userId: string, page: PageRequest): Promise<Page<Workspace>> {
      const rows = await repository.listForUser(userId, page);
      return toPage(
        rows.map((row) => toWorkspace(row, row.role)),
        page.limit,
        (workspace) => workspace.id,
      );
    },

    async get(userId: string, workspaceId: string): Promise<Workspace> {
      const row = await repository.findForUser(workspaceId, userId);
      if (row === undefined) throw new HttpProblem(ProblemTypes.notFound, WORKSPACE_NOT_FOUND);
      return toWorkspace(row, row.role);
    },

    /** The creator becomes the workspace's first owner, in the same transaction. */
    async create(userId: string, input: { name: string; slug: string }): Promise<Workspace> {
      try {
        return await db.transaction(async (tx) => {
          const row = await createWorkspacesRepository(tx).insert({ id: uuidv7(), ...input });
          await createMembersRepository(tx).insert(row.id, userId, 'owner');
          return toWorkspace(row, 'owner');
        });
      } catch (error) {
        if (isUniqueViolation(error, 'workspaces_slug_unique')) {
          throw new HttpProblem(ProblemTypes.conflict, SLUG_TAKEN);
        }
        throw error;
      }
    },

    async update(
      userId: string,
      workspaceId: string,
      patch: { name?: string | undefined; slug?: string | undefined },
    ): Promise<Workspace> {
      const role = await authorize(db, workspaceId, userId, 'workspace:update');
      try {
        const row = await repository.update(workspaceId, patch);
        if (row === undefined) throw new HttpProblem(ProblemTypes.notFound, WORKSPACE_NOT_FOUND);
        return toWorkspace(row, role);
      } catch (error) {
        if (isUniqueViolation(error, 'workspaces_slug_unique')) {
          throw new HttpProblem(ProblemTypes.conflict, SLUG_TAKEN);
        }
        throw error;
      }
    },

    /** Deletes the workspace with its memberships, projects and tasks (cascade). */
    async delete(userId: string, workspaceId: string): Promise<void> {
      await authorize(db, workspaceId, userId, 'workspace:delete');
      if (!(await repository.delete(workspaceId))) {
        throw new HttpProblem(ProblemTypes.notFound, WORKSPACE_NOT_FOUND);
      }
    },
  };
}

export type WorkspacesService = ReturnType<typeof createWorkspacesService>;
