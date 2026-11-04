import { HTTPException } from 'hono/http-exception';

/** Native busy waits block the JS continuation that may release a Prisma
 * transaction. Direct SQLite writers must use timeout=0 and yield between tries. */
export async function sqliteWrite<T>(write: () => T, message = 'SQLite writer is busy; retry the operation'): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return write(); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (!code.startsWith('SQLITE_BUSY') && !code.startsWith('SQLITE_LOCKED')) throw error;
      if (Date.now() >= deadline) throw new HTTPException(503, { message });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
