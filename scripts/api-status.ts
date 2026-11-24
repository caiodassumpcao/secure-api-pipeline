/**
 * Counts what the API answered during the DAST job, by status code, from its
 * JSON request log (`request completed` lines), for the job summary and for
 * scripts/zap-gate.ts:
 *
 *   docker compose logs api --no-log-prefix --no-color \
 *     | node scripts/api-status.ts reports/zap/api-status.json
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
  const [output] = argv;
  if (output === undefined) throw new Error('usage: api-status.ts <api-status.json> < api.log');
  const counts = countStatuses(readFileSync(0, 'utf8'));
  // The path comes from the workflow's command line.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(output, `${JSON.stringify(counts)}\n`);
  process.stdout.write(`\n${summary(counts)}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
