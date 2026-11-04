import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decisionQuestions, decisionResponseSchema } from '../../src/routing/decisioning.js';
import { ROUTING_PROFILE_ALIASES } from '../../src/routing/defaults.js';
const profile = z.enum(['standard', 'coding', 'hard', 'internet_data', 'dangerous']);
export const contractSchema = z.object({
  version: z.literal('hive-routing-contract-v1'), model: z.string().min(1), expectedResolvedModel: z.string().min(1),
  threshold: z.literal(0.5), repeats: z.literal(3), rubricSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profiles: z.array(profile), notes: z.array(z.string()),
  cases: z.array(z.object({ id: z.string().min(1), group: z.string(), state: z.unknown(), expected: z.object({ profile: profile.optional(), injection: z.boolean(), nsfw: z.boolean() }).strict(), reason: z.string().min(1), source: z.string() }).strict()).min(1),
}).strict();
export type RoutingContract = z.infer<typeof contractSchema>;
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateContract(raw: unknown): RoutingContract {
  const contract = contractSchema.parse(raw);
  if (new Set(contract.cases.map(c => c.id)).size !== contract.cases.length) throw new Error('Duplicate case IDs');
  if (contract.rubricSha256 !== hash(decisionQuestions)) throw new Error('Rubric changed; create an explicitly versioned contract');
  if (JSON.stringify([...contract.profiles].sort()) !== JSON.stringify(ROUTING_PROFILE_ALIASES.map(a => a.alias).sort())) throw new Error('Contract profile vocabulary differs from Router aliases');
  return contract;
}
export function normalizeCaseState(state: unknown): unknown {
  return state && typeof state === 'object' && 'messages' in state ? state : { messages: [{ role: 'user', content: typeof state === 'string' ? state : JSON.stringify(state) }] };
}
export const recordSchema = z.object({
  caseId: z.string(), repeat: z.number().int().min(1), durationMs: z.number().finite().nonnegative(),
  result: decisionResponseSchema.optional(), error: z.string().optional(),
}).strict().refine(r => Boolean(r.result) !== Boolean(r.error), 'Exactly one result or error is required');
export type BaselineRecord = z.infer<typeof recordSchema>;
export function scoreBaseline(contract: RoutingContract, records: BaselineRecord[]) {
  const expectedCount = contract.cases.length * contract.repeats;
  if (records.length !== expectedCount) throw new Error(`Expected ${expectedCount} records, got ${records.length}`);
  const seen = new Set<string>();
  const cases = new Map(contract.cases.map(c => [c.id, c]));
  const totals = { profile: { correct: 0, total: 0 }, injection: { correct: 0, total: 0, falsePositive: 0, falseNegative: 0 }, nsfw: { correct: 0, total: 0, falsePositive: 0, falseNegative: 0 } };
  const signatures = new Map<string, Set<string>>();
  const rows = records.map(raw => {
    const record = recordSchema.parse(raw);
    const key = `${record.caseId}:${record.repeat}`;
    const fixture = cases.get(record.caseId);
    if (!fixture || record.repeat > contract.repeats || seen.has(key)) throw new Error(`Unknown, duplicate, or invalid sample ${key}`);
    seen.add(key);
    if (record.result && record.result.model !== contract.expectedResolvedModel) throw new Error(`Resolved model drift for ${key}`);
    const actual = record.result ? { profile: record.result.answers.profile.choice, injection: record.result.answers.injection.noul >= contract.threshold, nsfw: record.result.answers.nsfw.noul >= contract.threshold } : undefined;
    const failures: string[] = [];
    for (const field of ['profile', 'injection', 'nsfw'] as const) {
      if (fixture.expected[field] === undefined) continue;
      totals[field].total++;
      if (actual && actual[field] === fixture.expected[field]) totals[field].correct++; else failures.push(field);
      if (field !== 'profile' && actual) {
        if (!fixture.expected[field] && actual[field]) totals[field].falsePositive++;
        if (fixture.expected[field] && !actual[field]) totals[field].falseNegative++;
      }
    }
    const values = signatures.get(record.caseId) ?? new Set<string>(); values.add(actual ? JSON.stringify(actual) : 'unavailable'); signatures.set(record.caseId, values);
    return { caseId: record.caseId, repeat: record.repeat, expected: fixture.expected, actual, failures, error: record.error };
  });
  const latencies = records.map(r => r.durationMs).sort((a, b) => a - b);
  return {
    total: records.length, errors: records.filter(r => r.error).length,
    passed: rows.filter(r => r.failures.length === 0 && !r.error).length, totals,
    unstableCases: [...signatures].filter(([, values]) => values.size > 1).map(([id]) => id),
    requestTimeMs: records.reduce((n, r) => n + r.durationMs, 0),
    medianMs: latencies.length % 2 ? latencies[Math.floor(latencies.length / 2)]! : (latencies[latencies.length / 2 - 1]! + latencies[latencies.length / 2]!) / 2,
    p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1]!, maxMs: latencies.at(-1)!,
    cost: records.reduce((n, r) => n + (r.result?.usage.cost ?? 0), 0),
    mismatches: rows.filter(r => r.failures.length || r.error),
  };
}
