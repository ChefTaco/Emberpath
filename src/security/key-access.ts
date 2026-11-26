import type { ProviderRuntime, RouteDecision, RouteRequest } from '../providers/types.js';
import { safeJsonParse } from '../utils/json.js';

/**
 * Per-key model and provider allowlists from the key's metadata. A model entry is an exact
 * model or alias name, or a prefix ending in `*`; a provider entry is a provider slug or ID.
 * A key without a list may use every model or provider, as before.
 */
export interface ClientKeyAccess {
  allowedModels?: string[] | undefined;
  allowedProviders?: string[] | undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : undefined;
}

export function readClientKeyAccess(metadataJson: string | null | undefined): ClientKeyAccess {
  const metadata = safeJsonParse<{ allowedModels?: unknown; allowedProviders?: unknown }>(metadataJson ?? null, {});
  return { allowedModels: stringList(metadata.allowedModels), allowedProviders: stringList(metadata.allowedProviders) };
}

export function modelAllowed(patterns: readonly string[] | undefined, model: string | undefined): boolean {
  if (!patterns) return true;
  if (!model) return false;
  return patterns.some((pattern) => (pattern.endsWith('*') ? model.startsWith(pattern.slice(0, -1)) : model === pattern));
}

export function providerAllowed(allowed: readonly string[] | undefined, provider: { id: string; slug: string }): boolean {
  return !allowed || allowed.includes(provider.slug) || allowed.includes(provider.id);
}

/**
 * Apply the key's allowlists to a routing decision. The model the client named (or the model
 * an alias resolves to) must be allowed, and only allowed providers stay candidates. A
 * request that names no model is allowed only when it reads (GET), such as a model listing.
 */
export function applyClientKeyAccess(decision: RouteDecision, route: Pick<RouteRequest, 'model' | 'method'>, access: ClientKeyAccess, providers: readonly ProviderRuntime[]): RouteDecision {
  if (decision.denialReason || (!access.allowedModels && !access.allowedProviders)) return decision;
  if (access.allowedModels) {
    const named = route.model !== undefined || decision.targetModel !== undefined;
    const allowed = named
      ? modelAllowed(access.allowedModels, route.model) || modelAllowed(access.allowedModels, decision.targetModel)
      : route.method === 'GET' || route.method === 'HEAD';
    if (!allowed) return deny(decision, named ? `This client key may not use model "${route.model ?? decision.targetModel}"` : 'This client key must name a model');
  }
  if (access.allowedProviders) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const keep = (id: string): boolean => {
      const provider = byId.get(id);
      return provider !== undefined && providerAllowed(access.allowedProviders, provider);
    };
    const candidateProviderIds = decision.candidateProviderIds.filter(keep);
    if (candidateProviderIds.length === 0 && decision.candidateProviderIds.length > 0) {
      return deny(decision, 'This client key may not use the providers that serve this request');
    }
    return {
      ...decision,
      candidateProviderIds,
      fallbackProviderIds: candidateProviderIds.slice(1),
      selectedProviderId: candidateProviderIds[0],
      selectedProviderKind: candidateProviderIds[0] ? byId.get(candidateProviderIds[0])?.kind : undefined,
    };
  }
  return decision;
}

function deny(decision: RouteDecision, reason: string): RouteDecision {
  return { ...decision, denialReason: reason, selectedProviderId: undefined, selectedProviderKind: undefined };
}

/** Requests each key has running, for the per-key `maxInFlight` limit (per process). */
const running = new Map<string, number>();

/**
 * Take an in-flight slot for the key, or return undefined when it already runs `max`
 * requests. The returned release is idempotent.
 */
export function acquireKeySlot(keyId: string, max: number | undefined): (() => void) | undefined {
  const current = running.get(keyId) ?? 0;
  if (max !== undefined && max > 0 && current >= max) return undefined;
  running.set(keyId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (running.get(keyId) ?? 1) - 1;
    if (left <= 0) running.delete(keyId);
    else running.set(keyId, left);
  };
}

export function keySlotsInUse(keyId: string): number {
  return running.get(keyId) ?? 0;
}
