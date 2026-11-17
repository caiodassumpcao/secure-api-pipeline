import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectStatus, TestApi, type Team } from './helpers/api.ts';

let api: TestApi;
let team: Team;

beforeAll(async () => {
  api = await TestApi.start();
  team = await api.createTeam();
});

afterAll(async () => {
  await api.stop();
});

const projects = () => `/v1/workspaces/${team.workspaceId}/projects`;

describe('projects', () => {
  it('creates, reads and renames a project', async () => {
    const created = await api.as(team.admin).post(projects(), { name: 'Website' });
    expect(created.statusCode).toBe(201);
    const project = created.json<{ id: string }>();
    expect(project).toEqual({
      id: expect.any(String),
      name: 'Website',
      archivedAt: null,
      createdAt: expect.any(String),
    });
    expect(created.headers.location).toBe(`${projects()}/${project.id}`);

    expect((await api.as(team.viewer).get(`${projects()}/${project.id}`)).json()).toEqual(project);

    const renamed = await api.as(team.owner).patch(`${projects()}/${project.id}`, { name: 'Site' });
    expect(renamed.json()).toMatchObject({ id: project.id, name: 'Site' });
  });

  it('archives idempotently and hides archived projects unless asked', async () => {
    const id = await api.createProject(team.owner, team.workspaceId, 'Old');

    expectStatus(await api.as(team.admin).delete(`${projects()}/${id}`), 204);
    const archivedAt = (await api.as(team.owner).get(`${projects()}/${id}`)).json<{
      archivedAt: string;
    }>().archivedAt;
    expect(archivedAt).toEqual(expect.any(String));

    expectStatus(await api.as(team.admin).delete(`${projects()}/${id}`), 204);
    expect((await api.as(team.owner).get(`${projects()}/${id}`)).json()).toMatchObject({
      archivedAt,
    });

    const active = await api.as(team.owner).get(`${projects()}?limit=100`);
    const all = await api.as(team.owner).get(`${projects()}?limit=100&includeArchived=true`);
    const ids = (response: typeof active) =>
      response.json<{ data: { id: string }[] }>().data.map((project) => project.id);
    expect(ids(active)).not.toContain(id);
    expect(ids(all)).toContain(id);
  });

  it('paginates', async () => {
    const own = await api.createTeam();
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(await api.createProject(own.owner, own.workspaceId, `P${index}`));
    }
    const base = `/v1/workspaces/${own.workspaceId}/projects`;

    const first = (await api.as(own.member).get(`${base}?limit=2`)).json<{
      data: { id: string }[];
      nextCursor: string;
    }>();
    const second = (
      await api.as(own.member).get(`${base}?limit=2&cursor=${first.nextCursor}`)
    ).json<{
      data: { id: string }[];
      nextCursor: string | null;
    }>();

    expect([...first.data, ...second.data].map((project) => project.id)).toEqual(created);
    expect(second.nextCursor).toBeNull();
  });

  it('answers 404 for an unknown project', async () => {
    const unknown = '0190f3b2-7c1e-7d2a-9f00-1234567890ab';

    const responses = await Promise.all([
      api.as(team.owner).get(`${projects()}/${unknown}`),
      api.as(team.owner).patch(`${projects()}/${unknown}`, { name: 'X' }),
      api.as(team.owner).delete(`${projects()}/${unknown}`),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
  });

  it('rejects an invalid includeArchived value', async () => {
    const response = await api.as(team.owner).get(`${projects()}?includeArchived=yes`);

    expect(response.statusCode).toBe(400);
  });
});
