import Database from 'better-sqlite3';
import { loadEnv } from "../config/env.js";
import { resolveSqlitePath } from "../storage/schema.js";
import { QuotaLedger } from "./quota-ledger.js";
import { sqliteWrite } from '../storage/sqlite-write.js';
import type { ClientApiKey } from '../generated/prisma/client.js';
import { safeJsonParse } from '../utils/json.js';

/**
 * Budget and quota controls. The router sits in front of every model call, so it
 * is the natural place to cap runaway spend or local GPU usage. Quotas are set
 * per client API key (in the key's metadata) and enforced against usage computed
 * from a durable reservation ledger. Limits support soft warnings and hard stops for daily
 * and monthly request counts and token totals.
 */
export interface QuotaLimits {
  dailyRequests?: number | undefined;
  monthlyRequests?: number | undefined;
  dailyTokens?: number | undefined;
  monthlyTokens?: number | undefined;
  /** Percentage of a limit at which a soft warning is emitted (default 80). */
  warnAtPercent?: number | undefined;
  acceptRetainedHistory?: boolean;
}

export interface QuotaUsage {
  dayRequests: number;
  monthRequests: number;
  dayTokens: number;
  monthTokens: number;
}

export interface QuotaEvaluation {
  allowed: boolean;
  exceeded: string[];
  warnings: string[];
  usage: QuotaUsage;
}

const DEFAULT_WARN_PERCENT = 80;

function hasAnyLimit(limits: QuotaLimits): boolean {
  return (
    limits.dailyRequests !== undefined ||
    limits.monthlyRequests !== undefined ||
    limits.dailyTokens !== undefined ||
    limits.monthlyTokens !== undefined
  );
}

/**
 * Evaluate usage against limits. Pure and deterministic so quota policy is fully
 * unit-testable. A dimension is `exceeded` when usage meets or passes its limit,
 * and a `warning` when it crosses the warn threshold but is not yet exceeded.
 */
export function evaluateQuota(limits: QuotaLimits, usage: QuotaUsage): QuotaEvaluation {
  const exceeded: string[] = [];
  const warnings: string[] = [];
  const warnPercent = limits.warnAtPercent ?? DEFAULT_WARN_PERCENT;

  const dimensions: Array<{ name: string; limit: number | undefined; used: number }> = [
    { name: 'dailyRequests', limit: limits.dailyRequests, used: usage.dayRequests },
    { name: 'monthlyRequests', limit: limits.monthlyRequests, used: usage.monthRequests },
    { name: 'dailyTokens', limit: limits.dailyTokens, used: usage.dayTokens },
    { name: 'monthlyTokens', limit: limits.monthlyTokens, used: usage.monthTokens },
  ];

  for (const dimension of dimensions) {
    if (dimension.limit === undefined || dimension.limit <= 0) {
      continue;
    }
    if (dimension.used >= dimension.limit) {
      exceeded.push(dimension.name);
    } else if (dimension.used >= (dimension.limit * warnPercent) / 100) {
      warnings.push(dimension.name);
    }
  }

  return { allowed: exceeded.length === 0, exceeded, warnings, usage };
}

/** Read the quota limits stored in a client API key's metadata. */
export function readClientKeyQuota(metadataJson: string | null): QuotaLimits {
  if (!metadataJson) {
    return {};
  }
  const metadata = safeJsonParse<{ quota?: QuotaLimits }>(metadataJson, {});
  return metadata.quota ?? {};
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function sumTokens(usageJson: string | null): number {
  if (!usageJson) {
    return 0;
  }
  const usage = safeJsonParse<{ totalTokens?: number; total_tokens?: number }>(usageJson, {});
  const total = usage.totalTokens ?? usage.total_tokens;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

let ledger: QuotaLedger | undefined;
export function quotaLedger(): QuotaLedger {
  return ledger ??= new QuotaLedger(new Database(resolveSqlitePath(loadEnv().DATABASE_URL)));
}
export function clearQuotaUsageCache(): void { /* Ledger reads are current and uncached. */ }
export async function computeClientKeyUsage(clientApiKeyId: string, now = new Date()): Promise<QuotaUsage> {
  return quotaLedger().usage(clientApiKeyId, now);
}

export interface QuotaCheckResult {
  reservationId?: string;
  unavailable?: boolean;
  enforced: boolean;
  allowed: boolean;
  exceeded: string[];
  warnings: string[];
}

/**
 * Enforce the quota for a client key. Returns `enforced: false` when the key has
 * no limits configured. Accounting errors fail closed so concurrent requests
 * cannot bypass a configured budget.
 */
export async function enforceClientKeyQuota(clientKey: ClientApiKey, reservedTokens = 0): Promise<QuotaCheckResult> {
  const limits = readClientKeyQuota(clientKey.metadataJson);
  try {
    const history = quotaLedger().history();
    if (hasAnyLimit(limits) && history?.historicalCoverage === 'retained-traces-only' && !limits.acceptRetainedHistory && new Date(history.cutoverAt).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7)) return { enforced: true, allowed: false, exceeded: [], warnings: ['Historical trace retention may have removed usage; explicitly reconcile this month before enabling hard budgets'], unavailable: true };
    const reservation = await sqliteWrite(() => quotaLedger().reserve(clientKey.id, reservedTokens, limits));
    const usage = quotaLedger().usage(clientKey.id);
    const evaluation = evaluateQuota(limits, usage);
    return { enforced: hasAnyLimit(limits), allowed: reservation.exceeded.length === 0, exceeded: reservation.exceeded, warnings: evaluation.warnings, ...(reservation.id ? { reservationId: reservation.id } : {}) };
  } catch {
    return { enforced: true, allowed: false, exceeded: [], warnings: [], unavailable: true };
  }
}
