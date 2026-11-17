import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePems } from '../../helpers/keys.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

/** Writes a throwaway signing key pair and returns the variables pointing to it. */
function keyFiles(): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'api-keys-'));
  const pems = generatePems();
  const privateKeyFile = join(directory, 'private.pem');
  const publicKeyFile = join(directory, 'public.pem');
  writeFileSync(privateKeyFile, pems.privateKey, { mode: 0o600 });
  writeFileSync(publicKeyFile, pems.publicKey);
  return { JWT_PRIVATE_KEY_FILE: privateKeyFile, JWT_PUBLIC_KEY_FILE: publicKeyFile };
}

export interface ApiProcess {
  readonly baseUrl: string;
  /** Every line the process wrote to stdout and stderr. */
  readonly output: string[];
  readonly child: ChildProcess;
  /** Graceful stop (SIGTERM); resolves with the exit code. */
  stop(): Promise<number | null>;
}

/**
 * Runs the API the way production does: `node --import <telemetry preload>
 * src/main.ts`, with its own port and a throwaway key pair. Resolves once it
 * listens; rejects if it exits first.
 */
export async function startApiProcess(env: Record<string, string>): Promise<ApiProcess> {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(
    process.execPath,
    ['--import', './src/telemetry/instrument.ts', 'src/main.ts'],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        HOST: '127.0.0.1',
        PORT: String(port),
        ...keyFiles(),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      output.push(...lines.filter((line) => line.length > 0));
    });
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`API did not start:\n${output.join('\n')}`));
    }, 20_000);
    const check = setInterval(() => {
      if (output.some((line) => line.includes('Server listening'))) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 50);
    void exited.then((code) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error(`API exited with ${code}:\n${output.join('\n')}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    output,
    child,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      return exited;
    },
  };
}

/** Runs the API process until it exits by itself (e.g. invalid configuration). */
export async function runApiProcessToExit(
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    ['--import', './src/telemetry/instrument.ts', 'src/main.ts'],
    { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, output };
}
