import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  apiStatusProblems,
  type Coverage,
  coverageProblems,
  policyRules,
  serverErrorProblems,
} from '../../../scripts/zap-gate.ts';

type Rule = NonNullable<Coverage['rules']>[number];

const rule = (id: string, status = 'Complete', name = `Rule ${id}`): Rule => [
  name,
  id,
  'release',
  status,
  '1000',
  '10',
  '0',
];

describe('policyRules', () => {
  it('reads the enabled rules of a policy file, disabled ones aside', () => {
    const policy = [
      '<plugins>',
      '<!-- SQL Injection -->',
      '<p40018>',
      '<enabled>true</enabled>',
      '<level>MEDIUM</level>',
      '</p40018>',
      '<p90023>',
      '<enabled>false</enabled>',
      '</p90023>',
      '<p6>',
      '  <enabled>true</enabled>',
      '</p6>',
      '</plugins>',
    ].join('\n');

    expect(policyRules(policy)).toEqual(['40018', '6']);
  });

  it('reads the policy of the pull request scan', () => {
    const ids = policyRules(readFileSync('.zap/pr.policy', 'utf8'));

    expect(ids).toContain('40018');
    expect(ids).toContain('40022');
    expect(ids).not.toContain('90023');
  });
});

describe('coverageProblems', () => {
  it('accepts a scan whose rules all completed', () => {
    const coverage = { expected: ['6', '40018'], rules: [rule('6'), rule('40018')] };

    expect(coverageProblems(coverage, ['40018'])).toEqual([]);
  });

  it('rejects a scan that recorded no rule', () => {
    expect(coverageProblems({})).toEqual(['the active scan recorded no rules']);
    expect(coverageProblems({ rules: [] })).toEqual(['the active scan recorded no rules']);
  });

  it('names every rule cut short, skipped or still pending', () => {
    const coverage = {
      rules: [
        rule('6'),
        rule('40018', 'Skipped, rule took too long', 'SQL Injection'),
        rule('90020', '37%'),
        rule('90035', 'Pending'),
      ],
    };

    expect(coverageProblems(coverage)).toEqual([
      'rule 40018 (SQL Injection) did not complete: Skipped, rule took too long',
      'rule 90020 (Rule 90020) did not complete: 37%',
      'rule 90035 (Rule 90035) did not complete: Pending',
    ]);
  });

  it('names rules expected by ZAP or by the policy file that did not run', () => {
    const coverage = { expected: ['6', '90034'], rules: [rule('6')] };

    expect(coverageProblems(coverage, ['40022', '6'])).toEqual([
      'rule 40022 is enabled in the policy but did not run',
      'rule 90034 is enabled in the policy but did not run',
    ]);
  });
});

describe('serverErrorProblems', () => {
  it('names every 5xx status with its count, in order', () => {
    const codes = { '200': 330, '503': 1, '400': 3662, '500': 4 };

    expect(serverErrorProblems('the active scan (ZAP)', codes)).toEqual([
      'the active scan (ZAP) answered 500 4 time(s)',
      'the active scan (ZAP) answered 503 1 time(s)',
    ]);
  });

  it('accepts any number of 4xx, and 5xx counted zero times', () => {
    expect(serverErrorProblems('ZAP', { '400': 3662, '429': 12, '500': 0 })).toEqual([]);
  });

  it('ignores responses without a status', () => {
    expect(serverErrorProblems('ZAP', { none: 3, '200': 1 })).toEqual([]);
  });
});

describe('apiStatusProblems', () => {
  it('reports the 5xx the API logged', () => {
    expect(apiStatusProblems({ '200': 345, '500': 4 })).toEqual([
      'the API (request log) answered 500 4 time(s)',
    ]);
  });

  it('refuses empty counts, which would pass any scan', () => {
    expect(apiStatusProblems({})).toEqual([
      'the API logged no completed request: its responses cannot be checked',
    ]);
  });

  it('accepts a log without server errors', () => {
    expect(apiStatusProblems({ '200': 345, '404': 134 })).toEqual([]);
  });
});
