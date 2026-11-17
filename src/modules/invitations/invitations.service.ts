import type { Db } from '../../db/database.ts';
import type { Role } from '../../db/schema.ts';
import { toPage, type Page, type PageRequest } from '../../lib/pagination.ts';
import { HttpProblem, ProblemTypes } from '../../lib/problem.ts';
import { recordAuditEvent, type RequestContext } from '../audit/audit.ts';
import { createAuthRepository } from '../auth/auth.repository.ts';
import { assertCan, authorize } from '../auth/access.ts';
import { createMembersRepository } from '../members/members.repository.ts';
import { createWorkspacesRepository } from '../workspaces/workspaces.repository.ts';
import type { Workspace } from '../workspaces/workspaces.service.ts';
import { createInvitationsRepository, type InvitationRow } from './invitations.repository.ts';

/** How long an invitation link can be used. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

export interface Invitation {
  id: string;
  role: Role;
  email: string | null;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

const INVITATION_NOT_FOUND = 'The invitation does not exist or is no longer valid.';

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Owners alone grant the owner role, also through an invitation. */
function assertCanInvite(actorRole: Role, role: Role): void {
  assertCan(actorRole, 'member:manage');
  if (role === 'owner') assertCan(actorRole, 'member:manage-owners');
}

/**
 * Invitation links (ADR-0010) replace adding a member by email: creating one
 * never looks an account up, so nothing reveals whether an address has an
 * account, and nobody joins a workspace without accepting.
 */
export function createInvitationsService(db: Db) {
  const repository = createInvitationsRepository(db);

  return {
    async create(
      actorId: string,
      workspaceId: string,
      input: { role: Role; email?: string | undefined },
      context: RequestContext,
    ): Promise<Invitation & { token: string }> {
      const actorRole = await authorize(db, workspaceId, actorId, 'member:manage');
      assertCanInvite(actorRole, input.role);
      return db.transaction(async (tx) => {
        const created = await createInvitationsRepository(tx).insert(workspaceId, {
          role: input.role,
          email: input.email ?? null,
          invitedBy: actorId,
          ttlMs: INVITATION_TTL_MS,
        });
        await recordAuditEvent(
          tx,
          {
            action: 'member.invited',
            actorId,
            workspaceId,
            target: `invitation:${created.id}`,
            metadata: { role: input.role, restrictedToEmail: input.email !== undefined },
          },
          context,
        );
        return { ...toInvitation(created), token: created.token };
      });
    },

    async list(actorId: string, workspaceId: string, page: PageRequest): Promise<Page<Invitation>> {
      await authorize(db, workspaceId, actorId, 'member:manage');
      const rows = await repository.listPending(workspaceId, page);
      return toPage(rows.map(toInvitation), page.limit, (invitation) => invitation.id);
    },

    async revoke(
      actorId: string,
      workspaceId: string,
      invitationId: string,
      context: RequestContext,
    ): Promise<void> {
      const actorRole = await authorize(db, workspaceId, actorId, 'member:manage');
      const invitation = await repository.findPending(workspaceId, invitationId);
      if (invitation === undefined)
        throw new HttpProblem(ProblemTypes.notFound, INVITATION_NOT_FOUND);
      assertCanInvite(actorRole, invitation.role);
      await db.transaction(async (tx) => {
        await createInvitationsRepository(tx).revoke(workspaceId, invitationId);
        await recordAuditEvent(
          tx,
          {
            action: 'invitation.revoked',
            actorId,
            workspaceId,
            target: `invitation:${invitationId}`,
            metadata: { role: invitation.role },
          },
          context,
        );
      });
    },

    /**
     * Joins the workspace of an invitation link, once. An invitation addressed
     * to an email only works for the account with that email; any mismatch
     * gets the same 404 as an unknown link.
     */
    async accept(userId: string, token: string, context: RequestContext): Promise<Workspace> {
      return db.transaction(async (tx) => {
        const invitations = createInvitationsRepository(tx);
        const invitation = await invitations.findPendingByTokenForUpdate(token);
        const user = await createAuthRepository(tx).findUser(userId);
        if (
          invitation === undefined ||
          user === undefined ||
          (invitation.email !== null && invitation.email.toLowerCase() !== user.email.toLowerCase())
        ) {
          throw new HttpProblem(ProblemTypes.notFound, INVITATION_NOT_FOUND);
        }
        const { workspaceId, role } = invitation;
        if (!(await createMembersRepository(tx).insert(workspaceId, userId, role))) {
          throw new HttpProblem(
            ProblemTypes.conflict,
            'You are already a member of this workspace.',
          );
        }
        await invitations.markAccepted(invitation.id, userId);
        await recordAuditEvent(
          tx,
          {
            action: 'member.added',
            actorId: userId,
            workspaceId,
            target: `user:${userId}`,
            metadata: { role, invitationId: invitation.id, invitedBy: invitation.invitedBy },
          },
          context,
        );
        const workspace = await createWorkspacesRepository(tx).findForUser(workspaceId, userId);
        if (workspace === undefined) throw new Error('membership just created is missing');
        return { ...workspace, createdAt: workspace.createdAt.toISOString() };
      });
    },
  };
}

export type InvitationsService = ReturnType<typeof createInvitationsService>;
