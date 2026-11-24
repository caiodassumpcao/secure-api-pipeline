import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { examplesFor, prepareForScan } from '../../scripts/dast-openapi.ts';
import type { SeedIds } from '../../scripts/seed.ts';
import { buildTestApp } from '../helpers/test-app.ts';
import { TestApi, type TestUser } from '../integration/helpers/api.ts';

/**
 * NUL (U+0000) in any text input is a 400 validation problem (RFC 9457), never
 * a value PostgreSQL rejects mid-query with a 500. Every string parameter and
 * string body property of the OpenAPI document is tried, in a request that is
 * valid otherwise (built from the DAST scan's own examples), so a field added
 * without the shared text schema fails here.
 */

type Scalar = null | boolean | number | string;
type Json = Scalar | Json[] | { [key: string]: Json };

interface Schema {
  type?: string;
  enum?: Json[];
  default?: Json;
  example?: Json;
  properties?: Record<string, Schema>;
  $ref?: string;
}

interface Parameter {
  in: string;
  name: string;
  schema?: Schema;
  example?: Json;
}

interface Operation {
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

type Location = 'params' | 'querystring' | 'body';

interface Field {
  method: Method;
  path: string;
  location: Location;
  name: string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const METHODS = ['get', 'post', 'patch', 'delete'];
const NUL = '\u0000';

async function servedDocument(): Promise<unknown> {
  const { app } = await buildTestApp({ docs: true });
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });
  await app.close();
  return response.json();
}

function resolve(document: OpenApiDocument, schema: Schema | undefined): Schema | undefined {
  const name = schema?.$ref?.split('/').at(-1);
  if (name === undefined) return schema;
  return new Map(Object.entries(document.components?.schemas ?? {})).get(name);
}

function operations(document: OpenApiDocument): [string, string, Operation][] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, operation]): [string, string, Operation] => [method, path, operation]),
  );
}

function bodyProperties(document: OpenApiDocument, operation: Operation): Record<string, Schema> {
  const schema = resolve(document, operation.requestBody?.content?.['application/json']?.schema);
  return schema?.properties ?? {};
}

/** Every string field a client sends: path and query parameters, body properties. */
function stringFields(document: OpenApiDocument): Field[] {
  return operations(document).flatMap(([method, path, operation]) => [
    ...(operation.parameters ?? [])
      .filter((parameter) => ['path', 'query'].includes(parameter.in))
      .filter((parameter) => resolve(document, parameter.schema)?.type === 'string')
      .map((parameter): Field => ({
        method: method.toUpperCase() as Method,
        path,
        location: parameter.in === 'path' ? 'params' : 'querystring',
        name: parameter.name,
      })),
    ...Object.entries(bodyProperties(document, operation))
      .filter(([, schema]) => resolve(document, schema)?.type === 'string')
      .map(([name]): Field => ({
        method: method.toUpperCase() as Method,
        path,
        location: 'body',
        name,
      })),
  ]);
}

const scalar = (value: Json | undefined): Scalar | undefined =>
  typeof value === 'object' && value !== null ? undefined : value;

/** The value ZAP would send: an example, a default or the first enum member. */
function valueOf(schema: Schema | undefined, example?: Json): Scalar {
  const value =
    scalar(example) ??
    scalar(schema?.example) ??
    scalar(schema?.default) ??
    scalar(schema?.enum?.[0]);
  if (value !== undefined) return value;
  if (schema?.type === 'integer' || schema?.type === 'number') return 1;
  if (schema?.type === 'boolean') return true;
  return 'Valid text';
}

const withNul = (value: Scalar): string => `${String(value)}${NUL}`;

