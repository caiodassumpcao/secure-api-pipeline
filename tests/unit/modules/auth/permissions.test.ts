import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS } from '../../../../src/modules/auth/permissions.ts';

/** DESIGN §2.1, one row per action: owner, admin, member, viewer. */
const EXPECTED = {
  'workspace:read': [true, true, true, true],
  'workspace:update': [true, true, false, false],
  'workspace:delete': [true, false, false, false],
  'member:read': [true, true, true, true],
  'member:manage': [true, true, false, false],
  'member:manage-owners': [true, false, false, false],
  'project:read': [true, true, true, true],
  'project:write': [true, true, false, false],
  'task:read': [true, true, true, true],
  'task:write': [true, true, true, false],
  'task:delete-any': [true, true, false, false],
  'task:delete-own': [true, true, true, false],
  'audit:read': [true, true, false, false],
} as const;

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

describe('permission matrix', () => {
  it('matches DESIGN §2.1', () => {
    const actual = Object.fromEntries(
      Object.keys(PERMISSIONS).map((action) => [
        action,
        ROLES.map((role) => can(role, action as keyof typeof PERMISSIONS)),
      ]),
    );

    expect(actual).toEqual(EXPECTED);
  });
});
