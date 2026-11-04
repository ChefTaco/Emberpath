import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface LedgerLimits { dailyRequests?: number | undefined; monthlyRequests?: number | undefined; dailyTokens?: number | undefined; monthlyTokens?: number | undefined }
export interface LedgerUsage { dayRequests: number; monthRequests: number; dayTokens: number; monthTokens: number }

export class QuotaLedger {
  constructor(private readonly db: Database.Database) { db.exec('PRAGMA busy_timeout=0'); }
  migrateRetainedHistory(now = new Date()): void {
    if (this.db.prepare("SELECT id FROM QuotaLedgerState WHERE id='migration'").get()) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let count = 0;
      const buckets = new Map<string, { requests: number; tokens: number }>();
      for (const row of this.db.prepare<[], { clientApiKeyId: string; startedAt: string | number; usageJson: string | null }>('SELECT clientApiKeyId,startedAt,usageJson FROM Trace WHERE clientApiKeyId IS NOT NULL').iterate()) {
        const key = String(row.clientApiKeyId); const at = new Date(row.startedAt as string | number);
        if (Number.isNaN(at.getTime())) throw new Error('Invalid historical trace date');
        let usage: { totalTokens?: number; total_tokens?: number } = {};
        try { usage = JSON.parse(String(row.usageJson ?? '{}')); } catch { /* Missing historical usage reserves a conservative allowance. */ }
        const tokens = usage.totalTokens ?? usage.total_tokens ?? 4096;
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid historical token usage');
        for (const id of Object.values(this.keys(key, at))) { const total = buckets.get(id) ?? { requests: 0, tokens: 0 }; total.requests++; total.tokens += tokens; buckets.set(id, total); }
        count++;
      }
      for (const [id, bucket] of buckets) this.db.prepare('INSERT INTO QuotaBucket VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(id, bucket.requests, bucket.tokens);
      this.db.prepare('INSERT INTO QuotaLedgerState VALUES (?,?,?)').run('migration', now.getTime(), count ? 'retained-traces-only' : 'new-ledger');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(): { cutoverAt: number; historicalCoverage: string } | undefined { return this.db.prepare("SELECT cutoverAt,historicalCoverage FROM QuotaLedgerState WHERE id='migration'").get() as { cutoverAt: number; historicalCoverage: string } | undefined; }
  trends(key: string): unknown[] {
    return this.db.prepare("SELECT substr(dayKey,-10) AS day,COUNT(*) AS requests,SUM(COALESCE(actualTokens,reservedTokens)) AS tokens,CASE WHEN COUNT(costUsd)=COUNT(*) THEN SUM(costUsd) ELSE NULL END AS costUsd,SUM(CASE WHEN estimated THEN 1 ELSE 0 END) AS estimatedRequests FROM QuotaReservation WHERE clientApiKeyId=? GROUP BY dayKey ORDER BY dayKey DESC LIMIT 90").all(key);
  }
  private keys(key: string, now: Date) { const date = now.toISOString(); return { day: `${key}:day:${date.slice(0, 10)}`, month: `${key}:month:${date.slice(0, 7)}` }; }
  usage(key: string, now = new Date()): LedgerUsage {
    const keys = this.keys(key, now);
    const read = (id: string) => this.db.prepare('SELECT requests,tokens FROM QuotaBucket WHERE id=?').get(id) as { requests: number; tokens: number } | undefined;
    const day = read(keys.day); const month = read(keys.month);
    return { dayRequests: day?.requests ?? 0, monthRequests: month?.requests ?? 0, dayTokens: day?.tokens ?? 0, monthTokens: month?.tokens ?? 0 };
  }
  reserve(key: string, tokens: number, limits: LedgerLimits, now = new Date()): { id?: string; exceeded: string[] } {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid token reservation');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const usage = this.usage(key, now);
      const exceeded = (['dailyRequests', 'monthlyRequests', 'dailyTokens', 'monthlyTokens'] as const).filter((name) => {
        const limit = limits[name]; if (limit === undefined || limit <= 0) return false;
        const used = { dailyRequests: usage.dayRequests + 1, monthlyRequests: usage.monthRequests + 1, dailyTokens: usage.dayTokens + tokens, monthlyTokens: usage.monthTokens + tokens }[name];
        return used > limit;
      });
      if (exceeded.length) { this.db.exec('ROLLBACK'); return { exceeded }; }
      const keys = this.keys(key, now); const id = randomUUID();
      for (const bucket of [keys.day, keys.month]) this.db.prepare('INSERT INTO QuotaBucket(id,requests,tokens) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET requests=requests+1,tokens=tokens+excluded.tokens').run(bucket, tokens);
      this.db.prepare('INSERT INTO QuotaReservation(id,clientApiKeyId,dayKey,monthKey,reservedTokens,createdAt) VALUES (?,?,?,?,?,?)').run(id, key, keys.day, keys.month, tokens, now.getTime());
      this.db.exec('COMMIT'); return { id, exceeded: [] };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  attach(id: string, traceId: string): void { this.db.prepare('UPDATE QuotaReservation SET traceId=? WHERE id=?').run(traceId, id); }
  settle(traceId: string, actualTokens?: number, pricing?: { costUsd?: number; source?: string; estimated: boolean }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM QuotaReservation WHERE traceId=? AND actualTokens IS NULL').get(traceId) as { id: string; reservedTokens: number; dayKey: string; monthKey: string } | undefined;
      if (row) {
        // Unknown provider usage retains the reservation; never refund guesses.
        const actual = actualTokens !== undefined && Number.isSafeInteger(actualTokens) && actualTokens >= 0 ? actualTokens : row.reservedTokens;
        for (const bucket of [row.dayKey, row.monthKey]) this.db.prepare('UPDATE QuotaBucket SET tokens=MAX(0,tokens+?) WHERE id=?').run(actual - row.reservedTokens, bucket);
        this.db.prepare('UPDATE QuotaReservation SET actualTokens=?,costUsd=?,priceSource=?,estimated=? WHERE id=?').run(actual, pricing?.costUsd ?? null, pricing?.source ?? null, Number(pricing?.estimated ?? actualTokens === undefined), row.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