/** The operation's request, valid unless `nul` names the field that gets a NUL. */
function requestFor(
  document: OpenApiDocument,
  { method, path }: Pick<Field, 'method' | 'path'>,
  nul?: Pick<Field, 'location' | 'name'>,
): { method: string; url: string; payload?: Record<string, Scalar> } {
  const item = new Map(Object.entries(document.paths)).get(path) ?? {};
  const operation = new Map(Object.entries(item)).get(method.toLowerCase()) ?? {};
  const parameters = operation.parameters ?? [];
  const value = (parameter: Parameter, location: Location): Scalar => {
    const base = valueOf(resolve(document, parameter.schema), parameter.example);
    return nul?.location === location && nul.name === parameter.name ? withNul(base) : base;
  };

  const url = path.replaceAll(/\{(\w+)\}/g, (_match, name: string) => {
    const parameter = parameters.find((each) => each.in === 'path' && each.name === name);
    return encodeURIComponent(String(parameter === undefined ? '' : value(parameter, 'params')));
  });
  const query = new URLSearchParams(
    parameters
      .filter((parameter) => parameter.in === 'query')
      .map((parameter): [string, string] => [
        parameter.name,
        String(value(parameter, 'querystring')),
      ]),
  ).toString();

  const properties = Object.entries(bodyProperties(document, operation));
  const payload =
    operation.requestBody === undefined
      ? undefined
      : Object.fromEntries(
          properties.map(([name, schema]) => {
            const base = valueOf(resolve(document, schema));
            return [name, nul?.location === 'body' && nul.name === name ? withNul(base) : base];
          }),
        );

  return { method, url: query === '' ? url : `${url}?${query}`, ...(payload && { payload }) };
}

const served = await servedDocument();
const placeholderIds: SeedIds = {
  wsId: '0190f3b2-7c1e-7d2a-9f00-000000000001',
  projectId: '0190f3b2-7c1e-7d2a-9f00-000000000002',
  taskId: '0190f3b2-7c1e-7d2a-9f00-000000000003',
  userId: '0190f3b2-7c1e-7d2a-9f00-000000000004',
  invitationId: '0190f3b2-7c1e-7d2a-9f00-000000000005',
};
const fields = stringFields(prepareForScan(served, examplesFor(placeholderIds)) as OpenApiDocument);

let api: TestApi;
let owner: TestUser;
let document: OpenApiDocument;

beforeAll(async () => {
  api = await TestApi.start();
  const team = await api.createTeam();
  owner = team.owner;
  const projectId = await api.createProject(owner, team.workspaceId);
  const ids: SeedIds = {
    wsId: team.workspaceId,
    projectId,
    taskId: await api.createTask(owner, team.workspaceId, projectId),
    userId: team.member.id,
    invitationId: (await api.invite(owner, team.workspaceId, 'viewer')).id,
  };
  document = prepareForScan(served, examplesFor(ids)) as OpenApiDocument;
});

afterAll(async () => {
  await api.stop();
});

describe('NUL characters in text input', () => {
  it('covers the string fields of every route that takes text', () => {
    const fieldsOf = (path: string) => fields.filter((field) => field.path === path);

    expect(fields.length).toBeGreaterThan(30);
    expect(fieldsOf('/v1/auth/register').map((field) => field.name)).toEqual([
      'email',
      'password',
      'name',
    ]);
    expect(fieldsOf('/v1/workspaces/{wsId}/projects/{projectId}/tasks')).toContainEqual({
      method: 'POST',
      path: '/v1/workspaces/{wsId}/projects/{projectId}/tasks',
      location: 'body',
      name: 'description',
    });
  });

  it.each(fields.map((field) => ({ ...field, field: `${field.location}.${field.name}` })))(
    '$method $path: $field answers a 400 validation problem',
    async ({ method, path, location, name }) => {
      const client = api.as(owner);
      const send = ({ url, payload }: ReturnType<typeof requestFor>) =>
        client.request(method, url, payload);

      const response = await send(requestFor(document, { method, path }, { location, name }));

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({
        status: 400,
        type: expect.stringMatching(/#validation-error$/),
        errors: expect.arrayContaining([expect.objectContaining({ path: `${location}.${name}` })]),
      });

      // The same request without the NUL passes validation: the 400 is the NUL's.
      if (method !== 'DELETE') {
        const valid = await send(requestFor(document, { method, path }));
        expect(valid.statusCode, valid.body).not.toBe(400);
        expect(valid.statusCode, valid.body).toBeLessThan(500);
      }
    },
  );
});
