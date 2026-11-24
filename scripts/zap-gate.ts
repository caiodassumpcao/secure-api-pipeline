/**
 * The zap job's own gate (ADR-0007), next to the High alerts of
 * scripts/zap-report.ts. It fails unless:
 *
 * - the active scan ran every rule of its policy to the end: a scan cut short
 *   by its time budget, a skipped rule, or a rule of the policy that ZAP did
 *   not run would otherwise pass as if complete;
 * - the API answered no 5xx, whatever severity ZAP gave it: a server error
 *   under attack is a bug, and ZAP rates it below High.
 *
 *   node scripts/zap-gate.ts <active-scan.json> [--policy .zap/pr.policy]
 *     [--api-status reports/zap/api-status.json]
 *
 * The active scan file comes from the ZAP hook (.zap/hooks.py): one
 * [name, id, quality, status, ms, requests, alerts] entry per rule, the rule
 * ids ZAP enabled, and the status codes of the active scan's responses. With
 * --policy, the rules enabled in that file are expected too, so a rule missing
 * from the ZAP image fails. With --api-status, the counts from the API's own
 * request log (scripts/api-status.ts) are checked as well.
 */
import { existsSync, readFileSync } from 'node:fs';

type RuleProgress = [string, string, string, string, string, string, string];

/** Responses by status code, e.g. `{ "200": 330, "500": 4 }`. */
export type StatusCounts = Record<string, number>;

export interface Coverage {
  policy?: string;
  expected?: string[];
  rules?: RuleProgress[];
  codes?: StatusCounts;
}

/** Ids of the rules a ZAP policy file enables (`<p40018><enabled>true`). */
export function policyRules(policy: string): string[] {
  return [...policy.matchAll(/<p(\d+)>\s*<enabled>true<\/enabled>/g)].map(([, id]) => id ?? '');
}

/** Why the scan cannot count as complete; empty when it can. */
export function coverageProblems(coverage: Coverage, policyIds: string[] = []): string[] {
  const rules = coverage.rules ?? [];
  if (rules.length === 0) return ['the active scan recorded no rules'];
  const problems = rules
    .filter(([, , , status]) => status !== 'Complete')
    .map(([name, id, , status]) => `rule ${id} (${name}) did not complete: ${status}`);
  const ran = new Set(rules.map(([, id]) => id));
  const expected = new Set([...(coverage.expected ?? []), ...policyIds]);
  for (const id of [...expected].filter((each) => !ran.has(each)).sort()) {
    problems.push(`rule ${id} is enabled in the policy but did not run`);
  }
  return problems;
}

/** One problem per 5xx status that `source` reports at least once. */
export function serverErrorProblems(source: string, codes: StatusCounts): string[] {
  return Object.entries(codes)
    .filter(([code, count]) => /^5\d\d$/.test(code) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${source} answered ${code} ${String(count)} time(s)`);
}

/** Problems of the API's own counts: no request logged, or any 5xx. */
export function apiStatusProblems(codes: StatusCounts): string[] {
  const total = Object.values(codes).reduce((sum, count) => sum + count, 0);
  if (total === 0) return ['the API logged no completed request: its responses cannot be checked'];
  return serverErrorProblems('the API (request log)', codes);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv: string[]): number {
  const [input] = argv;
  if (input === undefined || input.startsWith('--')) {
    throw new Error(
      'usage: zap-gate.ts <active-scan.json> [--policy <file.policy>] [--api-status <api-status.json>]',
    );
  }
  const policyPath = option(argv, '--policy');
  const apiStatusPath = option(argv, '--api-status');
  // Paths come from the workflow's command line.
  /* eslint-disable security/detect-non-literal-fs-filename */
  if (!existsSync(input)) {
    process.stdout.write(`No coverage recorded (${input}): the scan cannot be checked.\n`);
    return 1;
  }
  const coverage = JSON.parse(readFileSync(input, 'utf8')) as Coverage;
  const policyIds = policyPath === undefined ? [] : policyRules(readFileSync(policyPath, 'utf8'));
  const apiCodes =
    apiStatusPath === undefined
      ? undefined
      : existsSync(apiStatusPath)
        ? (JSON.parse(readFileSync(apiStatusPath, 'utf8')) as StatusCounts)
        : {};
  /* eslint-enable security/detect-non-literal-fs-filename */

  const problems = [
    ...coverageProblems(coverage, policyIds),
    ...serverErrorProblems('the active scan (ZAP)', coverage.codes ?? {}),
    ...(apiCodes === undefined ? [] : apiStatusProblems(apiCodes)),
  ];
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  const total = String(coverage.rules?.length ?? 0);
  process.stdout.write(
    problems.length === 0
      ? `All ${total} rules of policy ${coverage.policy ?? '?'} completed; no 5xx.\n`
      : `The zap gate failed: ${String(problems.length)} problem(s).\n`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
