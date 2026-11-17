import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type App } from '../../../src/app.ts';
import type { Role } from '../../../src/db/schema.ts';
import { users } from '../../../src/db/schema.ts';
import { uuidv7 } from '../../../src/lib/ids.ts';
import { createLogger } from '../../../src/lib/logger.ts';
import { createPasswordHasher, type PasswordHasher } from '../../../src/modules/auth/password.ts';
import type { TokenService } from '../../../src/modules/auth/tokens.ts';
import { createTestTokenService } from '../../helpers/keys.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiClient {
  request(method: Method, url: string, payload?: object): Promise<LightMyRequestResponse>;
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: object): Promise<LightMyRequestResponse>;
  patch(url: string, payload: object): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
}

export interface Team {
  readonly workspaceId: string;
  readonly owner: TestUser;
  readonly admin: TestUser;
  readonly member: TestUser;
  readonly viewer: TestUser;
}

/**
 * Real app + real PostgreSQL database (one per test file). Callers authenticate
 * with real access tokens, issued directly by the token service: logging in
 * would run argon2 for each of the hundreds of users the suites create.
 */
export class TestApi {
  readonly app: App;
  readonly testDatabase: TestDatabase;
  readonly tokens: TokenService;
  private sequence = 0;
  private readonly accessTokens = new Map<string, Promise<string>>();

  private constructor(app: App, testDatabase: TestDatabase, tokens: TokenService) {
    this.app = app;
    this.testDatabase = testDatabase;
    this.tokens = tokens;
  }

  static async start(options: { passwords?: PasswordHasher } = {}): Promise<TestApi> {
    const testDatabase = await createTestDatabase();
    const tokens = await createTestTokenService();
    const app = await buildApp({
      logger: createLogger({ level: 'silent' }),
      database: testDatabase.database,
      auth: { tokens, passwords: options.passwords ?? createPasswordHasher() },
      docs: { enabled: false },
      http: { corsOrigins: [], trustProxy: false },
    });
    await app.ready();
    return new TestApi(app, testDatabase, tokens);
  }

  async stop(): Promise<void> {
    await this.app.close();
    await this.testDatabase.drop();
  }

  get db() {
    return this.testDatabase.database.db;
  }

  /** Inserted directly: tests authenticate with issued tokens, not with the password. */
  async createUser(name = 'Test User'): Promise<TestUser> {
    const user = { id: uuidv7(), email: `user-${uuidv7()}@example.test`, name };
    await this.db.insert(users).values({ ...user, passwordHash: 'not-a-real-hash' });
    return user;
  }

  /** A valid access token for the user, issued once per test file. */
  accessToken(user: TestUser): Promise<string> {
    const issued = this.accessTokens.get(user.id);
    if (issued !== undefined) return issued;
    const pending = this.tokens.issueAccessToken(user.id).then(({ accessToken }) => accessToken);
    this.accessTokens.set(user.id, pending);
    return pending;
  }

  as(user: TestUser | null): ApiClient {
    const request = async (method: Method, url: string, payload?: object) =>
      this.app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
        headers: user === null ? {} : { authorization: `Bearer ${await this.accessToken(user)}` },
      });
    return {
      request,
      get: (url) => request('GET', url),
      post: (url, payload) => request('POST', url, payload ?? {}),
      patch: (url, payload) => request('PATCH', url, payload),
      delete: (url) => request('DELETE', url),
    };
  }

  uniqueSlug(prefix = 'ws'): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}-${uuidv7().slice(-6)}`;
  }

  async createWorkspace(owner: TestUser, name = 'Workspace'): Promise<string> {
    const response = await this.as(owner).post('/v1/workspaces', { name, slug: this.uniqueSlug() });
    expectStatus(response, 201);
    return response.json<{ id: string }>().id;
  }

  async addMember(actor: TestUser, workspaceId: string, user: TestUser, role: Role): Promise<void> {
    const response = await this.as(actor).post(`/v1/workspaces/${workspaceId}/members`, {
      email: user.email,
      role,
    });
    expectStatus(response, 201);
  }

  /** A workspace with one user per role. */
  async createTeam(): Promise<Team> {
    const [owner, admin, member, viewer] = await Promise.all([
      this.createUser('Owner'),
      this.createUser('Admin'),
      this.createUser('Member'),
      this.createUser('Viewer'),
    ]);
    const workspaceId = await this.createWorkspace(owner);
    await this.addMember(owner, workspaceId, admin, 'admin');
    await this.addMember(owner, workspaceId, member, 'member');
    await this.addMember(owner, workspaceId, viewer, 'viewer');
    return { workspaceId, owner, admin, member, viewer };
  }

  async createProject(actor: TestUser, workspaceId: string, name = 'Project'): Promise<string> {
    const response = await this.as(actor).post(`/v1/workspaces/${workspaceId}/projects`, { name });
    expectStatus(response, 201);
    return response.json<{ id: string }>().id;
  }

  async createTask(
    actor: TestUser,
    workspaceId: string,
    projectId: string,
    fields: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await this.as(actor).post(
      `/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`,
      { title: 'Task', ...fields },
    );
    expectStatus(response, 201);
    return response.json<{ id: string }>().id;
  }
}

/** Fails with the response body, which explains unexpected statuses. */
export function expectStatus(response: LightMyRequestResponse, status: number): void {
  if (response.statusCode !== status) {
    throw new Error(`Expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
}
