import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const cursorPayload = z.object({ k: z.uuid() }).strict();

/** Opaque cursor: the key of the last item of the page, base64url-encoded. */
export function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ k: key })).toString('base64url');
}

/** Returns the key held by a cursor, or `undefined` if it is not a valid cursor. */
export function decodeCursor(cursor: string): string | undefined {
  try {
    const parsed = cursorPayload.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data.k : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Query string members shared by every list endpoint. `cursor` is decoded during
 * validation, so handlers receive the key (or a 400 validation problem is sent).
 *
 * Cursors are not signed: every query is scoped to the caller's workspace, so a
 * forged cursor can only move the position inside data the caller may read.
 */
export const paginationQuery = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Page size, 1–${MAX_PAGE_SIZE}.`),
  cursor: z
    .string()
    .max(256)
    .transform((value, ctx) => {
      const key = decodeCursor(value);
      if (key === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
      return key;
    })
    .optional()
    .describe('Opaque cursor from the `nextCursor` of the previous page.'),
};

export interface PageRequest {
  readonly limit: number;
  /** Key of the last item already returned (decoded cursor). */
  readonly after?: string | undefined;
}

export interface Page<T> {
  readonly data: T[];
  readonly nextCursor: string | null;
}

/**
 * Repositories fetch `limit + 1` rows ordered by key; the extra row only tells
 * whether another page exists.
 */
export function toPage<T>(rows: readonly T[], limit: number, keyOf: (row: T) => string): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
