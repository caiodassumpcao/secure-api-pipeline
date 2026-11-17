/** Password length bounds, in Unicode code points after NFKC normalization (DESIGN §5.1). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Length in Unicode code points, the unit NIST SP 800-63B counts characters in.
 * Unlike `string.length`, an emoji or a letter outside the BMP counts as one.
 */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}
