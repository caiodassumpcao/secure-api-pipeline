import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../../src/db/schema.ts';
import { can, PERMISSIONS, type Action } from '../../src/modules/auth/permissions.ts';
import { TestApi, type Team, type TestUser } from '../integration/helpers/api.ts';

/**
 * DESIGN §2.1 over HTTP: every action × every role, each on fresh data, against
 * the permission table the services use. A change to either fails here.
 */

let api: TestApi;

beforeAll(async () => {
  api = await TestApi.start();
});

afterAll(async () => {
  await api.stop();
});

interface Fixture extends Team {
  /** A second owner, target of the owner-management actions. */
  readonly coOwner: TestUser;
  /** A plain member, target of the member-management actions. */
  readonly extra: TestUser;
  readonly outsider: TestUser;
  readonly projectId: string;
  /** Created by `extra`. */
  readonly taskId: string;
  /** Pending invitations, created by the owner. */
  readonly memberInvitationId: string;
  readonly ownerInvitationId: string;
}

async function fixture(): Promise<Fixture> {
  const team = await api.createTeam();
  const [coOwner, extra, outsider] = await Promise.all([
    api.createUser('Co-owner'),
    api.createUser('Extra'),
    api.createUser('Outsider'),
  ]);
  await api.addMember(team.owner, team.workspaceId, coOwner, 'owner');
  await api.addMember(team.owner, team.workspaceId, extra, 'member');
  const projectId = await api.createProject(team.owner, team.workspaceId);
  const taskId = await api.createTask(extra, team.workspaceId, projectId);
  const { id: memberInvitationId } = await api.invite(team.owner, team.workspaceId, 'member');
  const { id: ownerInvitationId } = await api.invite(team.owner, team.workspaceId, 'owner');
  return {
    ...team,
    coOwner,
    extra,
    outsider,
    projectId,
    taskId,
    memberInvitationId,
    ownerInvitationId,
  };
}

interface Case {
  readonly name: string;
  /** The permission the endpoint enforces; the expected outcome derives from PERMISSIONS. */
  readonly action: Action;
  readonly success: number;
  readonly run: (f: Fixture, actor: TestUser) => Promise<LightMyRequestResponse>;
}

const ws = (f: Fixture) => `/v1/workspaces/${f.workspaceId}`;
const as = (actor: TestUser) => api.as(actor);

