import { classifyDecision, observeDecision, MAX_DECISION_INPUT_BYTES, type DecisionConfig } from './decisioning.js';
import { classifyTypeSafeDecision, type TypeSafeDecisionConfig } from './typesafe.js';
import type { RouteRequest } from '../providers/types.js';

export interface JevConfig { typesafe?: TypeSafeDecisionConfig | undefined; openrouter?: DecisionConfig | undefined }
interface Attempt { provider: string; status: 'ok' | 'unavailable'; durationMs: number; reason?: string }

/** One attempt per configured transport, direct TypeSafe first. Never retry valid labels. */
export async function classifyJev(state: unknown, config: JevConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const start = performance.now();
  const attempts: Attempt[] = [];
  const unavailable = (reason: string) => ({ status: 'unavailable', reason, attempts, durationMs: Math.round(performance.now() - start) });
  if (signal?.aborted) return unavailable('decision_cancelled');
  const serialized = JSON.stringify(state);
  if (!serialized || Buffer.byteLength(serialized) > MAX_DECISION_INPUT_BYTES) return unavailable('decision_input_limit');
  const providers = [
    { name: 'typesafe', config: config.typesafe, classify: classifyTypeSafeDecision },
    { name: 'openrouter', config: config.openrouter, classify: classifyDecision },
  ];
  for (const provider of providers) {
    if (!provider.config) continue;
    if (signal?.aborted) return unavailable('decision_cancelled');
    const before = performance.now();
    try {
      const result = await provider.classify(state, provider.config, signal);
      if (signal?.aborted) return unavailable('decision_cancelled');
      attempts.push({ provider: provider.name, status: 'ok', durationMs: Math.round(performance.now() - before) });
      return { ...result, status: 'ok', decisionProvider: provider.name, fallbackUsed: attempts.length > 1, attempts, durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      const reason = signal?.aborted ? 'decision_cancelled'
        : error instanceof Error && error.name === 'TimeoutError' ? 'decision_timeout'
        : error instanceof Error && /^decision_[a-z_0-9]+$/.test(error.message) ? error.message : 'decision_unavailable';
      attempts.push({ provider: provider.name, status: 'unavailable', reason, durationMs: Math.round(performance.now() - before) });
      if (signal?.aborted) return unavailable('decision_cancelled');
    }
  }
  return unavailable(attempts.length ? 'decision_all_providers_unavailable' : 'decision_not_configured');
}

export function jevDecisionObservations(route: RouteRequest, config: JevConfig) {
  return observeDecision(route, state => classifyJev(state, config, route.signal), config.typesafe ? 'jev-decision' : 'openrouter-decision');
}
