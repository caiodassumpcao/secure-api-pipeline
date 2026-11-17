import { readFileSync } from 'node:fs';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** `package.json` at the repository root: two levels up from both `src/plugins` and `dist/plugins`. */
const packageJson = new URL('../../package.json', import.meta.url);
// Fixed path inside the build output, not user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const packageJsonText = readFileSync(packageJson, 'utf8');
const { version } = z.object({ version: z.string() }).parse(JSON.parse(packageJsonText));

const DESCRIPTION = `Multi-tenant project and task tracker.

Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details (\`application/problem+json\`).
Lists use cursor pagination: \`?limit=\` (1–100) and the opaque \`nextCursor\` of the previous page.

Until v0.2 delivers authentication, \`/v1\` routes answer 401 outside the test environment.`;

/**
 * OpenAPI 3.1 document generated from the route zod schemas, served at
 * `/openapi.json` with Swagger UI at `/docs`. Must be registered before routes.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'secure-api-pipeline', version, description: DESCRIPTION },
      tags: [
        { name: 'workspaces', description: 'Tenants' },
        { name: 'members', description: 'Workspace memberships and roles' },
        { name: 'projects' },
        { name: 'tasks' },
        { name: 'health', description: 'Probes for orchestrators and deploys' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    // Never send the document to the public validator service.
    uiConfig: { validatorUrl: null },
    // Strict CSP on the UI and its assets (DESIGN §5.1): no framing, no third-party
    // validator badge. upgrade-insecure-requests is dropped so the UI also loads
    // over plain HTTP on localhost; deployments sit behind TLS with HSTS.
    staticCSP: true,
    transformStaticCSP: (header) =>
      header
        .replace("frame-ancestors 'self'", "frame-ancestors 'none'")
        .replace(' validator.swagger.io', '')
        .replace(/\s*upgrade-insecure-requests;?/, ''),
  });

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
}
