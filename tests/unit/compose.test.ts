import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The local stack exposes nothing beyond the host (threat model): every port
 * on 127.0.0.1, the metrics port never published, third-party images pinned
 * by digest, and the observability profile optional.
 */

interface Service {
  image?: string;
  build?: unknown;
  profiles?: string[];
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, unknown>;
}

const root = new URL('../../', import.meta.url);
const compose = parse(readFileSync(new URL('compose.yaml', root), 'utf8')) as {
  services: Record<string, Service>;
};
const services = Object.entries(compose.services);

describe('compose.yaml', () => {
  it.each(services)('%s publishes ports on 127.0.0.1 only', (_name, service) => {
    for (const port of service.ports ?? []) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('never publishes the metrics port', () => {
    const published = services.flatMap(([, service]) => [
      ...(service.ports ?? []),
      ...(service.expose ?? []),
    ]);

    expect(published.filter((port) => port.endsWith(':9464') || port === '9464')).toEqual([]);
  });

  it.each(services.filter(([, service]) => service.build === undefined))(
    '%s pins its image by digest',
    (_name, service) => {
      expect(service.image).toMatch(/:[\w.-]+@sha256:[0-9a-f]{64}$/);
    },
  );

  it('keeps the observability stack in its own profile, which the API does not need', () => {
    const lgtm = compose.services['otel-lgtm'];

    expect(lgtm?.profiles).toEqual(['observability']);
    expect(lgtm?.volumes?.every((volume) => volume.endsWith(':ro'))).toBe(true);
    // With the profile on, the API waits for the stack; without it, it starts alone.
    expect(compose.services.api?.depends_on?.['otel-lgtm']).toEqual({
      condition: 'service_healthy',
      required: false,
    });
    expect(compose.services.api?.environment?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      '${API_OTLP_ENDPOINT:-}',
    );
  });
});

describe('.github/scanners/compose.yaml', () => {
  const scanners = parse(readFileSync(new URL('.github/scanners/compose.yaml', root), 'utf8')) as {
    services: Record<string, Service & { network_mode?: string }>;
  };
  const entries = Object.entries(scanners.services);

  it('declares every scanner the workflows run', () => {
    expect(entries.map(([name]) => name).sort()).toEqual(
      ['gitleaks', 'osv-scanner', 'semgrep', 'syft', 'trivy', 'zap'].sort(),
    );
  });

  it.each(entries)('%s pins its image by tag and digest, publishes nothing', (_name, service) => {
    expect(service.image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(service.build).toBeUndefined();
    expect(service.ports ?? []).toEqual([]);
  });

  it('gives the host network to ZAP only, which scans the stack on 127.0.0.1', () => {
    expect(
      entries.filter(([, service]) => service.network_mode === 'host').map(([name]) => name),
    ).toEqual(['zap']);
  });
});

interface Panel {
  type: string;
  title: string;
  datasource?: { uid: string };
  targets?: { expr: string }[];
}

describe('grafana dashboard', () => {
  const dashboard = JSON.parse(
    readFileSync(new URL('observability/grafana/dashboards/secure-api.json', root), 'utf8'),
  ) as { uid: string; panels: Panel[] };
  const panels = dashboard.panels.filter((panel) => panel.type !== 'row');

  it.each(panels.map((panel) => [panel.title, panel] as const))(
    '"%s" queries the provisioned Prometheus, filtered by service',
    (_title, panel) => {
      expect(panel.datasource?.uid).toBe('prometheus');
      expect(panel.targets?.length).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) expect(target.expr).toContain('job="$job"');
    },
  );
});
