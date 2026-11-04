// Bundled in Router and IAM instead of node:sqlite. Keep all same-process
// database handles on the SQLite library used by their Prisma adapter.
import { createRequire } from 'node:module';
interface Handle {
  open: boolean;
  exec(sql: string): unknown;
  close(): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
  };
  backup(file: string, options?: { progress: () => void }): Promise<void>;
}
export class DatabaseSync {
  readonly raw: Handle;
  constructor(
    file: string,
    options: { readOnly?: boolean; enableForeignKeyConstraints?: boolean } = {},
  ) {
    const SQLite = createRequire(import.meta.url)('better-sqlite3') as new (
      file: string,
      options: Record<string, unknown>,
    ) => Handle;
    this.raw = new SQLite(file, {
      readonly: options.readOnly === true,
      fileMustExist: options.readOnly === true,
    });
    if (options.enableForeignKeyConstraints) this.raw.exec('PRAGMA foreign_keys=ON');
  }
  get isOpen(): boolean {
    return this.raw.open;
  }
  prepare(sql: string) {
    return this.raw.prepare(sql);
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  close(): void {
    this.raw.close();
  }
}
export async function backup(
  db: DatabaseSync,
  file: string,
  options?: { progress: () => void },
): Promise<void> {
  await db.raw.backup(file, options);
}
