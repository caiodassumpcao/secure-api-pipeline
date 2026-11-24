/**
 * Prepares the API's OpenAPI document for the ZAP API scan (dast.yml,
 * ADR-0007):
 *
 *   node scripts/dast-openapi.ts <openapi.json> <ids.json> <out.json>
 *
 * ZAP builds one request per operation from the document, then attacks each
 * value in it. When the API rejects that base request in validation, every
 * attack on it stops at the same 400 and never reaches a handler or the
 * database. Two things in the document lead ZAP to invalid requests:
 *
 * - nullable unions (`anyOf: [S, { type: 'null' }]`): ZAP writes the value of
 *   an untyped union without quotes, which is not JSON. They become `S`;
 * - values ZAP cannot guess: seeded ids, formats, patterns and opaque cursors.
 *   ZAP sends a schema's or parameter's `example`, so those get one.
 *
 * The API serves its document unchanged; only the scanner's copy is edited.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { SeedIds } from './seed.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = Record<string, Json>;

/** An account the scan may register, log in to and fail to log in to. */
export const TARGET_EMAIL = 'dast-target@example.test';
export const TARGET_PASSWORD = 'synthetic passphrase for the dast target';

/**
 * A page cursor as the API encodes it (src/lib/pagination.ts). Not imported:
 * the DAST job runs this script without installing the API's dependencies.
 */
const cursorAfter = (key: string): string =>
  Buffer.from(JSON.stringify({ k: key })).toString('base64url');

/** A well-formed invitation token (43 base64url characters) that matches none. */
const UNKNOWN_INVITATION_TOKEN = 'dast-unknown-invitation-token-0000000000000';

/** Valid values by parameter or property name. */
export function examplesFor(ids: SeedIds): Map<string, string> {
  return new Map([
    ['wsId', ids.wsId],
    ['projectId', ids.projectId],
    ['taskId', ids.taskId],
    ['userId', ids.userId],
    ['invitationId', ids.invitationId],
    ['assigneeId', ids.userId],
    ['cursor', cursorAfter(ids.taskId)],
    ['dueDate', '2030-01-31'],
    ['email', TARGET_EMAIL],
    ['password', TARGET_PASSWORD],
    ['slug', 'dast-scan'],
    ['token', UNKNOWN_INVITATION_TOKEN],
  ]);
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `anyOf`/`oneOf` of one schema and `{ type: 'null' }`: that schema. */
function nonNullBranch(schema: JsonObject): JsonObject | undefined {
  const union = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(union) || union.length !== 2) return undefined;
  const others = union.filter((branch) => !(isObject(branch) && branch.type === 'null'));
  const [branch] = others;
  return others.length === 1 && isObject(branch) ? branch : undefined;
}

/** True when ZAP would use the schema's own default or first enum value. */
const hasOwnValue = (schema: Json | undefined): boolean =>
  isObject(schema) && (schema.default !== undefined || Array.isArray(schema.enum));

function withExample(schema: Json, example: string | undefined): Json {
  return example === undefined || hasOwnValue(schema) || !isObject(schema)
    ? schema
    : { ...schema, example };
}

// Object.fromEntries defines keys such as `__proto__` as plain properties.
const mapValues = (object: JsonObject, map: (value: Json, key: string) => Json): JsonObject =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, map(value, key)]));

function transform(value: Json, examples: Map<string, string>): Json {
  if (Array.isArray(value)) return value.map((item) => transform(item, examples));
  if (!isObject(value)) return value;

  const branch = nonNullBranch(value);
  if (branch !== undefined) {
    const rest = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'anyOf' && key !== 'oneOf'),
    );
    return transform({ ...rest, ...branch }, examples);
  }

  const result = mapValues(value, (child) => transform(child, examples));
  if (isObject(result.properties)) {
    result.properties = mapValues(result.properties, (schema, name) =>
      withExample(schema, examples.get(name)),
    );
  }
  // A parameter: `in` and `name`, with the value's schema under `schema`.
  if (typeof result.in === 'string' && typeof result.name === 'string') {
    const example = examples.get(result.name);
    if (example !== undefined && !hasOwnValue(result.schema)) result.example = example;
  }
  return result;
}

/** The scanner's copy of a parsed document: no nullable unions, valid examples. */
export function prepareForScan(document: unknown, examples: Map<string, string>): unknown {
  // The document comes from JSON.parse: it holds JSON values only.
  return transform(document as Json, examples);
}

function main(argv: string[]): void {
  const [input, idsFile, output] = argv;
  if (input === undefined || idsFile === undefined || output === undefined) {
    throw new Error('usage: dast-openapi.ts <openapi.json> <ids.json> <out.json>');
  }
  // Paths come from the workflow's command line.
  /* eslint-disable security/detect-non-literal-fs-filename */
  const document: unknown = JSON.parse(readFileSync(input, 'utf8'));
  const ids = JSON.parse(readFileSync(idsFile, 'utf8')) as SeedIds;
  writeFileSync(output, `${JSON.stringify(prepareForScan(document, examplesFor(ids)), null, 2)}\n`);
  /* eslint-enable security/detect-non-literal-fs-filename */
}

if (import.meta.main) main(process.argv.slice(2));
