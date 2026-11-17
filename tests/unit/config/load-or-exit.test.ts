import { describe, expect, it, vi } from 'vitest';
import { loadConfigOrExit } from '../../../src/config/load-or-exit.ts';

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
