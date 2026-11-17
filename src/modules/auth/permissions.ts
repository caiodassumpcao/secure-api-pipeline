import type { Role } from '../../db/schema.ts';

/**
 * Permission matrix (DESIGN §2.1), encoded once. Services ask `can(role, action)`;
 * a table-driven test exercises every cell over HTTP.
 */
export const PERMISSIONS = {
  'workspace:read': ['owner', 'admin', 'member', 'viewer'],
  'workspace:update': ['owner', 'admin'],
  'workspace:delete': ['owner'],
  'member:read': ['owner', 'admin', 'member', 'viewer'],
  /** Add, change or remove members, except owners. */
  'member:manage': ['owner', 'admin'],
  /** Grant, change or revoke the owner role; granting it transfers ownership. */
  'member:manage-owners': ['owner'],
  'project:read': ['owner', 'admin', 'member', 'viewer'],
  /** Create, rename and archive projects. */
  'project:write': ['owner', 'admin'],
  'task:read': ['owner', 'admin', 'member', 'viewer'],
  /** Create and update tasks. */
  'task:write': ['owner', 'admin', 'member'],
  'task:delete-any': ['owner', 'admin'],
  /** Delete tasks the user created. */
  'task:delete-own': ['owner', 'admin', 'member'],
  'audit:read': ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  // `action` is a key of the constant table above, not user input.
  // eslint-disable-next-line security/detect-object-injection
  const allowed: readonly Role[] = PERMISSIONS[action];
  return allowed.includes(role);
}
