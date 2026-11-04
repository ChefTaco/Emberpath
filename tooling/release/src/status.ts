import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { json } from './files.js';

export interface DurableUpgradeStatus {
  state: string;
  busy: boolean;
  transaction?: string;
  from?: string;
  to?: string;
  error?: string;
  restoreCommand?: string;
  version?: string;
}
/** Reading an outcome never starts a coordinator, checks npm or changes a receipt. */
export function durableUpgradeStatus(root: string): DurableUpgradeStatus {
  const run = join(root, 'run');
  if (!existsSync(join(root, 'config/project.json'))) return { state: 'unmanaged', busy: false };
  if (!existsSync(run)) return { state: 'idle', busy: false };
  const files = readdirSync(run)
    .filter(
      (f) =>
        /^transaction-.*\.json$/.test(f) ||
        ['compose-result.json', 'coordinator-result.json'].includes(f),
    )
    .sort((a, b) => statSync(join(run, b)).mtimeMs - statSync(join(run, a)).mtimeMs);
  const records = files.map((file) => json<Record<string, unknown>>(join(run, file)));
  const pending = records.find((r) => r.phase && !r.completedAt);
  const value = pending || records[0];
  if (!value) return { state: 'idle', busy: false };
  const nested = value.transaction || value.result;
  const transaction =
    nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : value;
  const text = (name: string): string | undefined =>
    typeof transaction[name] === 'string' ? (transaction[name] as string) : undefined;
  return {
    state: String(value.state || value.phase || 'unknown'),
    busy: Boolean(pending),
    ...(typeof value.version === 'string' || text('to')
      ? { version: typeof value.version === 'string' ? value.version : text('to')! }
      : {}),
    ...(text('id') ? { transaction: text('id')! } : {}),
    ...(text('from') ? { from: text('from')! } : {}),
    ...(text('to') ? { to: text('to')! } : {}),
    ...(text('error') || typeof value.error === 'string'
      ? { error: text('error') || String(value.error) }
      : {}),
    ...(text('restoreCommand') ? { restoreCommand: text('restoreCommand')! } : {}),
  };
}
