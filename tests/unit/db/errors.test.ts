import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation } from '../../../src/db/errors.ts';

const pgError = (code: string, constraint: string) =>
  Object.assign(new Error('violation'), { code, constraint });

describe('database error helpers', () => {
  it('recognize violations wrapped by Drizzle or raw', () => {
    const wrapped = new DrizzleQueryError(
      'insert ...',
      [],
      pgError('23505', 'workspaces_slug_unique'),
    );

    expect(isUniqueViolation(wrapped, 'workspaces_slug_unique')).toBe(true);
    expect(
      isUniqueViolation(pgError('23505', 'workspaces_slug_unique'), 'workspaces_slug_unique'),
    ).toBe(true);
    expect(
      isForeignKeyViolation(
        pgError('23503', 'tasks_assignee_membership_fk'),
        'tasks_assignee_membership_fk',
      ),
    ).toBe(true);
  });

  it('match the constraint and the code', () => {
    expect(
      isUniqueViolation(pgError('23505', 'users_email_unique'), 'workspaces_slug_unique'),
    ).toBe(false);
    expect(
      isUniqueViolation(pgError('23503', 'workspaces_slug_unique'), 'workspaces_slug_unique'),
    ).toBe(false);
  });

  it('ignore anything else', () => {
    expect(isUniqueViolation(new Error('boom'), 'x')).toBe(false);
    expect(isUniqueViolation('boom', 'x')).toBe(false);
    expect(isForeignKeyViolation(null, 'x')).toBe(false);
  });
});
