import { describe, expect, it } from 'vitest';
import { osvFindings, sarifFindings, type Sarif } from '../../../scripts/scan-gate.ts';

const location = (uri: string, startLine: number) => [
  { physicalLocation: { artifactLocation: { uri }, region: { startLine } } },
];

describe('sarifFindings by level', () => {
  const sarif: Sarif = {
    runs: [
      {
        tool: {
          driver: {
            name: 'Semgrep',
            rules: [
              { id: 'default-error', defaultConfiguration: { level: 'error' } },
              { id: 'default-warning', defaultConfiguration: { level: 'warning' } },
            ],
          },
        },
        results: [
          {
            ruleId: 'explicit',
            level: 'error',
            message: { text: 'blocks\nsecond line' },
            locations: location('src/a.ts', 3),
          },
          {
            ruleId: 'default-error',
            message: { text: 'blocks by default' },
            locations: location('src/b.ts', 7),
          },
          { ruleId: 'default-warning', message: { text: 'does not block' } },
          { ruleId: 'explicit', level: 'note', message: { text: 'does not block' } },
          {
            ruleId: 'explicit',
            level: 'error',
            message: { text: 'suppressed' },
            suppressions: [{ kind: 'inSource' }],
          },
        ],
      },
    ],
  };

  it('blocks on error results only, unless suppressed', () => {
    expect(sarifFindings(sarif, { level: 'error' })).toEqual([
      'Semgrep explicit at src/a.ts:3: blocks',
      'Semgrep default-error at src/b.ts:7: blocks by default',
    ]);
  });
});

describe('sarifFindings by security severity', () => {
  // CodeQL lists its rules in the query packs (extensions), not in the driver.
  const sarif: Sarif = {
    runs: [
      {
        tool: {
          driver: { name: 'CodeQL' },
          extensions: [
            {
              rules: [
                { id: 'js/sql-injection', properties: { 'security-severity': '8.8' } },
                { id: 'js/missing-rate-limiting', properties: { 'security-severity': '7.0' } },
                { id: 'js/log-injection', properties: { 'security-severity': '6.1' } },
                { id: 'js/unused-local-variable', properties: {} },
              ],
            },
          ],
        },
        results: [
          {
            rule: { id: 'js/sql-injection' },
            ruleId: 'js/sql-injection',
            message: { text: 'sql' },
            locations: location('src/x.ts', 1),
          },
          {
            ruleId: 'js/missing-rate-limiting',
            message: { text: 'rate' },
            locations: location('src/y.ts', 2),
          },
          { ruleId: 'js/log-injection', message: { text: 'log' } },
          { ruleId: 'js/unused-local-variable', message: { text: 'unused' } },
        ],
      },
    ],
  };

  it('blocks at or above the threshold, reading rules from every component', () => {
    expect(sarifFindings(sarif, { minSecuritySeverity: 7 })).toEqual([
      'CodeQL js/sql-injection at src/x.ts:1: sql',
      'CodeQL js/missing-rate-limiting at src/y.ts:2: rate',
    ]);
  });

  it('finds nothing in an empty report', () => {
    expect(sarifFindings({}, { minSecuritySeverity: 7 })).toEqual([]);
    expect(
      sarifFindings({ runs: [{ tool: { driver: { name: 'x' } } }] }, { level: 'error' }),
    ).toEqual([]);
  });
});

describe('osvFindings', () => {
  it('blocks on groups of CVSS 7.0 or more, not on unscored ones', () => {
    const report = {
      results: [
        {
          source: { path: '/src/pnpm-lock.yaml' },
          packages: [
            {
              package: { name: 'high', version: '1.0.0', ecosystem: 'npm' },
              groups: [{ ids: ['GHSA-aaaa-bbbb-cccc'], max_severity: '7.5' }],
            },
            {
              package: { name: 'medium', version: '2.0.0', ecosystem: 'npm' },
              groups: [{ ids: ['GHSA-dddd-eeee-ffff'], max_severity: '5.3' }],
            },
            {
              package: { name: 'unscored', version: '3.0.0', ecosystem: 'npm' },
              groups: [{ ids: ['OSV-2026-1'], max_severity: '' }],
            },
          ],
        },
      ],
    };

    expect(osvFindings(report, 7)).toEqual([
      'npm high@1.0.0: GHSA-aaaa-bbbb-cccc (CVSS 7.5) in /src/pnpm-lock.yaml',
    ]);
    expect(osvFindings({}, 7)).toEqual([]);
  });
});
