import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_RETENTION_DAYS } from '../../src/db/schema.ts';
import { runCleanup } from '../../src/jobs/cleanup.ts';
import { uuidv7 } from '../../src/lib/ids.ts';
import { LOCKOUT_THRESHOLD } from '../../src/modules/auth/policy.ts';
import { expectStatus, TestApi } from './helpers/api.ts';

let api: TestApi;

beforeAll(async () => {
  api = await TestApi.start();
});

afterAll(async () => {
  await api.stop();
});

const PASSWORD = 'correct horse battery staple';
const CLIENT = { remoteAddress: '203.0.113.42', headers: { 'user-agent': 'audit-test/1.0' } };

interface EventRow {
  action: string;
  actor_id: string | null;
  workspace_id: string | null;
  target: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

async function events(filter: { target?: string; workspaceId?: string }): Promise<EventRow[]> {
  const { rows } = await api.testDatabase.database.pool.query<EventRow>(
    `SELECT action, actor_id, workspace_id, target, host(ip) AS ip, user_agent, metadata
       FROM audit_events
      WHERE ($1::text IS NULL OR target = $1) AND ($2::uuid IS NULL OR workspace_id = $2)
      ORDER BY id`,
    [filter.target ?? null, filter.workspaceId ?? null],
  );
  return rows;
}

let sequence = 0;
async function register() {
  sequence += 1;
  const email = `audited-${sequence}-${Date.now()}@example.test`;
  const response = await api.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, name: 'Ana' },
    ...CLIENT,
  });
  expectStatus(response, 201);
  return { id: response.json<{ id: string }>().id, email };
}

function login(email: string, password: string, cookie?: string) {
  return api.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
    remoteAddress: CLIENT.remoteAddress,
    headers: { ...CLIENT.headers, ...(cookie === undefined ? {} : { cookie }) },
  });
}

