import { defineConfig } from 'drizzle-kit';

// Used by `pnpm db:generate` only: generated SQL migrations are reviewed and
// committed, then applied by `dist/migrate.js` (Compose `migrate` service).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
