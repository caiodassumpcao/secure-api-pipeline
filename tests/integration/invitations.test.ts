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

const invitations = () => `/v1/workspaces/${team.workspaceId}/invitations`;
const accept = (user: Parameters<TestApi['as']>[0], token: string) =>
  api.as(user).post('/v1/invitations/accept', { token });

describe('invitations', () => {
  it('create a single-use link without looking any account up', async () => {
    const existing = await api.createUser('Carol');

    const forAccount = await api
      .as(team.admin)
      .post(invitations(), { role: 'member', email: existing.email });
    const forNobody = await api
      .as(team.admin)
      .post(invitations(), { role: 'member', email: 'nobody-at-all@example.test' });

    for (const response of [forAccount, forNobody]) {
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        id: expect.any(String),
        role: 'member',
        email: expect.any(String),
        invitedBy: team.admin.id,
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        token: expect.stringMatching(/^[\w-]{43}$/),
      });
    }
    expect(Object.keys(forAccount.json<object>())).toEqual(Object.keys(forNobody.json<object>()));
  });

  it('are accepted by the invitee, once', async () => {
    const carol = await api.createUser('Carol');
    const { token } = await api.invite(team.owner, team.workspaceId, 'viewer');

    const accepted = await accept(carol, token);

    expectStatus(accepted, 201);
    expect(accepted.json()).toMatchObject({ id: team.workspaceId, role: 'viewer' });
    expect(accepted.headers.location).toBe(`/v1/workspaces/${team.workspaceId}`);
    const dave = await api.createUser('Dave');
    expect((await accept(dave, token)).statusCode).toBe(404);
  });

  it('addressed to an email work only for the account with that email', async () => {
    const carol = await api.createUser('Carol');
    const mallory = await api.createUser('Mallory');
    const { token } = await api.invite(
      team.owner,
      team.workspaceId,
      'member',
      carol.email.toUpperCase(),
    );

    expect((await accept(mallory, token)).statusCode).toBe(404);
    expectStatus(await accept(carol, token), 201);
  });

  it('cannot be accepted once revoked or expired, and not by a member', async () => {
    const carol = await api.createUser('Carol');
    const revoked = await api.invite(team.owner, team.workspaceId, 'member');
    expectStatus(await api.as(team.admin).delete(`${invitations()}/${revoked.id}`), 204);
    const expired = await api.invite(team.owner, team.workspaceId, 'member');
    await api.testDatabase.database.pool.query(
      `UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [expired.id],
    );
    const forMember = await api.invite(team.owner, team.workspaceId, 'admin');

    expect((await accept(carol, revoked.token)).statusCode).toBe(404);
    expect((await accept(carol, expired.token)).statusCode).toBe(404);
    expect((await accept(team.member, forMember.token)).statusCode).toBe(409);
  });

  it('are listed while pending, without their tokens', async () => {
    const { id } = await api.invite(team.owner, team.workspaceId, 'viewer');

    const response = await api.as(team.admin).get(`${invitations()}?limit=100`);

    expectStatus(response, 200);
    const listed = response.json<{ data: { id: string }[] }>().data;
    expect(listed.map((invitation) => invitation.id)).toContain(id);
    expect(response.body).not.toContain('token');
  });

  it('for the owner role are created and revoked by owners only', async () => {
    const { id } = await api.invite(team.owner, team.workspaceId, 'owner');

    const create = await api.as(team.admin).post(invitations(), { role: 'owner' });
    const revoke = await api.as(team.admin).delete(`${invitations()}/${id}`);

    expect([create.statusCode, revoke.statusCode]).toEqual([403, 403]);
  });

  it('replace adding members by email, which no longer exists', async () => {
    const response = await api.as(team.owner).post(`/v1/workspaces/${team.workspaceId}/members`, {
      email: 'a@example.test',
      role: 'member',
    });

    expect(response.statusCode).toBe(404);
  });

  it.each([
    [{ role: 'superuser' }, 'body.role'],
    [{ role: 'member', email: 'not-an-email' }, 'body.email'],
  ])('validate %o', async (payload, path) => {
    const response = await api.as(team.owner).post(invitations(), payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe(path);
  });

  it('reject a malformed token without looking it up', async () => {
    const response = await accept(team.viewer, 'short');

    expect(response.statusCode).toBe(400);
  });
});