describe('authentication events', () => {
  it('records registration and login with the client IP and user agent', async () => {
    const account = await register();
    expectStatus(await login(account.email, PASSWORD), 200);

    expect(await events({ target: `user:${account.id}` })).toEqual([
      {
        action: 'auth.registered',
        actor_id: account.id,
        workspace_id: null,
        target: `user:${account.id}`,
        ip: '203.0.113.42',
        user_agent: 'audit-test/1.0',
        metadata: { personalWorkspaceId: expect.any(String) },
      },
      expect.objectContaining({
        action: 'auth.login.succeeded',
        actor_id: account.id,
        metadata: { trustedDevice: false },
      }),
    ]);
  });

  it('records failures and the lock, without the email of an unknown account', async () => {
    const account = await register();
    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
      await login(account.email, 'not the password');
    }
    const unknown = `nobody-${Date.now()}@example.test`;
    await login(unknown, PASSWORD);

    const actions = (await events({ target: `user:${account.id}` })).map((event) => event.action);
    expect(actions.filter((action) => action === 'auth.login.failed')).toHaveLength(
      LOCKOUT_THRESHOLD,
    );
    expect(actions.filter((action) => action === 'auth.locked')).toHaveLength(1);
    const { rows } = await api.testDatabase.database.pool.query<EventRow>(
      `SELECT action, actor_id, target, metadata FROM audit_events
        WHERE action = 'auth.login.failed' AND target IS NULL ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({
      actor_id: null,
      metadata: { reason: 'unknown_account', trustedDevice: false },
    });
    expect(JSON.stringify(rows[0])).not.toContain(unknown);
  });

  it('records refresh-token reuse and logout', async () => {
    const account = await register();
    const response = await login(account.email, PASSWORD);
    const token = response.cookies.find((cookie) => cookie.name === '__Secure-refresh')?.value;
    const refresh = (value: string | undefined) =>
      api.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: `__Secure-refresh=${value}` },
      });
    const next = (await refresh(token)).cookies.find((c) => c.name === '__Secure-refresh')?.value;
    await api.testDatabase.database.pool.query(
      `UPDATE refresh_tokens SET rotated_at = now() - interval '1 hour' WHERE replaced_by IS NOT NULL`,
    );
    expect((await refresh(token)).statusCode).toBe(401);
    const second = await login(account.email, PASSWORD);
    const secondToken = second.cookies.find((c) => c.name === '__Secure-refresh')?.value;
    await api.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: `__Secure-refresh=${secondToken}` },
    });

    const recorded = await events({ target: `user:${account.id}` });
    expect(recorded.map((event) => event.action)).toEqual(
      expect.arrayContaining(['auth.refresh.reuse_detected', 'auth.logout']),
    );
    expect(recorded.find((event) => event.action === 'auth.refresh.reuse_detected')).toMatchObject({
      actor_id: null,
      metadata: { sessionId: expect.any(String) },
    });
    expect(next).toBeDefined();
  });
});

describe('workspace events', () => {
  it('records member changes in the same transaction as the change', async () => {
    const team = await api.createTeam();
    const members = `/v1/workspaces/${team.workspaceId}/members`;
    const owner = api.as(team.owner);

    await owner.patch(`${members}/${team.viewer.id}`, { role: 'member' });
    await owner.patch(`${members}/${team.viewer.id}`, { role: 'member' }); // no change
    await owner.delete(`${members}/${team.viewer.id}`);
    expect((await owner.delete(`${members}/${team.owner.id}`)).statusCode).toBe(409);

    const recorded = await events({ workspaceId: team.workspaceId });
    expect(recorded.map((event) => [event.action, event.target, event.metadata])).toEqual([
      ['member.added', `user:${team.admin.id}`, { role: 'admin' }],
      ['member.added', `user:${team.member.id}`, { role: 'member' }],
      ['member.added', `user:${team.viewer.id}`, { role: 'viewer' }],
      ['member.role_changed', `user:${team.viewer.id}`, { from: 'viewer', to: 'member' }],
      ['member.removed', `user:${team.viewer.id}`, { role: 'member' }],
    ]);
    expect(recorded.every((event) => event.actor_id === team.owner.id)).toBe(true);
  });

  it('records an archive once, and a deletion that outlives the workspace', async () => {
    const team = await api.createTeam();
    const projectId = await api.createProject(team.owner, team.workspaceId);
    const ws = `/v1/workspaces/${team.workspaceId}`;
    await api.as(team.admin).delete(`${ws}/projects/${projectId}`);
    await api.as(team.admin).delete(`${ws}/projects/${projectId}`);
    const slug = (await api.as(team.owner).get(ws)).json<{ slug: string }>().slug;

    expectStatus(await api.as(team.owner).delete(ws), 204);

    const recorded = await events({ workspaceId: team.workspaceId });
    expect(recorded.filter((event) => event.action === 'project.archived')).toEqual([
      expect.objectContaining({ actor_id: team.admin.id, target: `project:${projectId}` }),
    ]);
    expect(recorded.at(-1)).toMatchObject({
      action: 'workspace.deleted',
      actor_id: team.owner.id,
      metadata: { name: 'Workspace', slug },
    });
  });
});

describe('retention', () => {
  it('the cleanup job deletes events past the retention period only', async () => {
    const { pool } = api.testDatabase.database;
    const insert = (id: string, days: number) =>
      pool.query(
        `INSERT INTO audit_events (id, action, created_at)
         VALUES ($1, 'test.event', now() - make_interval(days => $2))`,
        [id, days],
      );
    const old = uuidv7();
    const recent = uuidv7();
    await insert(old, AUDIT_RETENTION_DAYS + 1);
    await insert(recent, AUDIT_RETENTION_DAYS - 1);

    const report = await runCleanup(api.db);

    expect(report.deleted.audit_events).toBe(1);
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM audit_events WHERE id = ANY($1)',
      [[old, recent]],
    );
    expect(rows.map((row) => row.id)).toEqual([recent]);
  });
});

describe('GET /v1/workspaces/:wsId/audit-events', () => {
  it('lists the workspace trail newest first, paginated, filterable by action', async () => {
    const team = await api.createTeam();
    const url = `/v1/workspaces/${team.workspaceId}/audit-events`;
    await api
      .as(team.owner)
      .patch(`/v1/workspaces/${team.workspaceId}/members/${team.viewer.id}`, { role: 'member' });

    const first = await api.as(team.admin).get(`${url}?limit=2`);
    expectStatus(first, 200);
    const page = first.json<{ data: { action: string; actorId: string }[]; nextCursor: string }>();
    expect(page.data.map((event) => event.action)).toEqual(['member.role_changed', 'member.added']);
    expect(page.data[0]).toEqual({
      id: expect.any(String),
      action: 'member.role_changed',
      actorId: team.owner.id,
      target: `user:${team.viewer.id}`,
      ip: '127.0.0.1',
      userAgent: 'lightMyRequest',
      metadata: { from: 'viewer', to: 'member' },
      createdAt: expect.any(String),
    });

    const rest = await api.as(team.admin).get(`${url}?cursor=${page.nextCursor}`);
    expect(rest.json<{ data: unknown[]; nextCursor: null }>()).toEqual({
      data: [expect.objectContaining({ action: 'member.added' }), expect.anything()],
      nextCursor: null,
    });

    const filtered = await api.as(team.owner).get(`${url}?action=member.role_changed`);
    expect(filtered.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('rejects an unknown action filter', async () => {
    const team = await api.createTeam();

    const response = await api
      .as(team.owner)
      .get(`/v1/workspaces/${team.workspaceId}/audit-events?action=everything`);

    expect(response.statusCode).toBe(400);
  });
});
