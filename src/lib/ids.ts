import { randomBytes, randomInt } from 'node:crypto';

/** Largest value of the 12-bit counter held in `rand_a`. */
const COUNTER_MAX = 0xfff;

/**
 * Returns a UUID version 7 (RFC 9562) generator: a 48-bit Unix timestamp in
 * milliseconds, a 12-bit counter, then random bits. Ids sort by creation time,
 * so they double as the keyset for cursor pagination, and they do not reveal
 * counts the way serial ids do.
 *
 * Ids strictly increase within the process (RFC 9562 §6.2, method 1): the
 * counter orders ids created in the same millisecond, and when the system
 * clock steps back the generator keeps the last timestamp until it catches up.
 */
export function createUuidV7Generator(clock: () => number = Date.now): () => string {
  let lastMs = -1;
  let counter = 0;

  return () => {
    const now = clock();
    if (now > lastMs) {
      lastMs = now;
      // Random seed with the top bit clear, leaving room for increments.
      counter = randomInt(0, (COUNTER_MAX + 1) / 2);
    } else {
      counter += 1;
      if (counter > COUNTER_MAX) {
        // Counter exhausted: borrow the next millisecond.
        lastMs += 1;
        counter = 0;
      }
    }

    const bytes = randomBytes(16);
    bytes.writeUIntBE(lastMs, 0, 6);
    bytes.writeUInt16BE(0x7000 | counter, 6); // version 7, counter in rand_a
    bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // variant 10
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** Process-wide generator used for primary keys. */
export const uuidv7: () => string = createUuidV7Generator();
