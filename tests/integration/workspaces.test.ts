import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBLEM_TYPE_BASE_URI } from '../../src/lib/problem.ts';
import { expectStatus, TestApi, type TestUser } from './helpers/api.ts';

let api: TestApi;
let alice: TestUser;

beforeAll(async () => {
  api = await TestApi.start();
  alice = await api.createUser('Alice');
});

afterAll(async () => {
  await api.stop();
});

describe('POST /v1/workspaces', () => {
  it('creates a workspace and makes the caller its owner', async () => {
    const slug = api.uniqueSlug('acme');
    const response = await api.as(alice).post('/v1/workspaces', { name: '  Acme  ', slug });

    expect(response.statusCode).toBe(201);
    const workspace = response.json<{ id: string }>();
    expect(workspace).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Acme',
      slug,
      role: 'owner',
      createdAt: expect.any(String),
    });
    expect(response.headers.location).toBe(`/v1/workspaces/${workspace.id}`);

    const members = await api.as(alice).get(`/v1/workspaces/${workspace.id}/members`);
    expect(members.json<{ data: { userId: string; role: string }[] }>().data).toEqual([
      expect.objectContaining({ userId: alice.id, role: 'owner' }),
    ]);
  });

  it('rejects a slug already in use with 409', async () => {
    const slug = api.uniqueSlug();
    expectStatus(await api.as(alice).post('/v1/workspaces', { name: 'One', slug }), 201);

    const response = await api.as(alice).post('/v1/workspaces', { name: 'Two', slug });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ type: `${PROBLEM_TYPE_BASE_URI}conflict` });
  });

  it.each([
    ['an invalid slug', { name: 'X', slug: 'Not A Slug' }, 'body.slug'],
    ['an empty name', { name: '   ', slug: 'valid-slug' }, 'body.name'],
    ['an unknown field', { name: 'X', slug: 'valid-slug', ownerId: 'u' }, 'body'],
  ])('rejects %s', async (_case, payload, path) => {
    const response = await api.as(alice).post('/v1/workspaces', payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it('requires authentication', async () => {
    const response = await api.as(null).post('/v1/workspaces', { name: 'X', slug: 'x-slug' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="secure-api"');
    expect(response.json()).toMatchObject({ type: `${PROBLEM_TYPE_BASE_URI}unauthorized` });
  });
});

describe('GET /v1/workspaces', () => {
  it('lists only the caller’s workspaces, paginated by cursor', async () => {
    const bob = await api.createUser('Bob');
    const ids = [];
    for (let index = 0; index < 5; index += 1)
      ids.push(await api.createWorkspace(bob, `B${index}`));
    await api.createWorkspace(alice, 'Not Bob’s');

    const first = await api.as(bob).get('/v1/workspaces?limit=2');
    const firstPage = first.json<{ data: { id: string; role: string }[]; nextCursor: string }>();
    expect(firstPage.data.map((workspace) => workspace.id)).toEqual(ids.slice(0, 2));
    expect(firstPage.data.every((workspace) => workspace.role === 'owner')).toBe(true);

    const second = await api
      .as(bob)
      .get(`/v1/workspaces?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    const secondPage = second.json<{ data: { id: string }[]; nextCursor: string }>();
    expect(secondPage.data.map((workspace) => workspace.id)).toEqual(ids.slice(2, 4));

    const third = await api.as(bob).get(`/v1/workspaces?limit=2&cursor=${secondPage.nextCursor}`);
    expect(third.json()).toEqual({
      data: [expect.objectContaining({ id: ids[4] })],
      nextCursor: null,
    });
  });

  it.each([
    ['limit=0', 'querystring.limit'],
    ['limit=101', 'querystring.limit'],
    ['cursor=not-a-cursor', 'querystring.cursor'],
    ['sort=name', 'querystring'],
  ])('rejects ?%s', async (query, path) => {
    const response = await api.as(alice).get(`/v1/workspaces?${query}`);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors).toEqual([
      expect.objectContaining({ path }),
    ]);
  });
});

describe('GET/PATCH/DELETE /v1/workspaces/:wsId', () => {
  it('reads, updates and deletes a workspace', async () => {
    const id = await api.createWorkspace(alice, 'Before');
    const base = `/v1/workspaces/${id}`;

    expect((await api.as(alice).get(base)).json()).toMatchObject({ id, name: 'Before' });

    const slug = api.uniqueSlug('after');
    const patched = await api.as(alice).patch(base, { name: 'After', slug });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id, name: 'After', slug, role: 'owner' });

    const deleted = await api.as(alice).delete(base);
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await api.as(alice).get(base)).statusCode).toBe(404);
  });

  it('rejects an empty patch', async () => {
    const id = await api.createWorkspace(alice);

    const response = await api.as(alice).patch(`/v1/workspaces/${id}`, {});

    expect(response.statusCode).toBe(400);
  });

  it('rejects renaming to a slug in use with 409', async () => {
    const taken = api.uniqueSlug('taken');
    expectStatus(await api.as(alice).post('/v1/workspaces', { name: 'A', slug: taken }), 201);
    const id = await api.createWorkspace(alice);

    const response = await api.as(alice).patch(`/v1/workspaces/${id}`, { slug: taken });

    expect(response.statusCode).toBe(409);
  });

  it('deletes projects, tasks and memberships with the workspace', async () => {
    const team = await api.createTeam();
    const projectId = await api.createProject(team.owner, team.workspaceId);
    const taskId = await api.createTask(team.member, team.workspaceId, projectId, {
      assigneeId: team.member.id,
    });

    expectStatus(await api.as(team.owner).delete(`/v1/workspaces/${team.workspaceId}`), 204);

    const { rows } = await api.testDatabase.database.pool.query<{ total: string }>(
      `SELECT (SELECT count(*) FROM tasks WHERE id = $1)
            + (SELECT count(*) FROM projects WHERE id = $2)
            + (SELECT count(*) FROM memberships WHERE workspace_id = $3) AS total`,
      [taskId, projectId, team.workspaceId],
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('answers 400 for a malformed id', async () => {
    const response = await api.as(alice).get('/v1/workspaces/not-a-uuid');

    expect(response.statusCode).toBe(400);
  });
});
