import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { BLOCKLIST } from './blocklist.ts';
import { codePointLength, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-rules.ts';

/**
 * argon2id parameters: the OWASP baseline (19 MiB, 2 passes, 1 lane). Hashing
 * runs on libuv's thread pool (4 threads by default), which caps concurrent
 * hashes and so their memory. The parameters are stored in each hash (PHC
 * string), so raising them only rehashes on the next login.
 */
export interface Argon2Params {
  /** KiB. */
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  /** Bytes. */
  readonly outputLen: number;
}

export const ARGON2_PARAMS: Argon2Params = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /**
   * Checks a password against a stored hash; `null` checks it against a dummy
   * hash and returns false, so a missing or locked account costs the same time.
   */
  verify(passwordHash: string | null, password: string): Promise<boolean>;
  /** Whether a hash was made with other parameters and should be replaced. */
  needsRehash(passwordHash: string): boolean;
}

/** Unicode normalization applied before hashing and checking (NIST SP 800-63B). */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

const PHC_PARAMS = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

export function createPasswordHasher(params: Argon2Params = ARGON2_PARAMS): PasswordHasher {
  let dummy: Promise<string> | undefined;
  const dummyHash = () => (dummy ??= hash(randomBytes(32), params));

  return {
    hash: (password) => hash(normalizePassword(password), params),

    async verify(passwordHash, password) {
      const target = passwordHash ?? (await dummyHash());
      try {
        const matches = await verify(target, normalizePassword(password));
        return passwordHash !== null && matches;
      } catch {
        // A malformed stored hash never matches.
        return false;
      }
    },

    needsRehash(passwordHash) {
      const match = PHC_PARAMS.exec(passwordHash);
      return (
        match === null ||
        Number(match[1]) !== params.memoryCost ||
        Number(match[2]) !== params.timeCost ||
        Number(match[3]) !== params.parallelism
      );
    },
  };
}

/**
 * Password policy (DESIGN §5.1, NIST SP 800-63B): length in code points, no
 * entry of the breached-password blocklist, nothing derived from the email
 * address. No composition rules: they do not make passwords stronger.
 * Returns the problems found, empty when the password is acceptable.
 */
export function passwordPolicyIssues(password: string, context: { email: string }): string[] {
  const normalized = normalizePassword(password);
  const length = codePointLength(normalized);
  if (length < PASSWORD_MIN_LENGTH) return [`Must have at least ${PASSWORD_MIN_LENGTH} characters`];
  if (length > PASSWORD_MAX_LENGTH) return [`Must have at most ${PASSWORD_MAX_LENGTH} characters`];

  const issues: string[] = [];
  const lower = normalized.toLowerCase();
  if (BLOCKLIST.has(lower)) issues.push('Too common: it appears in lists of breached passwords');
  const localPart = context.email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && lower.includes(localPart)) {
    issues.push('Must not contain your email address');
  }
  return issues;
}
