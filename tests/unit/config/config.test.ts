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
    });
  });

  it('reads every supported variable', () => {
    const config = loadConfig(
      { NODE_ENV: 'test', HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'debug', DATABASE_URL },
      noFiles,
    );

    expect(config).toEqual({
      env: 'test',
      server: { host: '0.0.0.0', port: 8080 },
      log: { level: 'debug' },
      database: { url: DATABASE_URL },
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
