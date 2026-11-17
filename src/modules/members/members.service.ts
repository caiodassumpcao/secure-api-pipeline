import type { Db, Executor } from '../../db/database.ts';
import type { Role } from '../../db/schema.ts';
import { toPage, type Page, type PageRequest } from '../../lib/pagination.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { assertCan, authorize } from '../auth/access.ts';
import { createWorkspacesRepository } from '../workspaces/workspaces.repository.ts';
import { createMembersRepository, type MemberRow } from './members.repository.ts';

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
}

const MEMBER_NOT_FOUND = 'The member does not exist.';
const LAST_OWNER = 'A workspace must keep at least one owner.';

function toMember(row: MemberRow): Member {
  return { ...row, joinedAt: row.joinedAt.toISOString() };
}

/**
 * Admins manage members but not owners: granting, changing or revoking the
 * owner role needs `member:manage-owners` (owners only). Granting it to another
 * member is how ownership is transferred.
 */
function assertCanManage(actorRole: Role, ...involvedRoles: Role[]): void {
  assertCan(actorRole, 'member:manage');
  if (involvedRoles.includes('owner')) assertCan(actorRole, 'member:manage-owners');
}

async function findOrThrow(db: Executor, workspaceId: string, userId: string): Promise<MemberRow> {
  const member = await createMembersRepository(db).find(workspaceId, userId);
  if (member === undefined) throw new HttpProblem(ProblemTypes.notFound, MEMBER_NOT_FOUND);
  return member;
}

async function assertNotLastOwner(db: Executor, workspaceId: string, member: MemberRow) {
  if (
    member.role === 'owner' &&
    (await createMembersRepository(db).countOwners(workspaceId)) <= 1
  ) {
    throw new HttpProblem(ProblemTypes.conflict, LAST_OWNER);
  }
}

export function createMembersService(db: Db) {
  const repository = createMembersRepository(db);

  return {
    async list(userId: string, workspaceId: string, page: PageRequest): Promise<Page<Member>> {
      await authorize(db, workspaceId, userId, 'member:read');
      const rows = await repository.list(workspaceId, page);
      return toPage(rows.map(toMember), page.limit, (member) => member.userId);
    },

    async get(actorId: string, workspaceId: string, userId: string): Promise<Member> {
      await authorize(db, workspaceId, actorId, 'member:read');
      return toMember(await findOrThrow(db, workspaceId, userId));
    },

    async add(
      actorId: string,
      workspaceId: string,
      input: { email: string; role: Role },
    ): Promise<Member> {
      const actorRole = await authorize(db, workspaceId, actorId, 'member:manage');
      assertCanManage(actorRole, input.role);

      const userId = await repository.findUserIdByEmail(input.email);
      if (userId === undefined) {
        throw new HttpProblem(ProblemTypes.notFound, 'No account uses this email address.');
      }
      if (!(await repository.insert(workspaceId, userId, input.role))) {
        throw new HttpProblem(ProblemTypes.conflict, 'This user is already a member.');
      }
      return toMember(await findOrThrow(db, workspaceId, userId));
    },

    async changeRole(
      actorId: string,
      workspaceId: string,
      userId: string,
      role: Role,
    ): Promise<Member> {
      return db.transaction(async (tx) => {
        await createWorkspacesRepository(tx).lock(workspaceId);
        const actorRole = await authorize(tx, workspaceId, actorId, 'member:manage');
        const member = await findOrThrow(tx, workspaceId, userId);
        assertCanManage(actorRole, member.role, role);
        if (role !== 'owner') await assertNotLastOwner(tx, workspaceId, member);

        await createMembersRepository(tx).updateRole(workspaceId, userId, role);
        return toMember({ ...member, role });
      });
    },

    /** Removes a membership; the workspace keeps at least one owner. */
    async remove(actorId: string, workspaceId: string, userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const members = createMembersRepository(tx);
        await createWorkspacesRepository(tx).lock(workspaceId);
        const actorRole = await authorize(tx, workspaceId, actorId, 'member:manage');
        const member = await findOrThrow(tx, workspaceId, userId);
        assertCanManage(actorRole, member.role);
        await assertNotLastOwner(tx, workspaceId, member);

        await members.delete(workspaceId, userId);
      });
    },
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
