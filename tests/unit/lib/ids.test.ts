import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createUuidV7Generator, uuidv7 } from '../../../src/lib/ids.ts';

const timestampOf = (id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);

/** A generator whose clock returns the given values, then repeats the last one. */
function generatorWithClock(...times: number[]) {
  let index = 0;
  return createUuidV7Generator(() => times[Math.min(index++, times.length - 1)]!);
}

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 UUIDs', () => {
    const id = uuidv7();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(z.uuid().safeParse(id).success).toBe(true);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);

    expect(timestampOf(generatorWithClock(now)())).toBe(now);
  });

  it('sorts by creation time', () => {
    const next = generatorWithClock(1_000, 2_000, 3_000);
    const ids = [next(), next(), next()];

    expect([...ids].reverse().sort()).toEqual(ids);
  });

  it('strictly increases within one millisecond, past the counter capacity', () => {
    const next = generatorWithClock(42);
    const ids = Array.from({ length: 5_000 }, () => next());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    // 4,096 counter values at most per millisecond: the next one is borrowed.
    expect(timestampOf(ids.at(-1)!)).toBeGreaterThan(42);
  });

  it('keeps increasing when the system clock steps back', () => {
    const next = generatorWithClock(5_000, 1_000);

    const before = next();
    const after = next();

    expect(after > before).toBe(true);
    expect(timestampOf(after)).toBe(5_000);
  });
});
