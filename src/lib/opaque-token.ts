import { createHash, randomBytes } from 'node:crypto';
import { textSchema } from './schemas.ts';

/**
 * Random bearer secret (refresh tokens, device cookies, invitation links):
 * 256 bits, base64url. Only its SHA-256 is stored, so a database leak does not
 * hand out usable tokens; a fast hash is enough for 256 random bits.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex SHA-256 under which an opaque token is stored and looked up. */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Shape of a token from {@link generateOpaqueToken}; anything else is rejected unread. */
export const opaqueTokenSchema = textSchema.regex(/^[\w-]{43}$/);