const CASES: Case[] = [
  {
    name: 'read workspace',
    action: 'workspace:read',
    success: 200,
    run: (f, a) => as(a).get(ws(f)),
  },
  {
    name: 'update workspace',
    action: 'workspace:update',
    success: 200,
    run: (f, a) => as(a).patch(ws(f), { name: 'Renamed' }),
  },
  {
    name: 'delete workspace',
    action: 'workspace:delete',
    success: 204,
    run: (f, a) => as(a).delete(ws(f)),
  },
  {
    name: 'list members',
    action: 'member:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/members`),
  },
  {
    name: 'read a member',
    action: 'member:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/members/${f.extra.id}`),
  },
  {
    name: 'invite a member',
    action: 'member:manage',
    success: 201,
    run: async (f, a) =>
      as(a).post(`${ws(f)}/invitations`, { email: f.outsider.email, role: 'member' }),
  },
  {
    name: 'list pending invitations',
    action: 'member:manage',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/invitations`),
  },
  {
    name: 'revoke an invitation',
    action: 'member:manage',
    success: 204,
    run: (f, a) => as(a).delete(`${ws(f)}/invitations/${f.memberInvitationId}`),
  },
  {
    name: 'revoke an owner invitation',
    action: 'member:manage-owners',
    success: 204,
    run: (f, a) => as(a).delete(`${ws(f)}/invitations/${f.ownerInvitationId}`),
  },
  {
    name: 'change a member’s role',
    action: 'member:manage',
    success: 200,
    run: (f, a) => as(a).patch(`${ws(f)}/members/${f.extra.id}`, { role: 'viewer' }),
  },
  {
    name: 'remove a member',
    action: 'member:manage',
    success: 204,
    run: (f, a) => as(a).delete(`${ws(f)}/members/${f.extra.id}`),
  },
  {
    name: 'invite an owner (transfer ownership)',
    action: 'member:manage-owners',
    success: 201,
    run: (f, a) => as(a).post(`${ws(f)}/invitations`, { email: f.outsider.email, role: 'owner' }),
  },
  {
    name: 'change an owner’s role',
    action: 'member:manage-owners',
    success: 200,
    run: (f, a) => as(a).patch(`${ws(f)}/members/${f.coOwner.id}`, { role: 'admin' }),
  },
  {
    name: 'remove an owner',
    action: 'member:manage-owners',
    success: 204,
    run: (f, a) => as(a).delete(`${ws(f)}/members/${f.coOwner.id}`),
  },
  {
    name: 'list projects',
    action: 'project:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/projects`),
  },
  {
    name: 'read a project',
    action: 'project:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/projects/${f.projectId}`),
  },
  {
    name: 'create a project',
    action: 'project:write',
    success: 201,
    run: (f, a) => as(a).post(`${ws(f)}/projects`, { name: 'New' }),
  },
  {
    name: 'rename a project',
    action: 'project:write',
    success: 200,
    run: (f, a) => as(a).patch(`${ws(f)}/projects/${f.projectId}`, { name: 'New name' }),
  },
  {
    name: 'archive a project',
    action: 'project:write',
    success: 204,
    run: (f, a) => as(a).delete(`${ws(f)}/projects/${f.projectId}`),
  },
  {
    name: 'list tasks',
    action: 'task:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/projects/${f.projectId}/tasks`),
  },
  {
    name: 'read a task',
    action: 'task:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/tasks/${f.taskId}`),
  },
  {
    name: 'create a task',
    action: 'task:write',
    success: 201,
    run: (f, a) => as(a).post(`${ws(f)}/projects/${f.projectId}/tasks`, { title: 'New' }),
  },
  {
    name: 'update a task',
    action: 'task:write',
    success: 200,
    run: (f, a) => as(a).patch(`${ws(f)}/tasks/${f.taskId}`, { status: 'done' }),
  },
  {
    name: 'delete someone else’s task',
    action: 'task:delete-any',
    success: 204,
    run: (f, a) => as(a).delete(`${ws(f)}/tasks/${f.taskId}`),
  },
  {
    name: 'read the audit log',
    action: 'audit:read',
    success: 200,
    run: (f, a) => as(a).get(`${ws(f)}/audit-events`),
  },
];

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const satisfies readonly Role[];

function actorFor(f: Fixture, role: Role): TestUser {
  switch (role) {
    case 'owner':
      return f.owner;
    case 'admin':
      return f.admin;
    case 'member':
      return f.member;
    case 'viewer':
      return f.viewer;
  }
}

describe('authorization matrix', () => {
  const cells = CASES.flatMap((testCase) => ROLES.map((role) => ({ ...testCase, role })));

  it.each(cells)('$role: $name', async ({ role, action, success, run }) => {
    const f = await fixture();
    const allowed = can(role, action);

    const response = await run(f, actorFor(f, role));

    expect(response.statusCode, response.body).toBe(allowed ? success : 403);
  });

  // Members delete their own tasks (task:delete-own); viewers cannot create any.
  it.each(['owner', 'admin', 'member'] as const)('%s: delete a task they created', async (role) => {
    const f = await fixture();
    const actor = actorFor(f, role);
    const taskId = await api.createTask(actor, f.workspaceId, f.projectId);

    const response = await as(actor).delete(`${ws(f)}/tasks/${taskId}`);

    expect(response.statusCode).toBe(204);
  });

  it('covers every permission of the table', () => {
    const tested = new Set<Action>([
      ...CASES.map((testCase) => testCase.action),
      'task:delete-own',
    ]);
    expect(new Set(Object.keys(PERMISSIONS))).toEqual(tested);
  });
});
