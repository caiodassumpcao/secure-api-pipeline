import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Static invariants of the Dockerfile (ADR-0007). `container.yml` checks the
 * built image itself (scripts/image-check.ts); these fail before a build.
 */

interface Stage {
  from: string;
  name: string;
  instructions: string[];
}

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

/** Instructions with their continuation lines joined, comments dropped. */
const instructions = dockerfile
  .replaceAll(/\\\n/g, ' ')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

const stages = instructions.reduce<Stage[]>((all, instruction) => {
  const [first, ...words] = instruction.split(/\s+/);
  if (first?.toUpperCase() === 'FROM') {
    const [from = '', as, name = ''] = words.filter((word) => !word.startsWith('--platform='));
    return [...all, { from, name: as?.toUpperCase() === 'AS' ? name : '', instructions: [] }];
  }
  all.at(-1)?.instructions.push(instruction);
  return all;
}, []);

const runtime = stages.at(-1);
const keyword = (instruction: string): string =>
  instruction.split(/\s+/, 1)[0]?.toUpperCase() ?? '';
const argsOf = (name: string): string | undefined =>
  runtime?.instructions
    .find((instruction) => keyword(instruction) === name)
    ?.slice(name.length)
    .trim();

describe('Dockerfile', () => {
  it.each(stages.filter((stage) => !stages.some((other) => other.name === stage.from)))(
    'pins base image $from by digest',
    ({ from }) => {
      expect(from).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    },
  );

  it('runs the Node.js build stages on the build platform, not under emulation', () => {
    expect(
      instructions.filter((line) => /^FROM\s+--platform=\$BUILDPLATFORM\s/i.test(line)),
    ).toHaveLength(1);
    expect(stages[0]?.from).toMatch(/^node:24\.[\d.]+-alpine@/);
  });

  it('installs production dependencies for glibc and the target CPU', () => {
    const prodDeps = stages.find((stage) => stage.name === 'prod-deps');
    const install = prodDeps?.instructions.find((line) => line.includes('pnpm install'));

    expect(prodDeps?.instructions).toContain('ARG TARGETARCH');
    expect(install).toMatch(/--prod\b/);
    expect(install).toMatch(/--ignore-scripts\b/);
    expect(install).toMatch(/--os linux --cpu "\$cpu" --libc glibc/);
  });

  it('ships a distroless runtime that only copies files', () => {
    expect(runtime?.from).toMatch(/^gcr\.io\/distroless\/nodejs24-debian13:nonroot@sha256:/);
    expect(runtime?.instructions.map(keyword)).not.toContain('RUN');
  });

  it('runs as the non-root user, with the telemetry preload in CMD only', () => {
    expect(argsOf('USER')).toBe('65532:65532');
    expect(JSON.parse(argsOf('ENTRYPOINT') ?? 'null')).toEqual(['/nodejs/bin/node']);
    expect(JSON.parse(argsOf('CMD') ?? 'null')).toEqual([
      '--import',
      './dist/telemetry/instrument.js',
      'dist/main.js',
    ]);
    expect(argsOf('HEALTHCHECK')).toMatch(
      /CMD \["\/nodejs\/bin\/node", "dist\/healthcheck\.js"\]$/,
    );
  });
});
