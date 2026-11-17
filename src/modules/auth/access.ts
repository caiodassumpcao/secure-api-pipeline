import { and, eq } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { memberships, type Role } from '../../db/schema.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { can, type Action } from './permissions.ts';

export const WORKSPACE_NOT_FOUND = 'The workspace does not exist.';

export async function roleOf(
  db: Executor,
  workspaceId: string,
  userId: string,
): Promise<Role | undefined> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  return row?.role;
}

/**
 * Tenant isolation and authorization for one workspace-scoped request.
 *
 * Non-members get 404, exactly like a workspace that does not exist, so the
 * response never confirms that another tenant's workspace or resource exists.
 * Members without the permission get 403.
 */
export async function authorize(
  db: Executor,
  workspaceId: string,
  userId: string,
  action: Action,
): Promise<Role> {
  const role = await roleOf(db, workspaceId, userId);
  if (role === undefined) throw new HttpProblem(ProblemTypes.notFound, WORKSPACE_NOT_FOUND);
  assertCan(role, action);
  return role;
}

export function assertCan(role: Role, action: Action): void {
  if (!can(role, action)) {
    throw new HttpProblem(
      ProblemTypes.forbidden,
      'Your role in this workspace does not allow this action.',
    );
  }
}
