/**
 * Container HEALTHCHECK probe (`node dist/healthcheck.js`). Minimal runtime
 * images have no shell or curl, so the check runs on Node itself.
 * Exit code 0 = ready, 1 = not ready.
 */
const port = process.env.PORT ?? '3000';

try {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    signal: AbortSignal.timeout(3_000),
  });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
