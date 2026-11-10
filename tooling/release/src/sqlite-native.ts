// Keep recovery and application handles on the same patched SQLite engine.
// Load from the owning product's exact production dependency, without install scripts.
import { createRequire } from 'node:module';
interface Handle {
  isOpen: boolean;
  exec(sql: string): unknown;
  close(): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
  };
}
interface Driver {
  DatabaseSync: new (file: string, options: Record<string, unknown>) => Handle;
  backup(db: Handle, file: string, options?: { progress: () => void }): Promise<unknown>;
}
const driver = () => createRequire(import.meta.url)('@photostructure/sqlite') as Driver;
export class DatabaseSync {
  readonly raw: Handle;
  constructor(file: string, options: { readOnly?: boolean; enableForeignKeyConstraints?: boolean } = {}) {
    this.raw = new (driver().DatabaseSync)(file, { readOnly: options.readOnly === true,
      enableForeignKeyConstraints: options.enableForeignKeyConstraints ?? false });
    try {
      const version = this.raw.prepare('SELECT sqlite_version() AS version').get()?.version;
      const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
      if (!match || !(Number(match[1]) > 3 || (Number(match[1]) === 3 && (Number(match[2]) > 54 || (Number(match[2]) === 54 && Number(match[3]) >= 1))))) {
        throw new Error('Recovery requires embedded SQLite 3.54.1 or later');
      }
    } catch (error) { this.raw.close(); throw error; }
  }
  get isOpen(): boolean { return this.raw.isOpen; }
  prepare(sql: string) { return this.raw.prepare(sql); }
  exec(sql: string): void { this.raw.exec(sql); }
  close(): void { if (this.raw.isOpen) this.raw.close(); }
}
export async function backup(db: DatabaseSync, file: string, options?: { progress: () => void }): Promise<void> {
  await driver().backup(db.raw, file, options);
}
