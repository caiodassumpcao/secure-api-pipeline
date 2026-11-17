import { createLocalJWKSet, errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { ACCESS_TOKEN_ALGORITHM, type SigningKeys } from './keys.ts';

/** Access tokens are short-lived: there is no revocation list (ADR-0004). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Leeway for clock differences between the API instances. */
export const CLOCK_TOLERANCE_SECONDS = 5;

/** RFC 9068 media type, so an access token is never mistaken for another JWT. */
const ACCESS_TOKEN_TYPE = 'at+jwt';

export interface AccessToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export interface TokenService {
  issueAccessToken(userId: string): Promise<AccessToken>;
  /** The user id of a valid access token, or `null` for anything else. */
  verifyAccessToken(token: string): Promise<string | null>;
}

export interface TokenServiceOptions {
  readonly keys: SigningKeys;
  readonly issuer: string;
  readonly audience: string;
  readonly clock?: () => number;
}

const subjectSchema = z.uuid();

/**
 * Ed25519 access tokens. They identify the user and nothing else: roles are
 * read from the database on every request (ADR-0005), so a membership change
 * applies immediately. Verification pins the algorithm, the token type, the
 * issuer and the audience, and selects the key by `kid`.
 */
export function createTokenService({
  keys,
  issuer,
  audience,
  clock = Date.now,
}: TokenServiceOptions): TokenService {
  const keySet = createLocalJWKSet({ keys: [...keys.verificationKeys] });

  return {
    async issueAccessToken(userId) {
      const now = Math.floor(clock() / 1000);
      const accessToken = await new SignJWT({})
        .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: keys.kid, typ: ACCESS_TOKEN_TYPE })
        .setSubject(userId)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
        .sign(keys.privateKey);
      return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
    },

    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          typ: ACCESS_TOKEN_TYPE,
          issuer,
          audience,
          requiredClaims: ['sub', 'iat', 'exp'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: new Date(clock()),
        });
        const subject = subjectSchema.safeParse(payload.sub);
        return subject.success ? subject.data : null;
      } catch (error) {
        if (error instanceof errors.JOSEError) return null;
        throw error;
      }
    },
  };
}
