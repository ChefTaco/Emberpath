import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateContract, scoreBaseline, hash, recordSchema, type BaselineRecord } from '../../scripts/lib/routing-baseline.js';
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const contract = validateContract(fixture('routing-contract-v1.json'));
const baseline = () => fixture('jev-routing-baseline-v1.json') as { contractSha256: string; recordsSha256: string; records: BaselineRecord[]; summary: unknown };

describe('deterministic Jev baseline scoring', () => {
  it('preserves every original test and label rather than tuning them to the model', () => {
    const originals = [...fixture('decisions.json') as { id: string; state: unknown; expected: unknown }[], ...fixture('decisions-challenge.json') as { id: string; state: unknown; expected: unknown }[]];
    for (const original of originals) {
      expect(contract.cases.find(c => c.id === original.id)).toMatchObject({ state: original.state, expected: original.expected });
    }
    expect(contract.cases).toHaveLength(72);
  });
  it('replays the recorded model results with no network or model judge', () => {
    const artifact = baseline();
    expect(artifact.contractSha256).toBe(hash(contract)); expect(artifact.recordsSha256).toBe(hash(artifact.records));
    expect(scoreBaseline(contract, artifact.records)).toEqual(artifact.summary);
  });
  it('rejects incomplete baselines', () => {
    expect(() => scoreBaseline(contract, baseline().records.slice(1))).toThrow('Expected 216');
  });
  it('rejects duplicate case/repeat pairs', () => {
    const records = baseline().records; records[1] = records[0]!;
    expect(() => scoreBaseline(contract, records)).toThrow('duplicate');
  });
  it('rejects a changed resolved model', () => {
    const records = baseline().records; records[0]!.result!.model = 'other-model';
    expect(() => scoreBaseline(contract, records)).toThrow('model drift');
  });
  it('rejects rubric drift and duplicate fixture IDs', () => {
    expect(() => validateContract({ ...contract, rubricSha256: '0'.repeat(64) })).toThrow('Rubric changed');
    expect(() => validateContract({ ...contract, cases: [...contract.cases, contract.cases[0]] })).toThrow('Duplicate case');
  });
  it('counts unavailable calls as failed labels, never as safe classifications', () => {
    const records = baseline().records; const original = scoreBaseline(contract, records);
    records[0] = { caseId: records[0]!.caseId, repeat: 1, durationMs: 1, error: 'decision_unavailable' };
    const summary = scoreBaseline(contract, records);
    expect(summary.errors).toBe(original.errors + 1);
    expect(summary.mismatches.find(r => r.caseId === records[0]!.caseId)?.failures).toEqual(['profile', 'injection', 'nsfw']);
  });
  it('uses the exact >=0.5 threshold and does not invent unscored profiles', () => {
    const records = baseline().records; const record = records.find(r => r.caseId === 'override')!;
    record.result!.answers.injection.noul = 0.5; record.result!.answers.nsfw.noul = 0.5;
    const row = scoreBaseline(contract, records).mismatches.find(r => r.caseId === 'override' && r.repeat === record.repeat)!;
    expect(row.actual?.injection).toBe(true); expect(row.failures).toEqual(['nsfw']);
  });
  it('rejects invalid result probabilities and conflicting error/success records', () => {
    const record = baseline().records[0]!;
    expect(() => recordSchema.parse({ ...record, error: 'also-error' })).toThrow();
    record.result!.answers.injection.noul = 2;
    expect(() => recordSchema.parse(record)).toThrow();
  });
});
