import { resolve } from 'node:path';

export function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error('Unsupported DATABASE_URL for sqlite bootstrap: ' + databaseUrl);
  }

  const rawPath = databaseUrl.slice('file:'.length).split('?', 1)[0] ?? '';
  return rawPath.startsWith('/') ? rawPath : resolve(process.cwd(), rawPath);
}
