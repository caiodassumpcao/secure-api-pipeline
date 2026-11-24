/**
 * Turns an OWASP ZAP JSON report (`zap-api-scan.py -J`) into SARIF for code
 * scanning, and fails on High alerts (ADR-0007):
 *
 *   node scripts/zap-report.ts <zap-report.json> <zap.sarif> [--ignore .zap/rules.tsv]
 *
 * DAST findings have no source line, so each result points at the module that
 * serves the URL (src/modules/<module>/<module>.routes.ts), or at src/app.ts
 * for what the whole app answers. Rules marked IGNORE in the ZAP rules file,
 * each with its reason documented in docs/security-pipeline.md, neither block
 * nor reach code scanning.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

interface ZapInstance {
  uri: string;
  method: string;
  param?: string;
  evidence?: string;
}

interface ZapAlert {
  pluginid: string;
  alert?: string;
  name: string;
  riskcode: string;
  desc?: string;
  solution?: string;
  reference?: string;
  cweid?: string;
  instances?: ZapInstance[];
}

export interface ZapReport {
  site?: { alerts?: ZapAlert[] }[];
}

const RISKS = ['Informational', 'Low', 'Medium', 'High'] as const;
// code scanning ranks alerts by this score: High, Medium, Low, Informational.
const SECURITY_SEVERITY = ['0.0', '3.0', '5.5', '8.0'] as const;
const LEVEL = ['note', 'note', 'warning', 'error'] as const;

/** Module order matters: the most specific resource in the path wins. */
const ROUTE_FILES: [RegExp, string][] = [
  [/^\/health\//, 'src/modules/health/health.routes.ts'],
  [/^\/(?:openapi\.json|docs)\b/, 'src/plugins/openapi.ts'],
  [/^\/v1\/(?:auth\/|me$)/, 'src/modules/auth/auth.routes.ts'],
  [/\/tasks\b/, 'src/modules/tasks/tasks.routes.ts'],
  [/\/audit-events\b/, 'src/modules/audit/audit.routes.ts'],
  [/\/invitations\b/, 'src/modules/invitations/invitations.routes.ts'],
  [/\/members\b/, 'src/modules/members/members.routes.ts'],
  [/\/projects\b/, 'src/modules/projects/projects.routes.ts'],
  [/^\/v1\/workspaces\b/, 'src/modules/workspaces/workspaces.routes.ts'],
];

/** The source file that answers a URL path. */
export function routeFile(path: string): string {
  return ROUTE_FILES.find(([pattern]) => pattern.test(path))?.[1] ?? 'src/app.ts';
}

const plain = (html = ''): string =>
  html
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

const risk = (alert: ZapAlert): number => Math.min(Math.max(Number(alert.riskcode) || 0, 0), 3);

/** Plugin ids marked IGNORE in a ZAP rules file (`<id>\tIGNORE\t(<reason>)`). */
export function ignoredRules(rulesFile: string): Set<string> {
  return new Set(
    rulesFile
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => line.split('\t'))
      .filter(([, action]) => action?.trim() === 'IGNORE')
      .map(([id]) => id?.trim() ?? ''),
  );
}

export function alertsOf(report: ZapReport, ignored: Set<string>): ZapAlert[] {
  return (report.site ?? [])
    .flatMap((site) => site.alerts ?? [])
    .filter((alert) => !ignored.has(alert.pluginid));
}

/** SARIF 2.1.0: one rule per ZAP plugin, one result per alert, method and path. */
export function toSarif(alerts: ZapAlert[]): object {
  const rules = [...new Map(alerts.map((alert) => [alert.pluginid, alert])).values()].map(
    (alert) => ({
      id: alert.pluginid,
      name: plain(alert.name).replaceAll(/[^A-Za-z0-9]+/g, ''),
      shortDescription: { text: plain(alert.alert ?? alert.name) },
      fullDescription: { text: plain(alert.desc) },
      help: { text: plain(alert.solution) },
      helpUri: /https?:\/\/\S+/.exec(plain(alert.reference))?.[0],
      properties: {
        tags: ['security', 'dast', ...(alert.cweid ? [`external/cwe/cwe-${alert.cweid}`] : [])],
        'security-severity': SECURITY_SEVERITY[risk(alert)],
      },
    }),
  );
  const results = alerts.flatMap((alert) => {
    const seen = new Set<string>();
    return (alert.instances ?? []).flatMap((instance) => {
      const path = new URL(instance.uri).pathname;
      const key = `${instance.method} ${path}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          ruleId: alert.pluginid,
          level: LEVEL[risk(alert)],
          message: {
            text: `${plain(alert.alert ?? alert.name)} (${RISKS[risk(alert)]}) on ${key}${instance.param ? `, parameter ${instance.param}` : ''}`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: routeFile(path), uriBaseId: '%SRCROOT%' },
                region: { startLine: 1 },
              },
            },
          ],
          partialFingerprints: {
            zapAlert: createHash('sha256').update(`${alert.pluginid} ${key}`).digest('hex'),
          },
        },
      ];
    });
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: { name: 'OWASP ZAP', informationUri: 'https://www.zaproxy.org/', rules },
        },
        results,
      },
    ],
  };
}

function main(argv: string[]): number {
  const [input, output, option, rulesPath] = argv;
  if (input === undefined || output === undefined) {
    throw new Error('usage: zap-report.ts <zap-report.json> <zap.sarif> [--ignore <rules.tsv>]');
  }
  // Paths come from the workflow's command line.
  /* eslint-disable security/detect-non-literal-fs-filename */
  const ignored =
    option === '--ignore' && rulesPath !== undefined
      ? ignoredRules(readFileSync(rulesPath, 'utf8'))
      : new Set<string>();
  const alerts = alertsOf(JSON.parse(readFileSync(input, 'utf8')) as ZapReport, ignored);
  writeFileSync(output, `${JSON.stringify(toSarif(alerts), null, 2)}\n`);
  /* eslint-enable security/detect-non-literal-fs-filename */

  for (const level of [3, 2, 1, 0]) {
    for (const alert of alerts.filter((each) => risk(each) === level)) {
      const count = String(alert.instances?.length ?? 0);
      process.stdout.write(
        `${RISKS.at(level) ?? ''}\t${alert.pluginid}\t${plain(alert.name)} (${count})\n`,
      );
    }
  }
  const high = alerts.filter((alert) => risk(alert) === 3);
  process.stdout.write(`${String(high.length)} High alert(s)\n`);
  return high.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
