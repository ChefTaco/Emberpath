import { ProviderKind, type RouteRule, type ModelAlias } from '../generated/prisma/client.js';
import { prisma } from '../storage/client.js';
import { evaluateHeuristics } from './heuristics.js';
import { resolveAdaptiveScores } from './adaptive.js';
import { computeObjectiveScore, loadRoutingObjectiveConfig, type RoutingObjectiveConfig } from './objective.js';
import type { ProviderRuntime, RouteDecision, RouteObservation, RouteRequest } from '../providers/types.js';
import { safeJsonParse } from '../utils/json.js';

interface RouteRuleAction {
  providerIds?: string[];
  providerKinds?: ProviderKind[];
  requiredTag?: string;
  deny?: boolean;
  denyReason?: string;
}

function supportsRoute(provider: ProviderRuntime, route: RouteRequest): boolean {
  if (!provider.capabilities.supportedRoutes.includes(route.endpointKind)) {
    return false;
  }

  if (route.stream && !provider.capabilities.streaming) {
    return false;
  }

  if (route.toolsRequested && !provider.capabilities.tools) {
    return false;
  }

  if (route.jsonSchemaRequested && !provider.capabilities.jsonSchema) {
    return false;
  }

  if (route.modalities.includes('image') && !provider.capabilities.vision) {
    return false;
  }

  if (route.modalities.includes('audio') && !provider.capabilities.audio) {
    return false;
  }

  if (route.modalities.includes('video') && !provider.capabilities.video) {
    return false;
  }

  if (route.endpointKind === 'v1.embeddings' && !provider.capabilities.embeddings) {
    return false;
  }

  return true;
}

function scoreProvider(provider: ProviderRuntime, observations: RouteObservation[], objective: RoutingObjectiveConfig): number {
  let score = provider.priority * -1 + provider.weight;

  for (const observation of observations) {
    if (observation.name === 'large-context' && provider.capabilities.longContext) {
      score += 25;
    }

    if (observation.name === 'multimodal-payload' && observation.details?.includes('image') && provider.capabilities.vision) {
      score += 20;
    }

    if (observation.name === 'tools-requested' && provider.capabilities.tools) {
      score += 10;
    }

    if (observation.action === 'rerank' && observation.category === 'dangerous-tooling' && provider.capabilities.tags.includes('safe-tools')) {
      score += 30;
    }

    if (observation.action === 'rerank' && observation.category === 'secrets' && provider.capabilities.tags.includes('local-only')) {
      score += 30;
    }
  }

  return score + computeObjectiveScore(provider, objective);
}

export async function resolveRoute(
  route: RouteRequest,
  providers: ProviderRuntime[],
  proposed?: { rules?: RouteRule[]; alias?: ModelAlias | null; objective?: RoutingObjectiveConfig },
): Promise<RouteDecision> {
  const observations = await evaluateHeuristics(route);
  const rules = proposed?.rules ?? await prisma.routeRule.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  const routingModel = route.routingTrait ?? route.model;
  const alias = proposed && "alias" in proposed ? proposed.alias : routingModel
    ? await prisma.modelAlias.findUnique({ where: { alias: routingModel } })
    : null;
  const [adaptive, objective] = await Promise.all([
    resolveAdaptiveScores(),
    proposed?.objective ? Promise.resolve(proposed.objective) : loadRoutingObjectiveConfig(),
  ]);

  let candidateProviders = providers.filter((provider) => provider.provider.enabled);
  const triggeredRuleNames: string[] = [];
  let denialReason: string | undefined;
  let targetModel = route.model;

  if (route.endpointKind === 'ollama.native') {
    candidateProviders = candidateProviders.filter((provider) => provider.kind === ProviderKind.OLLAMA);
  } else if (route.endpointKind === 'vllm.native') {
    candidateProviders = candidateProviders.filter((provider) => provider.kind === ProviderKind.VLLM);
  }

  if (route.routingTrait && !alias?.enabled) {
    denialReason = `Routing trait "${route.routingTrait}" was not found or is disabled.`;
  }

  if (alias?.enabled) {
    targetModel = alias.upstreamModel;
    if (alias.providerId) {
      candidateProviders = candidateProviders.filter((provider) => provider.id === alias.providerId);
      triggeredRuleNames.push(route.routingTrait ? `trait:${alias.alias}` : `alias:${alias.alias}`);
    }
  }

  candidateProviders = candidateProviders.filter((provider) => supportsRoute(provider, route));

  for (const rule of rules) {
    const matches = safeJsonParse<Record<string, unknown>>(rule.matchJson, {});
    const actions = safeJsonParse<RouteRuleAction>(rule.actionJson, {});

    const paths = Array.isArray(matches.paths) ? matches.paths.filter((value): value is string => typeof value === 'string') : [];
    const models = Array.isArray(matches.models) ? matches.models.filter((value): value is string => typeof value === 'string') : [];
    const endpointKinds = Array.isArray(matches.endpointKinds)
      ? matches.endpointKinds.filter((value): value is string => typeof value === 'string')
      : [];

    const pathMatches = paths.length === 0 || paths.includes(route.path);
    const modelMatches = models.length === 0 || (routingModel ? models.includes(routingModel) : false);
    const endpointMatches = endpointKinds.length === 0 || endpointKinds.includes(route.endpointKind);
    if (!pathMatches || !modelMatches || !endpointMatches) {
      continue;
    }

    triggeredRuleNames.push(rule.name);

    if (actions.deny) {
      denialReason = actions.denyReason ?? `Denied by route rule ${rule.name}`;
      break;
    }

    if (actions.providerIds?.length) {
      candidateProviders = candidateProviders.filter((provider) => actions.providerIds?.includes(provider.id));
    }

    if (actions.providerKinds?.length) {
      candidateProviders = candidateProviders.filter((provider) => actions.providerKinds?.includes(provider.kind));
    }

    if (actions.requiredTag) {
      candidateProviders = candidateProviders.filter((provider) => provider.capabilities.tags.includes(actions.requiredTag ?? ''));
    }
  }

  if (!denialReason) {
    const denyObservation = observations.find((observation) => observation.action === 'deny');
    if (denyObservation) {
      denialReason = denyObservation.details ?? `Denied by heuristic ${denyObservation.name}`;
    }
  }

  const ranked = candidateProviders
    .map((provider) => ({
      provider,
      score: scoreProvider(provider, observations, objective) + (adaptive.scores.get(provider.id) ?? 0),
    }))
    .sort((left, right) => right.score - left.score);

  const selected = ranked[0]?.provider;

  return {
    selectedProviderId: denialReason ? undefined : selected?.id,
    selectedProviderKind: denialReason ? undefined : selected?.kind,
    targetModel,
    candidateProviderIds: ranked.map((entry) => entry.provider.id),
    fallbackProviderIds: ranked.slice(1).map((entry) => entry.provider.id),
    observations,
    triggeredRuleNames,
    confidence: selected ? Math.max(0.1, Math.min(1, (ranked[0]?.score ?? 0) / 200)) : 0,
    denialReason,
    passthroughTargetPath: route.path,
  };
}
