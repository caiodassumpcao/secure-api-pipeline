import { readFileSync } from 'node:fs';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrations.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: { readonly adminUrl: string; readonly template: string };
  }
}

/** Database the migrations run on; each test file gets a copy (CREATE DATABASE ... TEMPLATE). */
const TEMPLATE_DATABASE = 'app_template';

/**
 * Same image (and digest) as the Compose stack, read from compose.yaml so that
 * Dependabot updates both at once.
 */
function postgresImage(): string {
  const compose = readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8');
  const image = /^\s*image:\s*(postgres:\S+)\s*$/m.exec(compose)?.[1];
  if (image === undefined) throw new Error('postgres image not found in compose.yaml');
  return image;
}

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer(postgresImage())
    .withDatabase(TEMPLATE_DATABASE)
    .withUsername('app')
    .withPassword('integration-tests')
    .start();

  const templateUrl = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: templateUrl, max: 1 });
  try {
    await runMigrations(pool);
  } finally {
    // A template database cannot be copied while someone is connected to it.
    await pool.end();
  }

  const adminUrl = new URL(templateUrl);
  adminUrl.pathname = '/postgres';
  project.provide('postgres', { adminUrl: adminUrl.toString(), template: TEMPLATE_DATABASE });

  return async () => {
    await container.stop();
  };
}
