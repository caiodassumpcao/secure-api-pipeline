import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  paginationQuery,
  toPage,
} from '../../../src/lib/pagination.ts';

const LAST_ID = '0190f3b2-7c1e-7d2a-9f00-1234567890ab';
const query = z.object(paginationQuery).strict();

describe('cursors', () => {
  it('round-trips a key as an opaque, URL-safe string', () => {
    const cursor = encodeCursor(LAST_ID);

    expect(cursor).toMatch(/^[\w-]+$/);
    expect(cursor).not.toContain(LAST_ID);
    expect(decodeCursor(cursor)).toBe(LAST_ID);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['valid base64 but not JSON', Buffer.from('hello').toString('base64url')],
    ['JSON without a key', Buffer.from('{}').toString('base64url')],
    ['a key that is not a UUID', Buffer.from('{"k":"1 OR 1=1"}').toString('base64url')],
    ['extra members', Buffer.from(`{"k":"${LAST_ID}","x":1}`).toString('base64url')],
  ])('rejects %s', (_case, cursor) => {
    expect(decodeCursor(cursor)).toBeUndefined();
  });
});

describe('paginationQuery', () => {
  it('defaults the page size and decodes the cursor', () => {
    expect(query.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE });
    expect(query.parse({ limit: '5', cursor: encodeCursor(LAST_ID) })).toEqual({
      limit: 5,
      cursor: LAST_ID,
    });
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: '2.5' }, { cursor: 'nope' }])(
    'rejects %o',
    (input) => {
      expect(query.safeParse(input).success).toBe(false);
    },
  );
});

describe('toPage', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns a cursor when an extra row shows there is a next page', () => {
    const page = toPage(rows, 2, (row) => row.id);

    expect(page.data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toBeUndefined(); // 'b' is not a UUID key
  });

  it('returns no cursor on the last page', () => {
    expect(toPage(rows, 3, (row) => row.id)).toEqual({ data: rows, nextCursor: null });
    expect(toPage([], 3, (row: { id: string }) => row.id)).toEqual({ data: [], nextCursor: null });
  });
});
