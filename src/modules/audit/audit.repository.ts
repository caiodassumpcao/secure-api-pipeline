import { and, desc, eq, lt } from 'drizzle-orm';
import type { Executor } from '../../db/database.ts';
import { auditEvents } from '../../db/schema.ts';
import type { PageRequest } from '../../lib/pagination.ts';
import type { AuditAction } from './audit.ts';

export interface AuditEventRow {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly target: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

/** Every query is scoped by `workspaceId` (ADR-0005). */
export function createAuditRepository(db: Executor) {
  return {
    /** Newest first: the cursor is the id of the last (oldest) event returned. */
    async list(
      workspaceId: string,
      page: PageRequest,
      filters: { action?: AuditAction | undefined },
    ): Promise<AuditEventRow[]> {
      return db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          actorId: auditEvents.actorId,
          target: auditEvents.target,
          ip: auditEvents.ip,
          userAgent: auditEvents.userAgent,
          metadata: auditEvents.metadata,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            filters.action === undefined ? undefined : eq(auditEvents.action, filters.action),
            page.after === undefined ? undefined : lt(auditEvents.id, page.after),
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(page.limit + 1);
    },
  };
}
