import Database from 'better-sqlite3';
import { QuotaLedger } from '../../src/security/quota-ledger.js';
import { sqliteWrite } from '../../src/storage/sqlite-write.js';

const [databasePath, key, requestLimit, tokenLimit] = process.argv.slice(2);
if (!databasePath || !key || !requestLimit || !tokenLimit) throw new Error('database path, key, request limit and token limit are required');
const database = new Database(databasePath);
try {
  const ledger = new QuotaLedger(database);
  const result = await sqliteWrite(
    () => ledger.reserve(key, 10, { dailyRequests: Number(requestLimit), dailyTokens: Number(tokenLimit) }),
    'quota stress writer remained busy',
  );
  process.stdout.write(JSON.stringify(result));
} finally {
  database.close();
}
