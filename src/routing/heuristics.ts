import { loadEnv } from '../config/env.js';
import { jevDecisionObservations } from './jev.js';
import { prisma } from '../storage/client.js';
import { heuristicCounter } from '../telemetry/metrics.js';
import type { RouteObservation, RouteRequest } from '../providers/types.js';
import { safeJsonParse } from '../utils/json.js';
import type { HeuristicAction } from './types.js';

export async function evaluateHeuristics(route: RouteRequest): Promise<RouteObservation[]> {
  const rules = await prisma.heuristicRule.findMany({
    where: { enabled: true },
    orderBy: { score: 'desc' },
  });

  const inspectionText = `${route.path}\n${route.model ?? ''}\n${route.requestBodyText ?? ''}`.toLowerCase();
  const observations: RouteObservation[] = [];

  if (route.modalities.length > 0) {
    observations.push({
      name: 'multimodal-payload',
      category: 'capability',
      score: 15,
      action: 'rerank',
      details: route.modalities.join(','),
    });
  }

  if (route.toolsRequested) {
    observations.push({
      name: 'tools-requested',
      category: 'tooling',
      score: 10,
      action: 'rerank',
    });
  }

  if (route.jsonSchemaRequested) {
    observations.push({
      name: 'json-schema-requested',
      category: 'structured-output',
      score: 10,
      action: 'rerank',
    });
  }

  const approxLength = route.requestBodyText?.length ?? route.bodyBuffer?.byteLength ?? 0;
  if (approxLength > 64_000) {
    observations.push({
      name: 'large-context',
      category: 'context',
      score: 20,
      action: 'rerank',
      details: `${approxLength}`,
    });
  }

  for (const rule of rules) {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'i');
    } catch {
      // Skip rules whose stored pattern is not a valid regular expression.
      continue;
    }
    if (!regex.test(inspectionText)) {
      continue;
    }

    const action = safeJsonParse<HeuristicAction>(rule.actionJson, { action: 'rerank' });
    heuristicCounter.inc({
      name: rule.name,
      category: rule.category,
      action: action.action,
    });
    observations.push({
      name: rule.name,
      category: rule.category,
      score: rule.score,
      action: action.action,
      details: action.reason ?? undefined,
    });
  }

  const env = loadEnv();
  if ((env.HIVE_TYPESAFE_AI_KEY || env.HIVE_ROUTER_OPENROUTER_KEY) && env.HIVE_ROUTER_DECISION_MODE === "shadow") {
    observations.push(...await jevDecisionObservations(route, {
      typesafe: env.HIVE_TYPESAFE_AI_KEY ? { apiKey: env.HIVE_TYPESAFE_AI_KEY, model: env.HIVE_TYPESAFE_AI_MODEL, timeoutMs: env.HIVE_ROUTER_DECISION_TIMEOUT_MS } : undefined,
      openrouter: env.HIVE_ROUTER_OPENROUTER_KEY ? { apiKey: env.HIVE_ROUTER_OPENROUTER_KEY, model: env.HIVE_ROUTER_DECISION_MODEL, timeoutMs: env.HIVE_ROUTER_DECISION_TIMEOUT_MS } : undefined,
    }));
  }

  return observations;
}
