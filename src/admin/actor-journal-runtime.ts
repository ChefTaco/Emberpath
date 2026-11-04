import Database from 'better-sqlite3';
import { loadEnv } from '../config/env.js';
import { resolveSqlitePath } from '../storage/schema.js';
import { ActorJournal } from './actor-journal.js';
import { sqliteWrite } from '../storage/sqlite-write.js';

let journal: ActorJournal | undefined;
export function actorJournal(): ActorJournal {
  return journal ??= new ActorJournal(new Database(resolveSqlitePath(loadEnv().DATABASE_URL)));
}

/** Let asynchronous Prisma transactions progress while SQLite is busy. A native
 * busy wait on the main thread would prevent their JS continuations from running. */
export async function actorJournalWrite<T>(write: () => T): Promise<T> {
  return sqliteWrite(write, 'Actor journal is busy; retry the same operation ID');
}
