/**
 * Seeds a running API with synthetic data for the DAST scan (dast.yml):
 *
 * - an owner with a workspace, a project, a task and a pending invitation;
 * - a member who joined that workspace through an invitation link.
 *
 * The scanner acts as the member: it reaches real resources, while deleting
 * the workspace, the project, the owner's task or the owner answers 403, so
 * the scan cannot destroy what it is scanning.
 *
 *   node scripts/seed.ts --token-file <path> [--api http://127.0.0.1:3000]
 *
 * Prints the resource ids as JSON. The member's access token is written to
 * --token-file (mode 0600), never to stdout. Every address uses example.test.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export interface SeedIds {
  wsId: string;
  projectId: string;
  taskId: string;
  userId: string;
  invitationId: string;
}

type Call = (
  method: string,
  path: string,
  options?: { bearer?: string; body?: unknown },
) => Promise<Record<string, unknown>>;

function client(apiUrl: string): Call {
  return async (method, path, { bearer, body } = {}) => {
    const headers = new Headers({ accept: 'application/json' });
    if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)}`);
    return response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
  };
}

const PASSWORD = 'synthetic passphrase for the dast scan';

async function account(call: Call, role: string): Promise<{ email: string; token: string }> {
  const email = `dast-${role}-${randomUUID().slice(0, 8)}@example.test`;
  await call('POST', '/v1/auth/register', {
    body: { email, password: PASSWORD, name: `DAST ${role}` },
  });
  const { accessToken } = await call('POST', '/v1/auth/login', {
    body: { email, password: PASSWORD },
  });
  return { email, token: String(accessToken) };
}

export async function seed(apiUrl: string): Promise<{ ids: SeedIds; memberToken: string }> {
  const call = client(apiUrl);
  const owner = await account(call, 'owner');
  const me = await call('GET', '/v1/me', { bearer: owner.token });
  const { memberships, id: ownerId } = me as {
    id: string;
    memberships: { workspaceId: string }[];
  };
  const wsId = memberships[0]?.workspaceId;
  if (wsId === undefined) throw new Error('the owner has no workspace');
  const workspace = `/v1/workspaces/${wsId}`;

  const project = await call('POST', `${workspace}/projects`, {
    bearer: owner.token,
    body: { name: 'Website relaunch' },
  });
  const task = await call('POST', `${workspace}/projects/${String(project.id)}/tasks`, {
    bearer: owner.token,
    body: { title: 'Draft release notes', priority: 'medium' },
  });

  const member = await account(call, 'member');
  const invitation = await call('POST', `${workspace}/invitations`, {
    bearer: owner.token,
    body: { role: 'member', email: member.email },
  });
  await call('POST', '/v1/invitations/accept', {
    bearer: member.token,
    body: { token: invitation.token },
  });
  // Left pending, so the invitation routes have something to list and revoke.
  const pending = await call('POST', `${workspace}/invitations`, {
    bearer: owner.token,
    body: { role: 'viewer', email: `dast-pending-${randomUUID().slice(0, 8)}@example.test` },
  });

  return {
    ids: {
      wsId,
      projectId: String(project.id),
      taskId: String(task.id),
      userId: ownerId,
      invitationId: String(pending.id),
    },
    memberToken: member.token,
  };
}

async function main(argv: string[]): Promise<void> {
  const option = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const tokenFile = option('--token-file');
  if (tokenFile === undefined) throw new Error('usage: seed.ts --token-file <path> [--api <url>]');
  const { ids, memberToken } = await seed(option('--api') ?? 'http://127.0.0.1:3000');
  // The path comes from the workflow's command line.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(tokenFile, memberToken, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(ids)}\n`);
}

if (import.meta.main) await main(process.argv.slice(2));
