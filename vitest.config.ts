import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points are exercised by the compose smoke test in CI.
      exclude: ['src/main.ts', 'src/healthcheck.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});
