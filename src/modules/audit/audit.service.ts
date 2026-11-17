import type { Db } from '../../db/database.ts';
import { toPage, type Page, type PageRequest } from '../../lib/pagination.ts';
import { authorize } from '../auth/access.ts';
import { createAuditRepository, type AuditEventRow } from './audit.repository.ts';
import type { AuditAction } from './audit.ts';

export interface AuditEventView {
  id: string;
  action: string;
  actorId: string | null;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toView(row: AuditEventRow): AuditEventView {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export function createAuditService(db: Db) {
  const repository = createAuditRepository(db);
  return {
    /** Owners and admins read their workspace's trail (DESIGN §2.1). */
    async list(
      userId: string,
      workspaceId: string,
      page: PageRequest,
      filters: { action?: AuditAction | undefined },
    ): Promise<Page<AuditEventView>> {
      await authorize(db, workspaceId, userId, 'audit:read');
      const rows = await repository.list(workspaceId, page, filters);
      return toPage(rows.map(toView), page.limit, (event) => event.id);
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
