import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../helpers/test-app.ts';

interface OpenApiDocument {
  openapi: string;
  info: { version: string };
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: object }>; security?: unknown }>
  >;
  components: { schemas: Record<string, unknown>; securitySchemes?: unknown };
  security?: unknown;
}

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document covering every route', async () => {
    const { app } = await buildTestApp({ docs: true });

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    const result = await new Validator().validate(response.json<Record<string, unknown>>());
    const document = response.json<OpenApiDocument>();
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
      '/v1/auth/login',
      '/v1/auth/refresh',
      '/v1/auth/register',
      '/v1/workspaces',
      '/v1/workspaces/{wsId}',
      '/v1/workspaces/{wsId}/members',
      '/v1/workspaces/{wsId}/members/{userId}',
      '/v1/workspaces/{wsId}/projects',
      '/v1/workspaces/{wsId}/projects/{projectId}',
      '/v1/workspaces/{wsId}/projects/{projectId}/tasks',
      '/v1/workspaces/{wsId}/tasks/{taskId}',
    ]);
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['Workspace', 'Member', 'Project', 'Task']),
    );
    expect(document.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: '__Secure-refresh' },
    });
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/health/live']?.get?.security).toEqual([]);
  });

  it('documents errors as RFC 9457 problem details', async () => {
    const { app } = await buildTestApp({ docs: true });

    const document = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    const notFound = document.paths['/v1/workspaces/{wsId}']?.get?.responses['404'];
    expect(notFound?.content).toHaveProperty(['application/problem+json']);
  });

  it('serves Swagger UI under a strict Content-Security-Policy', async () => {
    const { app } = await buildTestApp({ docs: true });

    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/validator\.swagger\.io|upgrade-insecure-requests/);
  });

  it('does not send the document to the public validator', async () => {
    const { app } = await buildTestApp({ docs: true });

    const initializer = await app.inject({
      method: 'GET',
      url: '/docs/static/swagger-initializer.js',
    });

    expect(initializer.body).toMatch(/"validatorUrl":\s*null/);
  });

  it('is not served when docs are disabled', async () => {
    const { app } = await buildTestApp({ docs: false });

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/openapi.json' }),
      app.inject({ method: 'GET', url: '/docs' }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404]);
  });
});
