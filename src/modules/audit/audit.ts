import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Executor } from '../../db/database.ts';
import { auditEvents } from '../../db/schema.ts';
import { uuidv7 } from '../../lib/ids.ts';

/** DESIGN §5.3. */
export const AUDIT_ACTIONS = [
  'auth.registered',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.locked',
  'auth.refresh.reuse_detected',
  'auth.logout',
  'member.invited',
  'invitation.revoked',
  'member.added',
  'member.removed',
  'member.role_changed',
  'project.archived',
  'workspace.deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Who made the request, as far as the API can tell. Personal data: kept 365 days. */
export interface RequestContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

const USER_AGENT_MAX_LENGTH = 256;

export function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    // Behind an untrusted or misconfigured proxy the value could be anything.
    ip: isIP(request.ip) === 0 ? null : request.ip,
    userAgent: userAgent === undefined ? null : userAgent.slice(0, USER_AGENT_MAX_LENGTH),
  };
}

export interface AuditEvent {
  readonly action: AuditAction;
  /** The authenticated user who acted, if any. */
  readonly actorId?: string | null | undefined;
  readonly workspaceId?: string | null | undefined;
  /** What the action was about: `user:<id>`, `project:<id>`, … */
  readonly target?: string | null | undefined;
  /** Never secrets, passwords, tokens or the email address of an unknown account. */
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Appends an audit event. Pass the transaction of the change it describes, so
 * both are committed or neither is (DESIGN §5.3).
 */
export async function recordAuditEvent(
  db: Executor,
  event: AuditEvent,
  context: RequestContext,
): Promise<void> {
  await db.insert(auditEvents).values({
    id: uuidv7(),
    action: event.action,
    actorId: event.actorId ?? null,
    workspaceId: event.workspaceId ?? null,
    target: event.target ?? null,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: event.metadata ?? {},
  });
}
