import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectStatus, TestApi, type Team } from './helpers/api.ts';

let api: TestApi;
let team: Team;
let projectId: string;

beforeAll(async () => {
  api = await TestApi.start();
  team = await api.createTeam();
  projectId = await api.createProject(team.owner, team.workspaceId);
});

afterAll(async () => {
  await api.stop();
});

const ws = () => `/v1/workspaces/${team.workspaceId}`;
const projectTasks = (id = projectId) => `${ws()}/projects/${id}/tasks`;

describe('tasks', () => {
  it('creates a task with defaults and reads it back', async () => {
    const response = await api.as(team.member).post(projectTasks(), { title: ' Write docs ' });

    expect(response.statusCode).toBe(201);
    const task = response.json<{ id: string }>();
    expect(task).toEqual({
      id: expect.any(String),
      projectId,
      title: 'Write docs',
      description: null,
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      dueDate: null,
      createdBy: team.member.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(response.headers.location).toBe(`${ws()}/tasks/${task.id}`);
    expect((await api.as(team.viewer).get(`${ws()}/tasks/${task.id}`)).json()).toEqual(task);
  });

  it('creates a task with every field', async () => {
    const response = await api.as(team.admin).post(projectTasks(), {
      title: 'Ship',
      description: 'Release notes',
      status: 'in_progress',
      priority: 'high',
      assigneeId: team.member.id,
      dueDate: '2026-12-31',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      description: 'Release notes',
      status: 'in_progress',
      priority: 'high',
      assigneeId: team.member.id,
      dueDate: '2026-12-31',
    });
  });

  it('updates fields, clears nullable ones and bumps updatedAt', async () => {
    const id = await api.createTask(team.member, team.workspaceId, projectId, {
      assigneeId: team.member.id,
      dueDate: '2026-11-30',
    });
    const before = (await api.as(team.member).get(`${ws()}/tasks/${id}`)).json<{
      updatedAt: string;
    }>();

    const response = await api.as(team.member).patch(`${ws()}/tasks/${id}`, {
      status: 'done',
      assigneeId: null,
      dueDate: null,
    });

    expect(response.statusCode).toBe(200);
    const after = response.json<{ updatedAt: string }>();
    expect(after).toMatchObject({ status: 'done', assigneeId: null, dueDate: null });
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
  });

  it('rejects an assignee who is not a member', async () => {
    const stranger = await api.createUser();
    const id = await api.createTask(team.member, team.workspaceId, projectId);

    const created = await api
      .as(team.member)
      .post(projectTasks(), { title: 'X', assigneeId: stranger.id });
    const updated = await api
      .as(team.member)
      .patch(`${ws()}/tasks/${id}`, { assigneeId: stranger.id });

    for (const response of [created, updated]) {
      expect(response.statusCode).toBe(400);
      expect(response.json<{ errors: { path: string }[] }>().errors).toEqual([
        { path: 'body.assigneeId', message: 'Must be a member of the workspace' },
      ]);
    }
  });

  it('filters by status, priority and assignee, with pagination', async () => {
    const project = await api.createProject(team.owner, team.workspaceId, 'Filters');
    const matching = [];
    for (let index = 0; index < 3; index += 1) {
      matching.push(
        await api.createTask(team.member, team.workspaceId, project, {
          status: 'in_progress',
          priority: 'high',
          assigneeId: team.admin.id,
        }),
      );
    }
    await api.createTask(team.member, team.workspaceId, project, {
      status: 'done',
      priority: 'high',
    });
    await api.createTask(team.member, team.workspaceId, project, {
      status: 'in_progress',
      priority: 'low',
    });

    const filter = `status=in_progress&priority=high&assigneeId=${team.admin.id}`;
    const first = (
      await api.as(team.viewer).get(`${projectTasks(project)}?${filter}&limit=2`)
    ).json<{
      data: { id: string }[];
      nextCursor: string;
    }>();
    const second = (
      await api
        .as(team.viewer)
        .get(`${projectTasks(project)}?${filter}&limit=2&cursor=${first.nextCursor}`)
    ).json<{ data: { id: string }[]; nextCursor: string | null }>();

    expect([...first.data, ...second.data].map((task) => task.id)).toEqual(matching);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ['status=blocked', 'querystring.status'],
    ['priority=urgent', 'querystring.priority'],
    ['assigneeId=me', 'querystring.assigneeId'],
  ])('rejects ?%s', async (query, path) => {
    const response = await api.as(team.viewer).get(`${projectTasks()}?${query}`);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe(path);
  });

  it.each([
    [{ title: '' }, 'body.title'],
    [{ title: 'x'.repeat(201) }, 'body.title'],
    [{ title: 'X', dueDate: '31/12/2026' }, 'body.dueDate'],
    [{ title: 'X', createdBy: '0190f3b2-7c1e-7d2a-9f00-1234567890ab' }, 'body'],
  ])('rejects the body %o', async (payload, path) => {
    const response = await api.as(team.member).post(projectTasks(), payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe(path);
  });

  it('freezes the tasks of an archived project', async () => {
    const project = await api.createProject(team.owner, team.workspaceId, 'Frozen');
    const id = await api.createTask(team.member, team.workspaceId, project);
    expectStatus(await api.as(team.owner).delete(`${ws()}/projects/${project}`), 204);

    const create = await api.as(team.member).post(projectTasks(project), { title: 'Late' });
    const update = await api.as(team.member).patch(`${ws()}/tasks/${id}`, { status: 'done' });
    const remove = await api.as(team.member).delete(`${ws()}/tasks/${id}`);
    const read = await api.as(team.viewer).get(`${ws()}/tasks/${id}`);

    expect([create, update, remove, read].map((response) => response.statusCode)).toEqual([
      409, 409, 409, 200,
    ]);
  });

  it('answers 404 for tasks of an unknown project or an unknown task', async () => {
    const unknown = '0190f3b2-7c1e-7d2a-9f00-1234567890ab';

    const responses = await Promise.all([
      api.as(team.owner).get(projectTasks(unknown)),
      api.as(team.owner).post(projectTasks(unknown), { title: 'X' }),
      api.as(team.owner).get(`${ws()}/tasks/${unknown}`),
      api.as(team.owner).patch(`${ws()}/tasks/${unknown}`, { title: 'X' }),
      api.as(team.owner).delete(`${ws()}/tasks/${unknown}`),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
  });

  it('deletes a task', async () => {
    const id = await api.createTask(team.member, team.workspaceId, projectId);

    expectStatus(await api.as(team.member).delete(`${ws()}/tasks/${id}`), 204);

    expect((await api.as(team.member).get(`${ws()}/tasks/${id}`)).statusCode).toBe(404);
  });
});
