import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, type ReadFile } from '../../../src/config/config.ts';

const DATABASE_URL = 'postgres://app:s3cr3t-Pa55@db.internal:5432/app';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

const noFiles: ReadFile = () => {
  throw new Error('unexpected file read');
};

describe('loadConfig', () => {
  it('applies defaults when only the database URL is set', () => {
    expect(loadConfig({ DATABASE_URL }, noFiles)).toEqual({
      env: 'development',
      server: { host: '127.0.0.1', port: 3000 },
      log: { level: 'info' },
      database: { url: DATABASE_URL },
      docs: { enabled: true },
      jwt: {
        privateKeyFile: undefined,
        publicKeyFile: undefined,
        previousPublicKeyFile: undefined,
        issuer: 'secure-api-pipeline',
        audience: 'secure-api-pipeline',
      },
      cors: { origins: [] },
      trustProxy: false,
    });
  });

  it('reads every supported variable', () => {
    const config = loadConfig(
      {
        NODE_ENV: 'test',
        HOST: '0.0.0.0',
        PORT: '8080',
        LOG_LEVEL: 'debug',
        DATABASE_URL,
        JWT_PRIVATE_KEY_FILE: '/run/secrets/jwt_private_key',
        JWT_PUBLIC_KEY_FILE: '/run/secrets/jwt_public_key',
        JWT_PREVIOUS_PUBLIC_KEY_FILE: '/run/secrets/jwt_previous_public_key',
        JWT_ISSUER: 'https://api.example.com',
        JWT_AUDIENCE: 'example-clients',
        CORS_ORIGINS: 'https://app.example.com, http://localhost:5173',
        TRUST_PROXY: '1',
      },
      noFiles,
    );

    expect(config).toEqual({
      env: 'test',
      server: { host: '0.0.0.0', port: 8080 },
      log: { level: 'debug' },
      database: { url: DATABASE_URL },
      docs: { enabled: true },
      jwt: {
        privateKeyFile: '/run/secrets/jwt_private_key',
        publicKeyFile: '/run/secrets/jwt_public_key',
        previousPublicKeyFile: '/run/secrets/jwt_previous_public_key',
        issuer: 'https://api.example.com',
        audience: 'example-clients',
      },
      cors: { origins: ['https://app.example.com', 'http://localhost:5173'] },
      trustProxy: 1,
    });
  });

  describe('TRUST_PROXY', () => {
    it.each([
      ['1', 1],
      ['10', 10],
      ['10.0.0.1', ['10.0.0.1']],
      ['10.0.0.0/8, 172.16.0.0/12,fd00::/8', ['10.0.0.0/8', '172.16.0.0/12', 'fd00::/8']],
    ])('accepts %s', (value, expected) => {
      expect(loadConfig({ DATABASE_URL, TRUST_PROXY: value }, noFiles).trustProxy).toEqual(
        expected,
      );
    });

    it.each([
      'true',
      'false',
      '*',
      '0',
      '11',
      '-1',
      'proxy.internal',
      '10.0.0.0/33',
      '10.0.0.1/8/1',
    ])('rejects %s: only hop counts and addresses are trusted, never any proxy', (value) => {
      expect(
        configError(() => loadConfig({ DATABASE_URL, TRUST_PROXY: value }, noFiles)).issues,
      ).toEqual([
        'TRUST_PROXY: must be a hop count (1-10) or a comma-separated list of IP addresses or CIDR ranges',
      ]);
    });
  });

  describe('CORS_ORIGINS', () => {
    it.each([
      'https://app.example.com/',
      'https://app.example.com/path',
      'ftp://files.example.com',
      '*',
    ])('rejects %s', (value) => {
      expect(
        configError(() => loadConfig({ DATABASE_URL, CORS_ORIGINS: value }, noFiles)).issues,
      ).toEqual([
        'CORS_ORIGINS: must be a comma-separated list of origins (scheme://host[:port], no path)',
      ]);
    });

    it('requires https origins in production', () => {
      const env = {
        NODE_ENV: 'production',
        DATABASE_URL,
        CORS_ORIGINS: 'https://app.example.com,http://app.example.com',
      };

      expect(configError(() => loadConfig(env, noFiles)).issues).toEqual([
        'CORS_ORIGINS: must only list https:// origins in production',
      ]);
    });
  });

  describe('API docs', () => {
    it('are disabled by default in production', () => {
      expect(loadConfig({ NODE_ENV: 'production', DATABASE_URL }, noFiles).docs.enabled).toBe(
        false,
      );
    });

    it('can be enabled explicitly in production', () => {
      const env = { NODE_ENV: 'production', API_DOCS_ENABLED: 'true', DATABASE_URL };
      expect(loadConfig(env, noFiles).docs.enabled).toBe(true);
    });

    it('can be disabled outside production', () => {
      expect(loadConfig({ API_DOCS_ENABLED: 'false', DATABASE_URL }, noFiles).docs.enabled).toBe(
        false,
      );
    });

    it('rejects values other than true or false', () => {
      expect(
        configError(() => loadConfig({ API_DOCS_ENABLED: 'yes', DATABASE_URL }, noFiles)).issues,
      ).toEqual(['API_DOCS_ENABLED: must be true or false']);
    });
  });

  it('accepts the postgresql:// scheme', () => {
    const url = 'postgresql://app:pw@localhost/app';
    expect(loadConfig({ DATABASE_URL: url }, noFiles).database.url).toBe(url);
  });

  it('treats empty values as unset', () => {
    const config = loadConfig({ DATABASE_URL, LOG_LEVEL: '', PORT: '' }, noFiles);

    expect(config.log.level).toBe('info');
    expect(config.server.port).toBe(3000);
  });

  it('requires DATABASE_URL', () => {
    expect(configError(() => loadConfig({}, noFiles)).issues).toEqual([
      'DATABASE_URL: is required',
    ]);
  });

  it('reports every invalid variable at once', () => {
    const error = configError(() =>
      loadConfig(
        { NODE_ENV: 'staging', PORT: '70000', LOG_LEVEL: 'verbose', DATABASE_URL },
        noFiles,
      ),
    );

    expect(error.issues).toHaveLength(3);
    expect(error.issues.map((issue) => issue.split(':')[0])).toEqual([
      'NODE_ENV',
      'PORT',
      'LOG_LEVEL',
    ]);
    expect(error.message).toContain('Invalid configuration:\n  - NODE_ENV:');
  });

  it.each(['abc', '0', '1.5'])('rejects PORT=%s', (port) => {
    expect(configError(() => loadConfig({ PORT: port, DATABASE_URL }, noFiles)).issues).toEqual([
      expect.stringMatching(/^PORT: /),
    ]);
  });

  it('rejects a non-PostgreSQL URL without echoing it', () => {
    const error = configError(() =>
      loadConfig({ DATABASE_URL: 'mysql://root:hunter2-secret@db/app' }, noFiles),
    );

    expect(error.issues).toEqual(['DATABASE_URL: must be a postgres:// or postgresql:// URL']);
    expect(error.message).not.toContain('hunter2-secret');
  });

  it('rejects a malformed URL without echoing it', () => {
    const error = configError(() => loadConfig({ DATABASE_URL: 'not a url hunter2' }, noFiles));

    expect(error.issues).toEqual(['DATABASE_URL: must be a postgres:// or postgresql:// URL']);
    expect(error.message).not.toContain('hunter2');
  });

  describe('file-backed variables', () => {
    it('reads DATABASE_URL_FILE and trims the trailing newline', () => {
      const readFile = vi.fn<ReadFile>(() => `${DATABASE_URL}\n`);

      const config = loadConfig({ DATABASE_URL_FILE: '/run/secrets/database_url' }, readFile);

      expect(readFile).toHaveBeenCalledWith('/run/secrets/database_url');
      expect(config.database.url).toBe(DATABASE_URL);
    });

    it('rejects setting both DATABASE_URL and DATABASE_URL_FILE', () => {
      const error = configError(() =>
        loadConfig({ DATABASE_URL, DATABASE_URL_FILE: '/run/secrets/database_url' }, noFiles),
      );

      expect(error.issues).toEqual([
        'DATABASE_URL: set either DATABASE_URL or DATABASE_URL_FILE, not both',
      ]);
    });

    it('reports an unreadable file without its contents or the OS error', () => {
      const readFile: ReadFile = () => {
        throw new Error('EACCES: permission denied, open /run/secrets/database_url');
      };

      const error = configError(() =>
        loadConfig({ DATABASE_URL_FILE: '/run/secrets/database_url' }, readFile),
      );

      expect(error.issues).toEqual([
        'DATABASE_URL_FILE: cannot read the file',
        'DATABASE_URL: is required',
      ]);
    });

    it('validates the value read from the file', () => {
      const error = configError(() =>
        loadConfig({ DATABASE_URL_FILE: '/run/secrets/database_url' }, () => 'redis://x:secret@h'),
      );

      expect(error.issues).toEqual(['DATABASE_URL: must be a postgres:// or postgresql:// URL']);
    });
  });

  describe('in production', () => {
    it('accepts a database URL with a strong password', () => {
      const config = loadConfig({ NODE_ENV: 'production', DATABASE_URL }, noFiles);
      expect(config.env).toBe('production');
    });

    it.each([
      ['an empty password', 'postgres://app@db/app'],
      ['a default password', 'postgres://app:postgres@db/app'],
      ['a default password in another case', 'postgres://app:ChangeMe@db/app'],
      ['a percent-encoded default password', 'postgres://app:chan%67e-me@db/app'],
    ])('refuses %s', (_case, url) => {
      const error = configError(() =>
        loadConfig({ NODE_ENV: 'production', DATABASE_URL: url }, noFiles),
      );

      expect(error.issues).toEqual([
        'DATABASE_URL: must not use an empty or default password in production',
      ]);
    });

    it.each([
      [
        'an unencoded "/" in the password',
        'postgres://app:Zk9/Qw-Prod-Secret@db.internal:5432/app',
      ],
      ['an unencoded "#" in the password', 'postgres://app:Prod#Secret@db.internal:5432/app'],
      ['garbage', 'not a url Prod-Secret'],
    ])('reports an unparsable URL with %s without echoing it', (_case, url) => {
      const error = configError(() =>
        loadConfig({ NODE_ENV: 'production', DATABASE_URL: url }, noFiles),
      );

      expect(error.issues).toEqual(['DATABASE_URL: must be a postgres:// or postgresql:// URL']);
      expect(JSON.stringify(error)).not.toContain('Secret');
      expect(error.message).not.toContain('Secret');
    });

    it('reports a password that is not valid percent-encoding', () => {
      const error = configError(() =>
        loadConfig(
          { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:S3c%zzret@db/app' },
          noFiles,
        ),
      );

      expect(error.issues).toEqual(['DATABASE_URL: the password must be percent-encoded']);
      expect(error.message).not.toContain('S3c');
    });

    it('allows default passwords outside production', () => {
      expect(() =>
        loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://app:postgres@db/app' }),
      ).not.toThrow();
    });
  });
});
