import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type NodeEnv = 'development' | 'test' | 'production';

export interface Config {
  readonly env: NodeEnv;
  readonly server: { readonly host: string; readonly port: number };
  readonly log: { readonly level: LogLevel };
  readonly database: { readonly url: string };
  readonly docs: { readonly enabled: boolean };
  readonly jwt: JwtConfig;
  /** Origins allowed to call the API from a browser (CORS, refresh CSRF check). */
  readonly cors: { readonly origins: readonly string[] };
  /**
   * Proxies whose `X-Forwarded-For` is trusted to resolve the client IP: a hop
   * count or a list of addresses and CIDR ranges. Off (`false`) by default.
   */
  readonly trustProxy: TrustProxy;
}

export type TrustProxy = false | number | readonly string[];

export interface JwtConfig {
  /** Ed25519 key files (PEM). Optional here: only the API process needs them. */
  readonly privateKeyFile: string | undefined;
  readonly publicKeyFile: string | undefined;
  /** Public key of the previous signing key, accepted during a rotation. */
  readonly previousPublicKeyFile: string | undefined;
  readonly issuer: string;
  readonly audience: string;
}

/**
 * Variables that can also be provided as `<NAME>_FILE`, pointing to a file that
 * holds the value (Docker / Compose secrets).
 */
const FILE_BACKED_VARIABLES = ['DATABASE_URL'] as const;

const MAX_TRUSTED_PROXY_HOPS = 10;

/** `10.0.0.1`, `10.0.0.0/8`, `fd00::/8`: an IP address with an optional prefix length. */
function isAddressOrCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

const trustProxySchema = z.string().transform((value, ctx): number | string[] => {
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops >= 1 && hops <= MAX_TRUSTED_PROXY_HOPS) return hops;
  } else {
    const entries = value.split(',').map((entry) => entry.trim());
    if (entries.every(isAddressOrCidr)) return entries;
  }
  ctx.addIssue({
    code: 'custom',
    message: `must be a hop count (1-${MAX_TRUSTED_PROXY_HOPS}) or a comma-separated list of IP addresses or CIDR ranges`,
  });
  return z.NEVER;
});

/** `https://app.example.com`: scheme, host and optional port, nothing else. */
function isOrigin(entry: string): boolean {
  if (!URL.canParse(entry)) return false;
  const url = new URL(entry);
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === entry;
}

const corsOriginsSchema = z.string().transform((value, ctx) => {
  const origins = value.split(',').map((entry) => entry.trim());
  if (origins.every(isOrigin)) return origins;
  ctx.addIssue({
    code: 'custom',
    message: 'must be a comma-separated list of origins (scheme://host[:port], no path)',
  });
  return z.NEVER;
});

/** Passwords that must never reach production (dev defaults and common guesses). */
const WEAK_DATABASE_PASSWORDS = new Set([
  'admin',
  'app',
  'changeme',
  'change-me',
  'dev',
  'password',
  'postgres',
  'root',
  'secret',
  'test',
]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // Defaults to enabled outside production (resolved below).
    API_DOCS_ENABLED: z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .transform((value) => value === 'true')
      .optional(),
    JWT_PRIVATE_KEY_FILE: z.string().optional(),
    JWT_PUBLIC_KEY_FILE: z.string().optional(),
    JWT_PREVIOUS_PUBLIC_KEY_FILE: z.string().optional(),
    JWT_ISSUER: z.string().min(1).default('secure-api-pipeline'),
    JWT_AUDIENCE: z.string().min(1).default('secure-api-pipeline'),
    CORS_ORIGINS: corsOriginsSchema.optional(),
    // `true` (trust any proxy) is deliberately not accepted: it would let any
    // client choose its IP and evade per-IP rate limits.
    TRUST_PROXY: trustProxySchema.optional(),
    // Error messages must never echo the value: the URL carries credentials.
    DATABASE_URL: z.url({
      protocol: /^postgres(ql)?$/,
      error: (issue) =>
        issue.input === undefined ? 'is required' : 'must be a postgres:// or postgresql:// URL',
    }),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === 'production' &&
      env.CORS_ORIGINS?.some((origin) => !origin.startsWith('https:'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'must only list https:// origins in production',
      });
    }
    // zod still runs this refinement when the URL check failed (non-aborting
    // issue). Never let it throw: Node's URL errors carry the input, password
    // included, in their `input` property.
    if (env.NODE_ENV !== 'production' || !URL.canParse(env.DATABASE_URL)) return;
    const password = decodePassword(new URL(env.DATABASE_URL).password);
    if (typeof password !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'the password must be percent-encoded',
      });
      return;
    }
    if (password === '' || WEAK_DATABASE_PASSWORDS.has(password.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must not use an empty or default password in production',
      });
    }
  });

function decodePassword(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type ReadFile = (path: string) => string;

// The path comes from the operator-controlled environment, not from user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const readFileUtf8: ReadFile = (path) => readFileSync(path, 'utf8');

/**
 * Builds the typed configuration from environment variables.
 *
 * Empty values are treated as unset, `<NAME>_FILE` variables are resolved, and
 * every problem is reported at once. Messages name the variable but never its
 * value, so they are safe to log.
 *
 * @throws {ConfigError} when the environment is invalid.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadFile = readFileUtf8,
): Config {
  const issues: string[] = [];
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') values.set(name, value);
  }

  for (const name of FILE_BACKED_VARIABLES) {
    const fileVariable = `${name}_FILE`;
    const path = values.get(fileVariable);
    if (path === undefined) continue;
    if (values.has(name)) {
      issues.push(`${name}: set either ${name} or ${fileVariable}, not both`);
      continue;
    }
    try {
      values.set(name, readFile(path).trim());
    } catch {
      issues.push(`${fileVariable}: cannot read the file`);
    }
  }

  let result: ReturnType<typeof envSchema.safeParse>;
  try {
    result = envSchema.safeParse(Object.fromEntries(values));
  } catch {
    // Defence in depth: an unexpected error could carry a raw value.
    throw new ConfigError([...issues, 'the configuration could not be validated']);
  }
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.');
      issues.push(path === '' ? issue.message : `${path}: ${issue.message}`);
    }
  }
  if (!result.success || issues.length > 0) throw new ConfigError(issues);

  const parsed = result.data;
  return {
    env: parsed.NODE_ENV,
    server: { host: parsed.HOST, port: parsed.PORT },
    log: { level: parsed.LOG_LEVEL },
    database: { url: parsed.DATABASE_URL },
    docs: { enabled: parsed.API_DOCS_ENABLED ?? parsed.NODE_ENV !== 'production' },
    jwt: {
      privateKeyFile: parsed.JWT_PRIVATE_KEY_FILE,
      publicKeyFile: parsed.JWT_PUBLIC_KEY_FILE,
      previousPublicKeyFile: parsed.JWT_PREVIOUS_PUBLIC_KEY_FILE,
      issuer: parsed.JWT_ISSUER,
      audience: parsed.JWT_AUDIENCE,
    },
    cors: { origins: parsed.CORS_ORIGINS ?? [] },
    trustProxy: parsed.TRUST_PROXY ?? false,
  };
}
