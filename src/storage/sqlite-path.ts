import { resolve } from 'node:path';

export const SQLITE_DATABASE_URL_ERROR = 'DATABASE_URL must be a SQLite file: URL, for example file:/var/lib/hive/router.db';

export function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(SQLITE_DATABASE_URL_ERROR);
  }

  const rawPath = databaseUrl.slice('file:'.length).split('?', 1)[0] ?? '';
  return rawPath.startsWith('/') ? rawPath : resolve(process.cwd(), rawPath);
}
