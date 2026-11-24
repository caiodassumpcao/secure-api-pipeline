/**
 * Decides whether a scan blocks the merge (ADR-0007). Scanners write their
 * full report (uploaded to code scanning whatever it holds); this gate then
 * fails on the findings that block:
 *
 *   node scripts/scan-gate.ts sarif <report.sarif> --level error
 *   node scripts/scan-gate.ts sarif <report.sarif> --min-security-severity 7
 *   node scripts/scan-gate.ts osv <report.json> --min-cvss 7
 *
 * Suppressed SARIF results (in-source or by the tool's ignore file) never
 * block. Prints every blocking finding and exits 1 if there is one.
 */
import { readFileSync } from 'node:fs';

interface SarifRule {
  id: string;
  defaultConfiguration?: { level?: string };
  properties?: Record<string, unknown>;
}

interface SarifResult {
  ruleId?: string;
  ruleIndex?: number;
  rule?: { id?: string; index?: number; toolComponent?: { index?: number } };
  level?: string;
  message?: { text?: string };
  suppressions?: unknown[];
  locations?: {
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }[];
}

export interface Sarif {
  runs?: {
    tool: { driver: { name: string; rules?: SarifRule[] }; extensions?: { rules?: SarifRule[] }[] };
    results?: SarifResult[];
  }[];
}

export type SarifThreshold = { level: 'error' } | { minSecuritySeverity: number };

/** Blocking SARIF findings, one line each. */
export function sarifFindings(sarif: Sarif, threshold: SarifThreshold): string[] {
  return (sarif.runs ?? []).flatMap((run) => {
    const rules = new Map<string, SarifRule>();
    const components = [run.tool.driver, ...(run.tool.extensions ?? [])];
    for (const component of components) {
      for (const rule of component.rules ?? []) rules.set(rule.id, rule);
    }
    return (run.results ?? []).flatMap((result) => {
      if ((result.suppressions ?? []).length > 0) return [];
      const id = result.ruleId ?? result.rule?.id ?? '';
      const rule = rules.get(id);
      const blocking =
        'level' in threshold
          ? (result.level ?? rule?.defaultConfiguration?.level ?? 'warning') === 'error'
          : Number(rule?.properties?.['security-severity'] ?? 0) >= threshold.minSecuritySeverity;
      if (!blocking) return [];
      const location = result.locations?.[0]?.physicalLocation;
      const where = `${location?.artifactLocation?.uri ?? '?'}:${String(location?.region?.startLine ?? 0)}`;
      const message = (result.message?.text ?? '').split('\n', 1)[0] ?? '';
      return [`${run.tool.driver.name} ${id} at ${where}: ${message}`];
    });
  });
}

export interface OsvReport {
  results?: {
    source?: { path?: string };
    packages?: {
      package: { name: string; version: string; ecosystem: string };
      groups?: { ids: string[]; aliases?: string[]; max_severity?: string }[];
    }[];
  }[];
}

/**
 * Vulnerability groups at or above a CVSS score. Groups without a score do not
 * block: they stay visible in code scanning through the SARIF report.
 */
export function osvFindings(report: OsvReport, minCvss: number): string[] {
  return (report.results ?? []).flatMap((result) =>
    (result.packages ?? []).flatMap(({ package: pkg, groups }) =>
      (groups ?? [])
        .filter((group) => Number(group.max_severity ?? 0) >= minCvss)
        .map(
          (group) =>
            `${pkg.ecosystem} ${pkg.name}@${pkg.version}: ${group.ids.join(', ')} (CVSS ${group.max_severity ?? '?'}) in ${result.source?.path ?? '?'}`,
        ),
    ),
  );
}

function main(argv: string[]): number {
  const [kind, file, option, value] = argv;
  if (file === undefined || value === undefined) {
    throw new Error('usage: scan-gate.ts sarif|osv <file> <threshold option> <value>');
  }
  // The path comes from the workflow's command line.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const report: unknown = JSON.parse(readFileSync(file, 'utf8'));
  let findings: string[];
  if (kind === 'sarif' && option === '--level' && value === 'error') {
    findings = sarifFindings(report as Sarif, { level: 'error' });
  } else if (kind === 'sarif' && option === '--min-security-severity') {
    findings = sarifFindings(report as Sarif, { minSecuritySeverity: Number(value) });
  } else if (kind === 'osv' && option === '--min-cvss') {
    findings = osvFindings(report as OsvReport, Number(value));
  } else {
    throw new Error(`unknown gate: ${argv.join(' ')}`);
  }
  for (const finding of findings) process.stdout.write(`${finding}\n`);
  process.stdout.write(`${String(findings.length)} blocking finding(s) in ${file}\n`);
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
