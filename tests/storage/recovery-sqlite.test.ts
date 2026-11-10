import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '@photostructure/sqlite';
import { expect, it } from 'vitest';
import { backupSqlite } from '../../src/release/runtime.js';

it('the bundled recovery engine backs up committed WAL records and refuses overwrite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-recovery-fixture-'));
  const source = join(directory, 'source.sqlite');
  const destination = join(directory, 'backup.sqlite');
  const writer = new DatabaseSync(source);
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO retained VALUES(1,'committed'); BEGIN IMMEDIATE; INSERT INTO retained VALUES(2,'uncommitted')");
    await backupSqlite(source, destination);
    const reader = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(reader.prepare('SELECT id,value FROM retained').all()).toEqual([{ id: 1, value: 'committed' }]);
      expect(reader.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { reader.close(); }
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    await expect(backupSqlite(source, destination)).rejects.toThrow();
    writer.exec('ROLLBACK');
    expect(writer.prepare('SELECT count(*) AS count FROM retained').get()).toEqual({ count: 1 });
  } finally { writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
