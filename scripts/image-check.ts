/**
 * Checks a built API image (ADR-0007), as `container.yml` does on amd64 and
 * on a native arm64 runner:
 *
 * - its configuration: non-root user, `node` entrypoint, telemetry preload in
 *   CMD only, health check without it, OCI labels;
 * - that it has no shell;
 * - inside the image: the process uid, and that `@node-rs/argon2` loads the
 *   one binary built for glibc and this CPU, then hashes and verifies;
 * - with `--api <url>`, against a stack running the image: register, log in
 *   and call /v1/me, which runs argon2 inside the container for real.
 *
 *   node scripts/image-check.ts <image> --arch amd64|arm64 [--api http://127.0.0.1:3000]
 *
 * Exits 1 with every failed check listed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type Arch = 'amd64' | 'arm64';

export interface ImageConfig {
  Architecture: string;
  Config: {
    User?: string;
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    Healthcheck?: { Test?: string[] } | null;
  };
}

const NON_ROOT = '65532:65532';
const REQUIRED_LABELS = [
  'org.opencontainers.image.source',
  'org.opencontainers.image.revision',
  'org.opencontainers.image.version',
];

const equal = (a: readonly unknown[] | null | undefined, b: readonly unknown[]): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b);

/** Problems in the image configuration, empty when it is as ADR-0007 requires. */
export function configProblems(
  image: ImageConfig,
  arch: Arch,
  options: { labels: boolean },
): string[] {
  const { Config: config } = image;
  const problems: string[] = [];
  if (image.Architecture !== arch) problems.push(`architecture is ${image.Architecture}`);
  if (config.User !== NON_ROOT) problems.push(`user is "${config.User ?? ''}", not ${NON_ROOT}`);
  if (!equal(config.Entrypoint, ['/nodejs/bin/node'])) {
    problems.push(`entrypoint is ${JSON.stringify(config.Entrypoint)}`);
  }
  if (!equal(config.Cmd, ['--import', './dist/telemetry/instrument.js', 'dist/main.js'])) {
    problems.push(`cmd is ${JSON.stringify(config.Cmd)}`);
  }
  if (!equal(config.Healthcheck?.Test, ['CMD', '/nodejs/bin/node', 'dist/healthcheck.js'])) {
    problems.push(`health check is ${JSON.stringify(config.Healthcheck?.Test)}`);
  }
  // NODE_OPTIONS would preload the telemetry into the health check and migrations too.
  if ((config.Env ?? []).some((variable) => variable.startsWith('NODE_OPTIONS='))) {
    problems.push('NODE_OPTIONS is set');
  }
  if (options.labels) {
    const labels = new Map(Object.entries(config.Labels ?? {}));
    for (const label of REQUIRED_LABELS) {
      if (!labels.get(label)) problems.push(`label ${label} is missing`);
    }
  }
  return problems;
}

/** What the probe run inside the image reports. */
export interface Probe {
  uid: number;
  glibc: string | null;
  bindings: string[];
  verified: boolean;
}

/** Problems with the argon2 binding found in the image, for this CPU. */
export function probeProblems(probe: Probe, arch: Arch): string[] {
  const cpu = arch === 'amd64' ? 'x64' : 'arm64';
  const problems: string[] = [];
  if (probe.uid !== 65532) problems.push(`runs as uid ${String(probe.uid)}`);
  if (probe.glibc === null) problems.push('the runtime does not report glibc');
  const expected = `@node-rs+argon2-linux-${cpu}-gnu@`;
  if (probe.bindings.length !== 1 || !probe.bindings[0]?.startsWith(expected)) {
    problems.push(`argon2 bindings are [${probe.bindings.join(', ')}], expected ${expected}*`);
  }
  if (!probe.verified) problems.push('argon2 could not hash and verify a password');
  return problems;
}

// Runs with the image's own Node.js, as uid 65532, without network access.
const PROBE = `
const { readdirSync } = await import('node:fs');
const { hash, verify } = await import('@node-rs/argon2');
const digest = await hash('image check passphrase');
console.log(JSON.stringify({
  uid: process.getuid(),
  glibc: process.report.getReport().header.glibcVersionRuntime ?? null,
  bindings: readdirSync('node_modules/.pnpm').filter((name) => name.startsWith('@node-rs+argon2-linux')),
  verified: await verify(digest, 'image check passphrase'),
}));
`;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function login(apiUrl: string): Promise<void> {
  const email = `image-check-${randomUUID()}@example.test`;
  const password = 'image check passphrase for the stack';
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const registered = await post('/v1/auth/register', { email, password, name: 'Image check' });
  if (registered.status !== 201) throw new Error(`register: ${String(registered.status)}`);
  const loggedIn = await post('/v1/auth/login', { email, password });
  if (loggedIn.status !== 200) throw new Error(`login: ${String(loggedIn.status)}`);
  const { accessToken } = (await loggedIn.json()) as { accessToken: string };
  const me = await fetch(`${apiUrl}/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (me.status !== 200) throw new Error(`/v1/me: ${String(me.status)}`);
}

function parseArgs(argv: string[]): { image: string; arch: Arch; apiUrl?: string } {
  const [image, ...rest] = argv;
  const option = (name: string): string | undefined => rest[rest.indexOf(name) + 1];
  const arch = option('--arch');
  if (image === undefined || (arch !== 'amd64' && arch !== 'arm64')) {
    throw new Error('usage: image-check.ts <image> --arch amd64|arm64 [--api <url>]');
  }
  const apiUrl = rest.includes('--api') ? option('--api') : undefined;
  return apiUrl === undefined ? { image, arch } : { image, arch, apiUrl };
}

async function main(): Promise<void> {
  const { image, arch, apiUrl } = parseArgs(process.argv.slice(2));
  const failures: string[] = [];
  const check = async (what: string, run: () => string[] | Promise<string[]>): Promise<void> => {
    let problems: string[];
    try {
      problems = await run();
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }
    process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${what}\n`);
    for (const problem of problems) process.stdout.write(`      ${problem}\n`);
    failures.push(...problems);
  };

  await check('configuration', () => {
    const [config] = JSON.parse(docker(['image', 'inspect', image])) as ImageConfig[];
    if (config === undefined) throw new Error(`image ${image} not found`);
    return configProblems(config, arch, { labels: true });
  });
  await check('no shell', () => {
    const shell = spawnSync(
      'docker',
      ['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', 'true'],
      {
        encoding: 'utf8',
      },
    );
    return shell.status === 0 ? ['/bin/sh runs inside the image'] : [];
  });
  await check('argon2 for glibc and this CPU, as uid 65532', () => {
    const output = docker([
      'run',
      '--rm',
      '--network',
      'none',
      image,
      '--input-type=module',
      '-e',
      PROBE,
    ]);
    return probeProblems(JSON.parse(output) as Probe, arch);
  });
  if (apiUrl !== undefined) {
    await check('register, log in and /v1/me against the running image', async () => {
      await login(apiUrl);
      return [];
    });
  }

  if (failures.length > 0) process.exit(1);
}

if (import.meta.main) await main();
