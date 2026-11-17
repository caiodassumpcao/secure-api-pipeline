/**
 * URL redaction shared by the logger and the telemetry preload. Kept apart from
 * the logger so the preload can use it without importing pino before the
 * instrumentation patches it.
 */

export const REDACTED = '[REDACTED]';

/** Query parameters whose values are masked in logged URLs (compared case-insensitively). */
const SENSITIVE_QUERY_PARAMETERS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'code',
  'id_token',
  'password',
  'refresh_token',
  'secret',
  'signature',
  'token',
]);

function decodeQueryName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replaceAll('+', ' '));
  } catch {
    return rawName;
  }
}

/** Masks the values of sensitive query parameters, keeping everything else as sent. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const query = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      const rawName = separator === -1 ? pair : pair.slice(0, separator);
      return SENSITIVE_QUERY_PARAMETERS.has(decodeQueryName(rawName).toLowerCase())
        ? `${rawName}=${REDACTED}`
        : pair;
    })
    .join('&');
  return `${url.slice(0, queryStart)}?${query}`;
}
