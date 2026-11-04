import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { loadEnv } from '../config/env.js';
import { resolveSqlitePath } from './schema.js';

declare global {
  // eslint-disable-next-line no-var
  var __hiveRouterPrisma: PrismaClient | undefined;
}

const sqliteAdapter = new PrismaBetterSqlite3({
  url: resolveSqlitePath(loadEnv().DATABASE_URL),
});

export const prisma =
  globalThis.__hiveRouterPrisma ??
  new PrismaClient({
    adapter: sqliteAdapter,
    log: ['warn', 'error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__hiveRouterPrisma = prisma;
}
