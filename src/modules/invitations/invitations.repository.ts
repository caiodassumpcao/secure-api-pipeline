import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { invitations, type Role } from '../../db/schema.ts';
import { uuidv7 } from '../../lib/ids.ts';
import { generateOpaqueToken, hashOpaqueToken } from '../../lib/opaque-token.ts';
import type { PageRequest } from '../../lib/pagination.ts';

export interface InvitationRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly email: string | null;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

const columns = {
  id: invitations.id,
  workspaceId: invitations.workspaceId,
  role: invitations.role,
  email: invitations.email,
  invitedBy: invitations.invitedBy,
  createdAt: invitations.createdAt,
  expiresAt: invitations.expiresAt,
};

/** Neither accepted, revoked nor expired. */
const pending = () =>
  and(
    isNull(invitations.acceptedAt),
    isNull(invitations.revokedAt),
    gt(invitations.expiresAt, sql`now()`),
  );

/**
 * Every query is scoped by `workspaceId` (ADR-0005), except the lookup by
 * token: the link is the capability, held by whoever the inviter gave it to.
 */
export function createInvitationsRepository(db: Executor) {
  return {
    async insert(
      workspaceId: string,
      values: { role: Role; email: string | null; invitedBy: string; ttlMs: number },
    ): Promise<InvitationRow & { token: string }> {
      const token = generateOpaqueToken();
      const [row] = await db
        .insert(invitations)
        .values({
          id: uuidv7(),
          workspaceId,
          role: values.role,
          email: values.email,
          invitedBy: values.invitedBy,
          tokenHash: hashOpaqueToken(token),
          expiresAt: sql`now() + ${values.ttlMs}::bigint * interval '1 millisecond'`,
        })
        .returning(columns);
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return { ...row, token };
    },

    async listPending(workspaceId: string, page: PageRequest): Promise<InvitationRow[]> {
      return db
        .select(columns)
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            pending(),
            page.after === undefined ? undefined : gt(invitations.id, page.after),
          ),
        )
        .orderBy(asc(invitations.id))
        .limit(page.limit + 1);
    },

    async findPending(
      workspaceId: string,
      invitationId: string,
    ): Promise<InvitationRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            eq(invitations.id, invitationId),
            pending(),
          ),
        );
      return row;
    },

    async revoke(workspaceId: string, invitationId: string): Promise<void> {
      await db
        .update(invitations)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(invitations.workspaceId, workspaceId), eq(invitations.id, invitationId)));
    },

    /** The pending invitation behind a link, row-locked so it is accepted once. */
    async findPendingByTokenForUpdate(token: string): Promise<InvitationRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(invitations)
        .where(and(eq(invitations.tokenHash, hashOpaqueToken(token)), pending()))
        .for('update');
      return row;
    },

    async markAccepted(invitationId: string, userId: string): Promise<void> {
      await db
        .update(invitations)
        .set({ acceptedBy: userId, acceptedAt: sql`now()` })
        .where(eq(invitations.id, invitationId));
    },
  };
}
