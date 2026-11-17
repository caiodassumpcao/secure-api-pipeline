import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectStatus, TestApi, type Team } from './helpers/api.ts';
import { waitForLockWait } from './helpers/database.ts';

let api: TestApi;

beforeAll(async () => {
  api = await TestApi.start();
});

afterAll(async () => {
  await api.stop();
});

const members = (team: Team) => `/v1/workspaces/${team.workspaceId}/members`;

describe('workspace members', () => {
  it('lists members with their role, paginated', async () => {
    const team = await api.createTeam();

    const first = await api.as(team.viewer).get(`${members(team)}?limit=3`);
    expect(first.statusCode).toBe(200);
    const page = first.json<{ data: { userId: string }[]; nextCursor: string }>();
    expect(page.data).toHaveLength(3);

    const second = await api.as(team.viewer).get(`${members(team)}?cursor=${page.nextCursor}`);
    const rest = second.json<{ data: { userId: string; role: string }[]; nextCursor: null }>();
    expect(rest.nextCursor).toBeNull();
    expect([...page.data, ...rest.data].map((member) => member.userId).sort()).toEqual(
      [team.owner.id, team.admin.id, team.member.id, team.viewer.id].sort(),
    );
  });

  it('adds an existing account by email, case-insensitively', async () => {
    const team = await api.createTeam();
    const carol = await api.createUser('Carol');

    const response = await api
      .as(team.admin)
      .post(members(team), { email: carol.email.toUpperCase(), role: 'member' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      userId: carol.id,
      email: carol.email,
      name: 'Carol',
      role: 'member',
      joinedAt: expect.any(String),
    });
    expect(response.headers.location).toBe(`${members(team)}/${carol.id}`);
  });

  it('answers 404 for an email without an account and 409 for an existing member', async () => {
    const team = await api.createTeam();

    const unknown = await api
      .as(team.owner)
      .post(members(team), { email: 'nobody@example.test', role: 'member' });
    expect(unknown.statusCode).toBe(404);

    const duplicate = await api
      .as(team.owner)
      .post(members(team), { email: team.member.email, role: 'viewer' });
    expect(duplicate.statusCode).toBe(409);
  });

  it('changes roles', async () => {
    const team = await api.createTeam();

    const response = await api
      .as(team.admin)
      .patch(`${members(team)}/${team.viewer.id}`, { role: 'member' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId: team.viewer.id, role: 'member' });
  });

  describe('owners', () => {
    it('admins can neither grant, change nor remove the owner role', async () => {
      const team = await api.createTeam();
      const dave = await api.createUser('Dave');

      const grantOnAdd = await api
        .as(team.admin)
        .post(members(team), { email: dave.email, role: 'owner' });
      const grantOnChange = await api
        .as(team.admin)
        .patch(`${members(team)}/${team.member.id}`, { role: 'owner' });
      const demote = await api
        .as(team.admin)
        .patch(`${members(team)}/${team.owner.id}`, { role: 'member' });
      const remove = await api.as(team.admin).delete(`${members(team)}/${team.owner.id}`);

      expect([grantOnAdd, grantOnChange, demote, remove].map((r) => r.statusCode)).toEqual([
        403, 403, 403, 403,
      ]);
    });

    it('an owner transfers ownership by granting it, then can step down', async () => {
      const team = await api.createTeam();

      expectStatus(
        await api.as(team.owner).patch(`${members(team)}/${team.admin.id}`, { role: 'owner' }),
        200,
      );
      const stepDown = await api
        .as(team.owner)
        .patch(`${members(team)}/${team.owner.id}`, { role: 'admin' });

      expect(stepDown.statusCode).toBe(200);
      expect(stepDown.json()).toMatchObject({ role: 'admin' });
    });

    it('the last owner can neither be demoted nor removed', async () => {
      const team = await api.createTeam();

      const demote = await api
        .as(team.owner)
        .patch(`${members(team)}/${team.owner.id}`, { role: 'admin' });
      const remove = await api.as(team.owner).delete(`${members(team)}/${team.owner.id}`);

      expect(demote.statusCode).toBe(409);
      expect(remove.statusCode).toBe(409);
    });

    it('two owners stepping down at the same time cannot leave the workspace without owner', async () => {
      const team = await api.createTeam();
      expectStatus(
        await api.as(team.owner).patch(`${members(team)}/${team.admin.id}`, { role: 'owner' }),
        200,
      );

      const results = await Promise.all([
        api.as(team.owner).patch(`${members(team)}/${team.owner.id}`, { role: 'member' }),
        api.as(team.admin).patch(`${members(team)}/${team.admin.id}`, { role: 'member' }),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const list = await api.as(team.viewer).get(members(team));
      const roles = list.json<{ data: { role: string }[] }>().data.map((member) => member.role);
      expect(roles.filter((role) => role === 'owner')).toHaveLength(1);
    });
  });

  it('removing a member unassigns their tasks', async () => {
    const team = await api.createTeam();
    const projectId = await api.createProject(team.owner, team.workspaceId);
    const taskId = await api.createTask(team.owner, team.workspaceId, projectId, {
      assigneeId: team.member.id,
    });

    expectStatus(await api.as(team.admin).delete(`${members(team)}/${team.member.id}`), 204);

    const task = await api.as(team.owner).get(`/v1/workspaces/${team.workspaceId}/tasks/${taskId}`);
    expect(task.json()).toMatchObject({ id: taskId, assigneeId: null });
    expect((await api.as(team.member).get(members(team))).statusCode).toBe(404);
  });

  it('removing a member waits for a concurrent assignment to them, then unassigns it', async () => {
    const team = await api.createTeam();
    const projectId = await api.createProject(team.owner, team.workspaceId);
    const taskId = await api.createTask(team.owner, team.workspaceId, projectId);
    const { pool } = api.testDatabase.database;

    // An assignment in flight: its foreign key check holds a lock on the membership.
    const assignment = await pool.connect();
    try {
      await assignment.query('BEGIN');
      await assignment.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [
        team.member.id,
        taskId,
      ]);
      const removal = api.as(team.admin).delete(`${members(team)}/${team.member.id}`);
      await waitForLockWait(pool);
      await assignment.query('COMMIT');

      expectStatus(await removal, 204);
    } finally {
      // No-op after COMMIT; unblocks the removal if the test failed before it.
      await assignment.query('ROLLBACK');
      assignment.release();
    }

    const task = await api.as(team.owner).get(`/v1/workspaces/${team.workspaceId}/tasks/${taskId}`);
    expect(task.json()).toMatchObject({ id: taskId, assigneeId: null });
  });

  it('reads a member', async () => {
    const team = await api.createTeam();

    const response = await api.as(team.viewer).get(`${members(team)}/${team.admin.id}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: team.admin.id,
      email: team.admin.email,
      name: 'Admin',
      role: 'admin',
      joinedAt: expect.any(String),
    });
  });

  it('answers 404 for a user who is not a member', async () => {
    const team = await api.createTeam();
    const stranger = await api.createUser();

    const read = await api.as(team.owner).get(`${members(team)}/${stranger.id}`);
    const change = await api
      .as(team.owner)
      .patch(`${members(team)}/${stranger.id}`, { role: 'member' });
    const remove = await api.as(team.owner).delete(`${members(team)}/${stranger.id}`);

    expect([read.statusCode, change.statusCode, remove.statusCode]).toEqual([404, 404, 404]);
  });

  it.each([
    [{ email: 'not-an-email', role: 'member' }, 'body.email'],
    [{ email: 'a@example.test', role: 'superuser' }, 'body.role'],
  ])('validates %o', async (payload, path) => {
    const team = await api.createTeam();

    const response = await api.as(team.owner).post(members(team), payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe(path);
  });
});
