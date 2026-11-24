/**
 * Fails the zap job unless its active scan ran every rule to the end
 * (ADR-0007). A scan cut short by its time budget, a skipped rule or a rule
 * of the policy that ZAP did not run would otherwise pass as if complete.
 *
 *   node scripts/zap-coverage.ts <active-scan.json> [--policy .zap/pr.policy]
 *
 * The coverage file is written by the ZAP hook (.zap/hooks.py): one
 * [name, id, quality, status, ms, requests, alerts] entry per rule, plus the
 * rule ids ZAP enabled for the policy. With --policy, the rules enabled in
 * that file are expected too, so a rule missing from the ZAP image fails.
 */
import { existsSync, readFileSync } from 'node:fs';

type RuleProgress = [string, string, string, string, string, string, string];

export interface Coverage {
  policy?: string;
  expected?: string[];
  rules?: RuleProgress[];
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

function main(argv: string[]): number {
  const [input, option, policyPath] = argv;
  if (input === undefined) {
    throw new Error('usage: zap-coverage.ts <active-scan.json> [--policy <file.policy>]');
  }
  // Paths come from the workflow's command line.
  /* eslint-disable security/detect-non-literal-fs-filename */
  if (!existsSync(input)) {
    process.stdout.write(`No coverage recorded (${input}): the scan cannot be checked.\n`);
    return 1;
  }
  const coverage = JSON.parse(readFileSync(input, 'utf8')) as Coverage;
  const policyIds =
    option === '--policy' && policyPath !== undefined
      ? policyRules(readFileSync(policyPath, 'utf8'))
      : [];
  /* eslint-enable security/detect-non-literal-fs-filename */

  const problems = coverageProblems(coverage, policyIds);
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  const total = String(coverage.rules?.length ?? 0);
  process.stdout.write(
    problems.length === 0
      ? `All ${total} rules of policy ${coverage.policy ?? '?'} completed.\n`
      : `The active scan is incomplete: ${String(problems.length)} problem(s).\n`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
