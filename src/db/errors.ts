import { DrizzleQueryError } from 'drizzle-orm';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

interface DatabaseErrorFields {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function fieldsOf(error: unknown): DatabaseErrorFields {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  return typeof cause === 'object' && cause !== null ? cause : {};
}

function violates(error: unknown, code: string, constraint: string): boolean {
  const fields = fieldsOf(error);
  return fields.code === code && fields.constraint === constraint;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return violates(error, UNIQUE_VIOLATION, constraint);
}

export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return violates(error, FOREIGN_KEY_VIOLATION, constraint);
}
