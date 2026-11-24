import { describe, expect, it } from 'vitest';
import {
  alertsOf,
  ignoredRules,
  routeFile,
  toSarif,
  type ZapReport,
} from '../../../scripts/zap-report.ts';

const ws = '/v1/workspaces/0190f3b2-7c1e-7d2a-9f00-1234567890ab';

describe('routeFile', () => {
  it.each([
    ['/health/ready', 'src/modules/health/health.routes.ts'],
    ['/openapi.json', 'src/plugins/openapi.ts'],
    ['/docs/static/index.html', 'src/plugins/openapi.ts'],
    ['/v1/auth/login', 'src/modules/auth/auth.routes.ts'],
    ['/v1/me', 'src/modules/auth/auth.routes.ts'],
    ['/v1/workspaces', 'src/modules/workspaces/workspaces.routes.ts'],
    [ws, 'src/modules/workspaces/workspaces.routes.ts'],
    [`${ws}/members/x`, 'src/modules/members/members.routes.ts'],
    [`${ws}/invitations`, 'src/modules/invitations/invitations.routes.ts'],
    ['/v1/invitations/accept', 'src/modules/invitations/invitations.routes.ts'],
    [`${ws}/projects/p`, 'src/modules/projects/projects.routes.ts'],
    [`${ws}/projects/p/tasks`, 'src/modules/tasks/tasks.routes.ts'],
    [`${ws}/tasks/t`, 'src/modules/tasks/tasks.routes.ts'],
    [`${ws}/audit-events`, 'src/modules/audit/audit.routes.ts'],
    ['/', 'src/app.ts'],
    ['/scan/admin', 'src/app.ts'],
  ])('maps %s to %s', (path, file) => {
    expect(routeFile(path)).toBe(file);
  });
});

describe('ignoredRules', () => {
  it('reads the IGNORE lines of a ZAP rules file, comments aside', () => {
    const rules = [
      '# 10049: storable responses, see docs/security-pipeline.md',
      '10049\tIGNORE\t(Storable and Cacheable Content)',
      '10021\tWARN\t(X-Content-Type-Options Header Missing)',
      '#90022\tIGNORE\t(commented out)',
      '',
    ].join('\n');

    expect([...ignoredRules(rules)]).toEqual(['10049']);
  });
});

const report: ZapReport = {
  site: [
    {
      alerts: [
        {
          pluginid: '40018',
          alert: 'SQL Injection',
          name: 'SQL Injection',
          riskcode: '3',
          desc: '<p>SQL injection may be possible.</p>',
          solution: '<p>Use parameterized queries.</p>',
          reference: '<p>https://owasp.org/www-community/attacks/SQL_Injection</p>',
          cweid: '89',
          instances: [
            { uri: `http://127.0.0.1:3000${ws}/tasks/t?x=1`, method: 'PATCH', param: 'title' },
            { uri: `http://127.0.0.1:3000${ws}/tasks/t`, method: 'PATCH', param: 'status' },
            { uri: `http://127.0.0.1:3000${ws}/tasks/t`, method: 'GET' },
          ],
        },
        {
          pluginid: '10049',
          name: 'Storable and Cacheable Content',
          riskcode: '0',
          instances: [{ uri: 'http://127.0.0.1:3000/health/live', method: 'GET' }],
        },
      ],
    },
  ],
};

describe('toSarif', () => {
  const sarif = toSarif(alertsOf(report, new Set())) as {
    runs: [
      {
        tool: {
          driver: {
            rules: { id: string; properties: Record<string, unknown>; helpUri?: string }[];
          };
        };
        results: {
          ruleId: string;
          level: string;
          message: { text: string };
          locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
          partialFingerprints: { zapAlert: string };
        }[];
      },
    ];
  };
  const [run] = sarif.runs;

  it('describes each ZAP plugin once, ranked by risk', () => {
    expect(
      run.tool.driver.rules.map((rule) => [rule.id, rule.properties['security-severity']]),
    ).toEqual([
      ['40018', '8.0'],
      ['10049', '0.0'],
    ]);
    expect(run.tool.driver.rules[0]?.properties.tags).toEqual([
      'security',
      'dast',
      'external/cwe/cwe-89',
    ]);
    expect(run.tool.driver.rules[0]?.helpUri).toBe(
      'https://owasp.org/www-community/attacks/SQL_Injection',
    );
  });

  it('reports each alert once per method and path, at the module serving it', () => {
    expect(run.results.map((result) => [result.ruleId, result.level, result.message.text])).toEqual(
      [
        ['40018', 'error', `SQL Injection (High) on PATCH ${ws}/tasks/t, parameter title`],
        ['40018', 'error', `SQL Injection (High) on GET ${ws}/tasks/t`],
        ['10049', 'note', 'Storable and Cacheable Content (Informational) on GET /health/live'],
      ],
    );
    expect(run.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      'src/modules/tasks/tasks.routes.ts',
    );
    expect(new Set(run.results.map((result) => result.partialFingerprints.zapAlert)).size).toBe(3);
  });

  it('leaves ignored rules out', () => {
    expect(alertsOf(report, new Set(['40018'])).map((alert) => alert.pluginid)).toEqual(['10049']);
  });
});
