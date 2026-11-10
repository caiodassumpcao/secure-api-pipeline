import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BODY_LIMIT_BYTES } from '../../../src/app.ts';
import {
  HttpProblem,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BASE_URI,
  ProblemTypes,
} from '../../../src/lib/problem.ts';
import { buildTestApp } from '../../helpers/test-app.ts';

async function setup() {
  const { app, logs } = await buildTestApp();

  app.post(
    '/things',
    {
      schema: {
        body: z.object({ title: z.string().min(1), tags: z.array(z.string()).optional() }).strict(),
        querystring: z.object({ dryRun: z.enum(['true', 'false']).optional() }).strict(),
        response: { 201: z.object({ title: z.string() }) },
      },
    },
    async (request, reply) => reply.code(201).send({ title: request.body.title }),
  );
  app.get('/things/:id', (request) => request.params);
  app.get('/problem', () => {
    throw new HttpProblem(ProblemTypes.validation, 'Title is taken', [
      { path: 'body.title', message: 'Already exists' },
    ]);
  });
  app.get('/crash', () => {
    throw new Error('connection to db-primary.internal:5432 failed: SELECT * FROM users');
  });
  app.get('/throws-string', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the fallback
    throw 'plain string';
  });
  app.get('/third-party-4xx', () => {
    throw Object.assign(new Error('upstream said: internal-host-42 refused'), { statusCode: 409 });
  });
  app.get('/framework-4xx', () => {
    throw Object.assign(new Error('Method not supported here'), {
      code: 'FST_ERR_TEST',
      statusCode: 405,
    });
  });
  app.get('/odd-status', () => {
    throw Object.assign(new Error('moved'), { statusCode: 302 });
  });
  app.get('/bad-response', { schema: { response: { 200: z.object({ id: z.uuid() }) } } }, () => ({
    id: 'not-a-uuid',
  }));

  return { app, logs };
}

describe('error handler', () => {
  it('returns validation errors as RFC 9457 problems with field paths', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'POST', url: '/things', payload: { title: '' } });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: `${PROBLEM_TYPE_BASE_URI}validation-error`,
      title: 'Validation Failed',
      status: 400,
      detail: 'The request does not match the expected schema.',
      instance: '/things',
      traceId: response.headers['x-request-id'],
      errors: [{ path: 'body.title', message: expect.any(String) }],
    });
  });

  it('validates the query string', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/things?dryRun=maybe',
      payload: { title: 'ok' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown }>().errors).toEqual([
      { path: 'querystring.dryRun', message: expect.any(String) },
    ]);
  });

  it('reports nested body fields and unknown keys', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/things',
      payload: { title: 'ok', tags: ['a', 1], role: 'admin' },
    });

    expect(response.statusCode).toBe(400);
    const { errors } = response.json<{ errors: { path: string }[] }>();
    expect(errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['body.tags.1', 'body']),
    );
  });

  it('maps malformed JSON to a bad-request problem', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_BASE_URI}bad-request`,
      title: 'Bad Request',
    });
  });

  it('rejects bodies over the limit with 413', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/things',
      payload: { title: 'x'.repeat(BODY_LIMIT_BYTES) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ type: `${PROBLEM_TYPE_BASE_URI}payload-too-large` });
  });

  it('rejects unsupported media types with 415', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { 'content-type': 'application/xml' },
      payload: '<title>x</title>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_BASE_URI}unsupported-media-type`,
    });
  });

  it('rejects text/plain bodies with 415: the API accepts JSON only', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      payload: '{"title":"x"}',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_BASE_URI}unsupported-media-type`,
    });
  });

  it('renders malformed URLs as problems without echoing or logging the query string', async () => {
    const { app, logs } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/nope/%zz?token=leaked-token',
      headers: { 'x-request-id': 'bad-url-1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.headers['x-request-id']).toBe('bad-url-1');
    expect(response.json()).toEqual({
      type: `${PROBLEM_TYPE_BASE_URI}bad-request`,
      title: 'Bad Request',
      status: 400,
      detail: 'The request URL is malformed.',
      instance: '/nope/%zz',
      traceId: 'bad-url-1',
    });
    expect(response.body).not.toContain('leaked-token');
    expect(logs.entries.find((entry) => entry.msg === 'request rejected')).toMatchObject({
      level: 'info',
      code: 'FST_ERR_BAD_URL',
      request_id: 'bad-url-1',
    });
    expect(logs.text).not.toContain('leaked-token');
  });

  it('renders over-long path parameters as 414 problems', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: `/things/${'a'.repeat(101)}` });

    expect(response.statusCode).toBe(414);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.json()).toMatchObject({
      type: 'about:blank',
      title: 'URI Too Long',
      detail: 'A path parameter is too long.',
    });
  });

  it('renders an HttpProblem thrown by application code', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/problem' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_BASE_URI}validation-error`,
      detail: 'Title is taken',
      errors: [{ path: 'body.title', message: 'Already exists' }],
    });
  });

  it('hides internal details of unexpected errors but logs them', async () => {
    const { app, logs } = await setup();

    const response = await app.inject({ method: 'GET', url: '/crash' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: `${PROBLEM_TYPE_BASE_URI}internal-error`,
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/crash',
      traceId: response.headers['x-request-id'],
    });
    expect(response.body).not.toMatch(/db-primary|SELECT|at .*\.ts/);

    const logged = logs.entries.find((entry) => entry.msg === 'request failed');
    expect(logged).toMatchObject({
      level: 'error',
      err: { message: expect.stringContaining('db-primary') },
    });
  });

  it('treats non-Error throws as internal errors', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/throws-string' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('plain string');
  });

  it('keeps the status of third-party client errors but not their message', async () => {
    const { app, logs } = await setup();

    const response = await app.inject({ method: 'GET', url: '/third-party-4xx' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      instance: '/third-party-4xx',
      traceId: expect.any(String),
    });
    expect(logs.entries.find((entry) => entry.msg === 'request rejected')?.level).toBe('info');
  });

  it('uses about:blank with the message for other framework client errors', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/framework-4xx' });

    expect(response.statusCode).toBe(405);
    expect(response.json()).toMatchObject({
      type: 'about:blank',
      title: 'Method Not Allowed',
      detail: 'Method not supported here',
    });
  });

  it('treats non-error statuses on errors as internal errors', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/odd-status' });

    expect(response.statusCode).toBe(500);
  });

  it('fails closed when a response does not match its schema', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/bad-response' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ type: `${PROBLEM_TYPE_BASE_URI}internal-error` });
    expect(response.body).not.toContain('not-a-uuid');
  });

  it('strips unknown fields from responses', async () => {
    const { app } = await buildTestApp();
    app.get('/user', { schema: { response: { 200: z.object({ id: z.string() }) } } }, () => ({
      id: 'u1',
      passwordHash: '$argon2id$secret',
    }));

    const response = await app.inject({ method: 'GET', url: '/user' });

    expect(response.json()).toEqual({ id: 'u1' });
  });

  it('answers unknown routes with a not-found problem without the query string', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/missing?token=abc',
      headers: { 'x-request-id': 'req-404' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: `${PROBLEM_TYPE_BASE_URI}not-found`,
      title: 'Not Found',
      status: 404,
      detail: 'The requested resource does not exist.',
      instance: '/missing',
      traceId: 'req-404',
    });
  });
});
