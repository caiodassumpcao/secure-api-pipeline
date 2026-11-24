import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Coverage, coverageProblems, policyRules } from '../../../scripts/zap-coverage.ts';

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
