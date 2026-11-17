import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestMigration, MIGRATIONS_FOLDER } from '../../../src/db/migrations.ts';

function folderWithJournal(journal: unknown): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrations-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  return folder;
}

describe('latestMigration', () => {
  it('returns the newest `when` of the journal', () => {
    const folder = folderWithJournal({
      entries: [
        { tag: '0000_a', when: 100 },
        { tag: '0001_b', when: 300 },
        { tag: '0002_c', when: 200 },
      ],
    });

    expect(latestMigration(folder)).toBe(300);
  });

  it('reads the committed migrations by default', () => {
    expect(latestMigration()).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(MIGRATIONS_FOLDER).toMatch(/drizzle$/);
  });

  it('rejects an empty or malformed journal', () => {
    expect(() => latestMigration(folderWithJournal({ entries: [] }))).toThrow();
    expect(() => latestMigration(folderWithJournal({ entries: [{ tag: 'x' }] }))).toThrow();
  });
});
