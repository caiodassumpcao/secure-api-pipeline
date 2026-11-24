import { describe, expect, it } from 'vitest';
import {
  configProblems,
  probeProblems,
  type ImageConfig,
  type Probe,
} from '../../../scripts/image-check.ts';

const image: ImageConfig = {
  Architecture: 'amd64',
  Config: {
    User: '65532:65532',
    Entrypoint: ['/nodejs/bin/node'],
    Cmd: ['--import', './dist/telemetry/instrument.js', 'dist/main.js'],
    Env: ['NODE_ENV=production', 'PORT=3000'],
    Labels: {
      'org.opencontainers.image.source': 'https://github.com/example/repo',
      'org.opencontainers.image.revision': 'abc123',
      'org.opencontainers.image.version': '0.4.0',
    },
    Healthcheck: { Test: ['CMD', '/nodejs/bin/node', 'dist/healthcheck.js'] },
  },
};

const probe: Probe = {
  uid: 65532,
  glibc: '2.41',
  bindings: ['@node-rs+argon2-linux-x64-gnu@2.2.2'],
  verified: true,
};

describe('configProblems', () => {
  it('accepts the image ADR-0007 describes', () => {
    expect(configProblems(image, 'amd64', { labels: true })).toEqual([]);
  });

  it.each<[string, ImageConfig['Config']]>([
    ['user is "node", not 65532:65532', { ...image.Config, User: 'node' }],
    ['user is "", not 65532:65532', { ...image.Config, User: '' }],
    ['entrypoint is null', { ...image.Config, Entrypoint: null }],
    ['cmd is ["node","dist/main.js"]', { ...image.Config, Cmd: ['node', 'dist/main.js'] }],
    [
      'health check is ["CMD","node","--import","./dist/telemetry/instrument.js","dist/healthcheck.js"]',
      {
        ...image.Config,
        Healthcheck: {
          Test: [
            'CMD',
            'node',
            '--import',
            './dist/telemetry/instrument.js',
            'dist/healthcheck.js',
          ],
        },
      },
    ],
    [
      'NODE_OPTIONS is set',
      { ...image.Config, Env: ['NODE_OPTIONS=--import ./dist/telemetry/instrument.js'] },
    ],
    [
      'label org.opencontainers.image.revision is missing',
      {
        ...image.Config,
        Labels: { 'org.opencontainers.image.source': 'x', 'org.opencontainers.image.version': 'y' },
      },
    ],
  ])('reports that the %s', (problem, config) => {
    expect(configProblems({ ...image, Config: config }, 'amd64', { labels: true })).toContain(
      problem,
    );
  });

  it('checks the architecture and, on request only, the labels', () => {
    expect(configProblems(image, 'arm64', { labels: true })).toEqual(['architecture is amd64']);
    expect(
      configProblems({ ...image, Config: { ...image.Config, Labels: null } }, 'amd64', {
        labels: false,
      }),
    ).toEqual([]);
  });
});

describe('probeProblems', () => {
  it('accepts one glibc binding for this CPU that hashes and verifies', () => {
    expect(probeProblems(probe, 'amd64')).toEqual([]);
    expect(
      probeProblems({ ...probe, bindings: ['@node-rs+argon2-linux-arm64-gnu@2.2.2'] }, 'arm64'),
    ).toEqual([]);
  });

  it.each<[string, Partial<Probe>]>([
    ['the musl binding of the build stage', { bindings: ['@node-rs+argon2-linux-x64-musl@2.2.2'] }],
    ['the binding of another CPU', { bindings: ['@node-rs+argon2-linux-arm64-gnu@2.2.2'] }],
    [
      'both libc bindings',
      {
        bindings: ['@node-rs+argon2-linux-x64-gnu@2.2.2', '@node-rs+argon2-linux-x64-musl@2.2.2'],
      },
    ],
    ['no binding', { bindings: [] }],
  ])('rejects %s', (_case, change) => {
    expect(probeProblems({ ...probe, ...change }, 'amd64')).toEqual([
      expect.stringMatching(/^argon2 bindings are .*expected @node-rs\+argon2-linux-x64-gnu@\*$/),
    ]);
  });

  it('reports root, a missing glibc and a failed verification', () => {
    expect(probeProblems({ ...probe, uid: 0, glibc: null, verified: false }, 'amd64')).toEqual([
      'runs as uid 0',
      'the runtime does not report glibc',
      'argon2 could not hash and verify a password',
    ]);
  });
});
