import { describe, expect, it } from 'vitest';
import { buildBlocklist } from '../../../../scripts/build-blocklist.ts';
import { BLOCKLIST } from '../../../../src/modules/auth/blocklist.ts';
import { codePointLength } from '../../../../src/modules/auth/password-rules.ts';
import {
  ARGON2_PARAMS,
  createPasswordHasher,
  passwordPolicyIssues,
} from '../../../../src/modules/auth/password.ts';

const hasher = createPasswordHasher();
const PASSWORD = 'correct horse battery staple';

describe('password hasher', () => {
  it('hashes with argon2id and the configured parameters', async () => {
    const hashed = await hasher.hash(PASSWORD);

    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[\w+/]+\$[\w+/]+$/);
    expect(hasher.needsRehash(hashed)).toBe(false);
  });

  it('verifies the right password only', async () => {
    const hashed = await hasher.hash(PASSWORD);

    expect(await hasher.verify(hashed, PASSWORD)).toBe(true);
    expect(await hasher.verify(hashed, `${PASSWORD}!`)).toBe(false);
  });

  it('normalizes Unicode before hashing (NFKC)', async () => {
    const hashed = await hasher.hash('ｃｏｒｒｅｃｔ horse battery'); // full-width letters

    expect(await hasher.verify(hashed, 'correct horse battery')).toBe(true);
  });

  it('checks against a dummy hash when there is no stored one, and never matches', async () => {
    expect(await hasher.verify(null, PASSWORD)).toBe(false);
  });

  it('treats a malformed stored hash as a mismatch', async () => {
    expect(await hasher.verify('not-a-hash', PASSWORD)).toBe(false);
  });

  it('asks to rehash hashes made with other parameters', async () => {
    const weaker = createPasswordHasher({ ...ARGON2_PARAMS, memoryCost: 8_192 });

    expect(hasher.needsRehash(await weaker.hash(PASSWORD))).toBe(true);
    expect(hasher.needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
  });
});

describe('password policy', () => {
  const email = 'ana.silva@example.com';

  it('accepts a long passphrase', () => {
    expect(passwordPolicyIssues(PASSWORD, { email })).toEqual([]);
  });

  it.each([
    ['eleven char', 'Must have at least 12 characters'],
    ['x'.repeat(129), 'Must have at most 128 characters'],
    ['Q1W2E3R4T5Y6', 'Too common: it appears in lists of breached passwords'],
    ['my ana.silva password', 'Must not contain your email address'],
  ])('rejects %j', (password, issue) => {
    expect(passwordPolicyIssues(password, { email })).toEqual([issue]);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(passwordPolicyIssues('🔒'.repeat(12), { email })).toEqual([]);
    expect(passwordPolicyIssues('🔒'.repeat(11), { email })).toEqual([
      'Must have at least 12 characters',
    ]);
  });
});

describe('blocklist', () => {
  it('holds normalized entries the length rule alone would accept', () => {
    expect(BLOCKLIST.size).toBeGreaterThan(1_000);
    for (const entry of BLOCKLIST) {
      expect(entry).toBe(entry.normalize('NFKC').toLowerCase());
      expect(codePointLength(entry)).toBeGreaterThanOrEqual(12);
    }
  });

  it('is built by keeping, normalizing and deduplicating long entries', () => {
    expect(buildBlocklist('short\nLongPassword123\nlongpassword123\r\nuse`backtick`now\n')).toEqual(
      ['longpassword123'],
    );
  });
});
