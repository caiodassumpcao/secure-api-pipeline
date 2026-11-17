import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBLEM_TYPE_BASE_URI } from '../../src/lib/problem.ts';
import { TestApi, type TestUser } from '../integration/helpers/api.ts';

/**
 * Tenant isolation (DESIGN §5.1, ADR-0005): a caller never reads or changes data
 * of a workspace they do not belong to, and gets the same 404 a missing resource
 * gets, so the response does not even confirm the resource exists.
 */

let api: TestApi;
let attacker: TestUser;
let victim: TestUser;
let victimMember: TestUser;
/** The attacker's own workspace, where they are owner. */
let own: string;
let target: { workspaceId: string; projectId: string; taskId: string };

beforeAll(async () => {
  api = await TestApi.start();
  [attacker, victim, victimMember] = await Promise.all([
    api.createUser('Attacker'),
    api.createUser('Victim'),
    api.createUser('Victim member'),
  ]);
  own = await api.createWorkspace(attacker, 'Attacker workspace');

  const workspaceId = await api.createWorkspace(victim, 'Victim workspace');
  await api.addMember(victim, workspaceId, victimMember, 'member');
  const projectId = await api.createProject(victim, workspaceId);
  const taskId = await api.createTask(victim, workspaceId, projectId, {
    title: 'Secret plan',
    assigneeId: victimMember.id,
  });
  target = { workspaceId, projectId, taskId };
});

afterAll(async () => {
  await api.stop();
});

function expectHidden(response: LightMyRequestResponse) {
  expect(response.statusCode, response.body).toBe(404);
  expect(response.json()).toMatchObject({ type: `${PROBLEM_TYPE_BASE_URI}not-found` });
  expect(response.body).not.toContain('Secret plan');
}

type Request = [method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: () => string, body?: object];

describe('another tenant’s workspace', () => {
  const ws = () => `/v1/workspaces/${target.workspaceId}`;

  const requests: Request[] = [
    ['GET', ws],
    ['PATCH', ws, { name: 'Pwned' }],
    ['DELETE', ws],
    ['GET', () => `${ws()}/members`],
    ['POST', () => `${ws()}/members`, { email: 'x@example.test', role: 'owner' }],
    ['GET', () => `${ws()}/members/${victimMember.id}`],
    ['PATCH', () => `${ws()}/members/${victimMember.id}`, { role: 'owner' }],
    ['DELETE', () => `${ws()}/members/${victimMember.id}`],
    ['GET', () => `${ws()}/projects`],
    ['POST', () => `${ws()}/projects`, { name: 'Injected' }],
    ['GET', () => `${ws()}/projects/${target.projectId}`],
    ['PATCH', () => `${ws()}/projects/${target.projectId}`, { name: 'Pwned' }],
    ['DELETE', () => `${ws()}/projects/${target.projectId}`],
    ['GET', () => `${ws()}/projects/${target.projectId}/tasks`],
    ['POST', () => `${ws()}/projects/${target.projectId}/tasks`, { title: 'Injected' }],
    ['GET', () => `${ws()}/tasks/${target.taskId}`],
    ['PATCH', () => `${ws()}/tasks/${target.taskId}`, { title: 'Pwned' }],
    ['DELETE', () => `${ws()}/tasks/${target.taskId}`],
  ];

  it.each(requests)('%s %s → 404', async (method, url, body) => {
    expectHidden(await api.as(attacker).request(method, url(), body));
  });

  it('is not listed among the attacker’s workspaces', async () => {
    const list = await api.as(attacker).get('/v1/workspaces?limit=100');
    const ids = list.json<{ data: { id: string }[] }>().data.map((workspace) => workspace.id);
    expect(ids).toEqual([own]);
  });
});

describe('another tenant’s ids under the attacker’s own workspace', () => {
  const mine = () => `/v1/workspaces/${own}`;

  const requests: Request[] = [
    ['GET', () => `${mine()}/projects/${target.projectId}`],
    ['PATCH', () => `${mine()}/projects/${target.projectId}`, { name: 'Pwned' }],
    ['DELETE', () => `${mine()}/projects/${target.projectId}`],
    ['GET', () => `${mine()}/projects/${target.projectId}/tasks`],
    ['POST', () => `${mine()}/projects/${target.projectId}/tasks`, { title: 'Injected' }],
    ['GET', () => `${mine()}/tasks/${target.taskId}`],
    ['PATCH', () => `${mine()}/tasks/${target.taskId}`, { title: 'Pwned' }],
    ['DELETE', () => `${mine()}/tasks/${target.taskId}`],
    ['GET', () => `${mine()}/members/${victimMember.id}`],
    ['PATCH', () => `${mine()}/members/${victimMember.id}`, { role: 'viewer' }],
    ['DELETE', () => `${mine()}/members/${victimMember.id}`],
  ];

  it.each(requests)('%s %s → 404', async (method, url, body) => {
    expectHidden(await api.as(attacker).request(method, url(), body));
  });

  it('cannot assign a task to a member of another workspace', async () => {
    const projectId = await api.createProject(attacker, own);

    const response = await api
      .as(attacker)
      .post(`${mine()}/projects/${projectId}/tasks`, { title: 'X', assigneeId: victimMember.id });

    expect(response.statusCode).toBe(400);
  });
});

it('leaves the victim’s data untouched', async () => {
  const ws = `/v1/workspaces/${target.workspaceId}`;
  const task = await api.as(victim).get(`${ws}/tasks/${target.taskId}`);
  const project = await api.as(victim).get(`${ws}/projects/${target.projectId}`);
  const members = await api.as(victim).get(`${ws}/members`);
  const workspace = await api.as(victim).get(ws);

  expect(task.json()).toMatchObject({ title: 'Secret plan', assigneeId: victimMember.id });
  expect(project.json()).toMatchObject({ name: 'Project', archivedAt: null });
  expect(members.json<{ data: unknown[] }>().data).toHaveLength(2);
  expect(workspace.json()).toMatchObject({ name: 'Victim workspace' });
});
