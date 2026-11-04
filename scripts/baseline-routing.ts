import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { classifyDecision } from '../src/routing/decisioning.js';
import { validateContract, scoreBaseline, normalizeCaseState, hash, type BaselineRecord } from './lib/routing-baseline.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const contract = validateContract(JSON.parse(readFileSync(resolve(root, 'services/hive-router/tests/fixtures/routing-contract-v1.json'), 'utf8')));
const sourcePaths = ['src/routing/defaults.ts', 'src/routing/service.ts', 'src/routing/heuristics.ts', 'src/routing/objective.ts', 'src/routing/adaptive.ts', 'src/routing/decisioning.ts', 'src/routing/jev.ts', 'src/routing/typesafe.ts', 'src/config/env.ts'];
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(resolve(root, 'services/hive-router', path), 'utf8'))]));
const mode = process.argv[2] ?? 'replay';
const defaultPath = resolve(root, 'services/hive-router/tests/fixtures/jev-routing-baseline-v1.json');
const artifactPath = resolve(process.env.ROUTING_BASELINE_FILE ?? defaultPath);
if (mode === 'replay') {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { contractSha256: string; records: BaselineRecord[]; summary: unknown; recordsSha256: string; sourceHashes: Record<string, string> };
  if (artifact.contractSha256 !== hash(contract)) throw new Error('Contract drift');
  if (artifact.recordsSha256 !== hash(artifact.records)) throw new Error('Baseline record digest mismatch');
  const sourceMatches = JSON.stringify(artifact.sourceHashes) === JSON.stringify(sourceHashes);
  const historical = process.argv.includes('--historical');
  if (!sourceMatches && !historical) throw new Error('Routing source changed; capture a new baseline or use --historical to verify only the original evidence');
  const summary = scoreBaseline(contract, artifact.records);
  if (JSON.stringify(summary) !== JSON.stringify(artifact.summary)) throw new Error('Baseline scoring changed');
  console.log(JSON.stringify({ mode, verified: true, scope: historical ? 'historical-evidence' : 'current-source', sourceMatches, ...summary }, null, 2));
} else if (mode === 'live') {
  if (existsSync(artifactPath)) throw new Error('Refusing to overwrite baseline; choose a new ROUTING_BASELINE_FILE');
  const env = { ...parse(readFileSync(resolve(process.env.HIVE_ROUTER_EVAL_ENV_FILE ?? resolve(root, '.env')))), ...process.env };
  if (!env.HIVE_ROUTER_OPENROUTER_KEY) throw new Error('HIVE_ROUTER_OPENROUTER_KEY required');
  const records: BaselineRecord[] = [];
  const startedAt = new Date().toISOString(); const start = performance.now();
  for (let repeat = 1; repeat <= contract.repeats; repeat++) {
    for (const fixture of contract.cases) {
      const before = performance.now();
      try {
        const result = await classifyDecision(normalizeCaseState(fixture.state), { apiKey: env.HIVE_ROUTER_OPENROUTER_KEY, model: contract.model, timeoutMs: 30_000 });
        if (result.model !== contract.expectedResolvedModel) throw new Error('decision_model_drift');
        records.push({ caseId: fixture.id, repeat, durationMs: Math.round(performance.now() - before), result });
        console.log(`${repeat}/${contract.repeats} ${fixture.id} ${result.answers.profile.choice}`);
      } catch (error) {
        const reason = error instanceof Error && /^decision_[a-z_0-9]+$/.test(error.message) ? error.message : 'decision_unavailable';
        records.push({ caseId: fixture.id, repeat, durationMs: Math.round(performance.now() - before), error: reason });
        console.log(`${repeat}/${contract.repeats} ${fixture.id} ${reason}`);
      }
    }
  }
  const summary = scoreBaseline(contract, records);
  const artifact = { version: 1, startedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), contractSha256: hash(contract), recordsSha256: hash(records), sourceHashes, requestedModel: contract.model, resolvedModel: contract.expectedResolvedModel, records, summary };
  mkdirSync(dirname(artifactPath), { recursive: true }); writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ artifactPath, summary }, null, 2));
  process.exitCode = summary.errors || summary.passed !== summary.total ? 1 : 0;
} else throw new Error('Usage: baseline-routing.ts [replay|live]');
