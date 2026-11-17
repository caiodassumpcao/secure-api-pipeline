/** Session and brute-force parameters (ADR-0004, ADR-0009). Changed by review, not by configuration. */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Consecutive failures from clients without a device cookie before the account locks. */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_DURATION_MS = 15 * MINUTE;

/** Failed attempts presenting a device cookie before that cookie stops being trusted. */
export const DEVICE_FAILURE_LIMIT = 5;
export const DEVICE_TTL_MS = 90 * DAY;

/** A refresh token unused for this long expires; each rotation issues a fresh one. */
export const REFRESH_TOKEN_TTL_MS = 7 * DAY;
/** Absolute lifetime of a session, whatever the rotations. */
export const SESSION_TTL_MS = 30 * DAY;
/**
 * A token rotated less than this long ago is answered 401 without revoking the
 * session: two tabs refreshing at once is not an attack.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;
