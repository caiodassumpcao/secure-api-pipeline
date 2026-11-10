import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel } from '../config/config.ts';

export const REDACTED = '[REDACTED]';

/**
 * Keys whose values must never be written to logs. Path-based redaction is
 * exact-case and has a fixed depth: keys are matched at the top level and up to
 * three levels deep, which covers `headers.*`, `req.headers.*`, `body.*` and
 * HTTP client errors such as `err.config.headers.*`.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
] as const;

export const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => [
  `["${key}"]`,
  `*["${key}"]`,
  `*.*["${key}"]`,
  `*.*.*["${key}"]`,
]);

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

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number } | null;
}

/** Replaces Fastify's default `req` serializer: same fields, sanitized URL, no headers. */
function serializeRequest(request: LoggedRequest) {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export interface LoggerConfig {
  readonly level: LogLevel;
}

/**
 * JSON logger shared by the HTTP server and the rest of the process. Secrets are
 * redacted by path (see {@link REDACT_PATHS}) and in request URLs; unit tests
 * guard both.
 */
export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers: { req: serializeRequest },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
