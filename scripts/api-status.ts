/**
 * Counts what the API answered during the DAST job, by status code, from its
 * JSON request log (`request completed` lines), for the job summary and for
 * scripts/zap-gate.ts:
 *
 *   docker compose logs api --no-log-prefix --no-color > api.log
 *   node scripts/api-status.ts api.log reports/zap/api-status.json
 *
 * The log is read from a file, not from a pipe: reading a large log from
 * standard input crashed Node.js once in CI (a glibc heap error), and the
 * step passed, which only the gate's empty-count check caught.
 *
 * It checks ZAP's own counts: every request the stack served, the scanner's
 * base requests included, as the API saw it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { StatusCounts } from './zap-gate.ts';

interface LogLine {
  msg?: unknown;
  res?: { statusCode?: unknown };
}

/** Responses by status code; lines that are not JSON or not `request completed` are skipped. */
export function countStatuses(log: string): StatusCounts {
  const counts = new Map<string, number>();
  for (const line of log.split('\n')) {
    let entry: LogLine;
    try {
      entry = JSON.parse(line) as LogLine;
    } catch {
      continue;
    }
    if (entry.msg !== 'request completed') continue;
    const status = entry.res?.statusCode;
    const code = typeof status === 'number' ? String(status) : 'none';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

export function summary(counts: StatusCounts): string {
  const list = Object.entries(counts)
    .map(([code, count]) => `${code}: ${String(count)}`)
    .join(', ');
  return `API responses by status (whole job): ${list === '' ? 'none' : list}.`;
}

function main(argv: string[]): void {
  const [input, output] = argv;
  if (input === undefined || output === undefined) {
    throw new Error('usage: api-status.ts <api.log> <api-status.json>');
  }
  // Paths come from the workflow's command line.
  /* eslint-disable security/detect-non-literal-fs-filename */
  const counts = countStatuses(readFileSync(input, 'utf8'));
  writeFileSync(output, `${JSON.stringify(counts)}\n`);
  /* eslint-enable security/detect-non-literal-fs-filename */
  process.stdout.write(`\n${summary(counts)}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
