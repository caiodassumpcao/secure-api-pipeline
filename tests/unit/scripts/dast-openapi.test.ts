import { describe, expect, it } from 'vitest';
import {
  examplesFor,
  prepareForScan,
  TARGET_EMAIL,
  TARGET_PASSWORD,
} from '../../../scripts/dast-openapi.ts';
import { decodeCursor } from '../../../src/lib/pagination.ts';

const ids = {
  wsId: '0190f3b2-7c1e-7d2a-9f00-000000000001',
  projectId: '0190f3b2-7c1e-7d2a-9f00-000000000002',
  taskId: '0190f3b2-7c1e-7d2a-9f00-000000000003',
  userId: '0190f3b2-7c1e-7d2a-9f00-000000000004',
  invitationId: '0190f3b2-7c1e-7d2a-9f00-000000000005',
};
const examples = examplesFor(ids);

describe('examplesFor', () => {
  it('maps path ids, the assignee and a cursor the API decodes', () => {
    expect(examples.get('wsId')).toBe(ids.wsId);
    expect(examples.get('invitationId')).toBe(ids.invitationId);
    expect(examples.get('assigneeId')).toBe(ids.userId);
    expect(decodeCursor(examples.get('cursor') ?? '')).toBe(ids.taskId);
  });

  it('gives values that match the API formats and patterns', () => {
    expect(examples.get('email')).toBe(TARGET_EMAIL);
    expect(examples.get('password')).toBe(TARGET_PASSWORD);
    expect(examples.get('slug')).toMatch(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/);
    expect(examples.get('token')).toMatch(/^[\w-]{43}$/);
    expect(examples.get('dueDate')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('prepareForScan', () => {
  it('replaces a nullable union with its non-null schema, keeping the wrapper keys', () => {
    const document = {
      properties: {
        description: {
          description: 'Free text',
          anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }],
        },
        dueDate: { oneOf: [{ type: 'null' }, { type: 'string', format: 'date' }] },
      },
    };

    expect(prepareForScan(document, examples)).toEqual({
      properties: {
        description: { description: 'Free text', type: 'string', maxLength: 5000 },
        dueDate: { type: 'string', format: 'date', example: '2030-01-31' },
      },
    });
  });

  it('keeps unions that are not just nullable', () => {
    const union = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    const withNull = { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] };

    expect(prepareForScan({ union, withNull }, examples)).toEqual({ union, withNull });
  });

  it('adds examples to properties and parameters by name', () => {
    const document = {
      paths: {
        '/v1/workspaces/{wsId}/members': {
          get: {
            parameters: [
              { in: 'path', name: 'wsId', required: true, schema: { type: 'string' } },
              { in: 'query', name: 'cursor', schema: { type: 'string', maxLength: 256 } },
              { in: 'query', name: 'other', schema: { type: 'string' } },
            ],
          },
        },
      },
      components: {
        schemas: {
          Login: {
            type: 'object',
            properties: { email: { type: 'string' }, password: { type: 'string' } },
          },
        },
      },
    };

    expect(prepareForScan(document, examples)).toMatchObject({
      paths: {
        '/v1/workspaces/{wsId}/members': {
          get: {
            parameters: [
              { name: 'wsId', example: ids.wsId },
              { name: 'cursor', example: examples.get('cursor') },
              { name: 'other', schema: { type: 'string' } },
            ],
          },
        },
      },
      components: {
        schemas: {
          Login: {
            properties: {
              email: { example: TARGET_EMAIL },
              password: { example: TARGET_PASSWORD },
            },
          },
        },
      },
    });
    const other = document.paths['/v1/workspaces/{wsId}/members'].get.parameters[2];
    expect(JSON.stringify(prepareForScan(document, examples))).toContain(JSON.stringify(other));
  });

  it('leaves values ZAP already takes from a default or an enum', () => {
    const document = {
      parameters: [{ in: 'query', name: 'cursor', schema: { type: 'string', default: 'x' } }],
      properties: { token: { type: 'string', enum: ['a', 'b'] } },
    };

    expect(prepareForScan(document, examples)).toEqual(document);
  });

  it('does not change the input and treats prototype-like names as plain keys', () => {
    const document: unknown = JSON.parse(
      '{"properties":{"constructor":{"type":"string"},"__proto__":{"type":"string"}}}',
    );
    const before = JSON.stringify(document);

    const prepared = prepareForScan(document, examples);

    expect(JSON.stringify(document)).toBe(before);
    expect(JSON.stringify(prepared)).toBe(before);
    expect(Object.getPrototypeOf(prepared)).toBe(Object.prototype);
  });
});
