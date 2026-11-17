import type { Db } from '../../db/database.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { toPage, type Page, type PageRequest } from '../../lib/pagination.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { recordAuditEvent, type RequestContext } from '../audit/audit.ts';
import { authorize } from '../auth/access.ts';
import { createProjectsRepository, type ProjectRow } from './projects.repository.ts';

export interface Project {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

export const PROJECT_NOT_FOUND = 'The project does not exist.';

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createProjectsService(db: Db) {
  const repository = createProjectsRepository(db);

  return {
    async list(
      userId: string,
      workspaceId: string,
      page: PageRequest,
      options: { includeArchived: boolean },
    ): Promise<Page<Project>> {
      await authorize(db, workspaceId, userId, 'project:read');
      const rows = await repository.list(workspaceId, page, options);
      return toPage(rows.map(toProject), page.limit, (project) => project.id);
    },

    async get(userId: string, workspaceId: string, projectId: string): Promise<Project> {
      await authorize(db, workspaceId, userId, 'project:read');
      const row = await repository.find(workspaceId, projectId);
      if (row === undefined) throw new HttpProblem(ProblemTypes.notFound, PROJECT_NOT_FOUND);
      return toProject(row);
    },

    async create(userId: string, workspaceId: string, input: { name: string }): Promise<Project> {
      await authorize(db, workspaceId, userId, 'project:write');
      return toProject(await repository.insert(workspaceId, { id: uuidv7(), name: input.name }));
    },

    async rename(
      userId: string,
      workspaceId: string,
      projectId: string,
      name: string,
    ): Promise<Project> {
      await authorize(db, workspaceId, userId, 'project:write');
      const row = await repository.rename(workspaceId, projectId, name);
      if (row === undefined) throw new HttpProblem(ProblemTypes.notFound, PROJECT_NOT_FOUND);
      return toProject(row);
    },

    /** Archived projects keep their tasks, readable but frozen. */
    async archive(
      userId: string,
      workspaceId: string,
      projectId: string,
      context: RequestContext,
    ): Promise<void> {
      await authorize(db, workspaceId, userId, 'project:write');
      await db.transaction(async (tx) => {
        const archivedNow = await createProjectsRepository(tx).archive(workspaceId, projectId);
        if (archivedNow === undefined) {
          throw new HttpProblem(ProblemTypes.notFound, PROJECT_NOT_FOUND);
        }
        if (archivedNow) {
          await recordAuditEvent(
            tx,
            {
              action: 'project.archived',
              actorId: userId,
              workspaceId,
              target: `project:${projectId}`,
            },
            context,
          );
        }
      });
    },
  };
}

export type ProjectsService = ReturnType<typeof createProjectsService>;
