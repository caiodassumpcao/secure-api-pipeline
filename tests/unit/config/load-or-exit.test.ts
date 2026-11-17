import { describe, expect, it, vi } from 'vitest';
import { loadConfigOrExit, loadSigningKeysOrExit } from '../../../src/config/load-or-exit.ts';
import { createLogger } from '../../../src/lib/logger.ts';
import { generatePems } from '../../helpers/keys.ts';
import { LogCapture } from '../../helpers/log-capture.ts';

class Exit extends Error {}

describe('loadConfigOrExit', () => {
  it('returns the configuration when it is valid', () => {
    const config = loadConfigOrExit({ DATABASE_URL: 'postgres://app:pw@localhost/app' }, () => {
      throw new Exit();
    });

    expect(config.database.url).toBe('postgres://app:pw@localhost/app');
  });

  it('logs the issues without values and exits 1', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.fn((): never => {
      throw new Exit();
    });

    expect(() =>
      loadConfigOrExit({ DATABASE_URL: 'mysql://root:hunter2@db/app', PORT: 'x' }, exit),
    ).toThrow(Exit);

    expect(exit).toHaveBeenCalledWith(1);
    const logged = output.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).toContain('invalid configuration');
    expect(logged).toContain('DATABASE_URL');
    expect(logged).not.toContain('hunter2');
  });
});

describe('loadSigningKeysOrExit', () => {
  const config = loadConfigOrExit(
    {
      DATABASE_URL: 'postgres://app:pw@localhost/app',
      JWT_PRIVATE_KEY_FILE: 'private.pem',
      JWT_PUBLIC_KEY_FILE: 'public.pem',
    },
    () => {
      throw new Exit();
    },
  );

  it('returns the keys when the files are valid', async () => {
    const pems = generatePems();
    const files = new Map([
      ['private.pem', pems.privateKey],
      ['public.pem', pems.publicKey],
    ]);

    const keys = await loadSigningKeysOrExit(config, createLogger({ level: 'silent' }), (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    });

    expect(keys.verificationKeys).toHaveLength(1);
  });

  it('logs the issues without the key material and exits 1', async () => {
    const logs = new LogCapture();
    const exit = vi.fn((): never => {
      throw new Exit();
    });
    const readFile = () => '-----BEGIN PRIVATE KEY-----\nc2VjcmV0LWtleS1tYXRlcmlhbA==\n';

    await expect(
      loadSigningKeysOrExit(config, createLogger({ level: 'info' }, logs), readFile, exit),
    ).rejects.toThrow(Exit);

    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.lines.join('\n')).toContain('JWT_PRIVATE_KEY_FILE: not a valid PEM key');
    expect(logs.lines.join('\n')).not.toContain('c2VjcmV0');
  });
});
