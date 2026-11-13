// Which providers can serve POST /v1/decisions, with which model, and why not.
import { ProviderKind } from '../generated/prisma/client.js';
import type { ProviderRuntime } from '../providers/types.js';
import type { DecisionsRequest } from './schema.js';
import { translateRequestToJev, type JevTranslation } from './jev-translate.js';

/** Public alias for the Decisions API (not the shadow decision model). */
export const DECISIONS_API_ALIAS = 'decision';
export const OPENAI_DECISIONS_MODEL = 'gpt-6-luna';
export const TYPESAFE_JEV_MODEL = 'jev-latest';
export const OPENROUTER_JEV_MODEL = '~typesafe/jev-latest';
/**
 * Provider tag that marks an OPENAI_GENERIC provider as the TypeSafe Jev API
 * (`/v1/systemone`) rather than an OpenAI-wire-format Decisions server.
 */
export const JEV_DECISIONS_TAG = 'jev-decisions';
/** Slugs of the provider records seeded by EMBERPATH_DECISIONS_JEV_ENABLED. */
export const TYPESAFE_JEV_PROVIDER_SLUG = 'typesafe-jev';
export const OPENROUTER_JEV_PROVIDER_SLUG = 'openrouter-jev';

export type DecisionsBackend = 'openai' | 'typesafe-jev' | 'openrouter-jev';

const BACKEND_DEFAULT_MODEL: Record<DecisionsBackend, string> = {
  openai: OPENAI_DECISIONS_MODEL,
  'typesafe-jev': TYPESAFE_JEV_MODEL,
  'openrouter-jev': OPENROUTER_JEV_MODEL,
};

/**
 * Provider-kind eligibility, independent of any request. A provider serves
 * /v1/decisions only when `v1.decisions` is in its supportedRoutes: the default
 * for OPENAI, and an explicit operator opt-in for every other kind.
 * - OPENAI: OpenAI's API serves /v1/decisions natively (OpenAI wire format).
 * - OPENAI_GENERIC: the TypeSafe Jev API when tagged `jev-decisions`, otherwise
 *   an OpenAI-wire-format Decisions server.
 * - OPENROUTER: the OpenRouter decisions API (Jev).
 * - CODEX and every other kind: never. The ChatGPT backend behind CODEX does
 *   not serve this endpoint, so no capability override can enable it.
 */
export function decisionsBackendFor(provider: ProviderRuntime): DecisionsBackend | undefined {
  if (!provider.capabilities.supportedRoutes.includes('v1.decisions')) return undefined;
  switch (provider.kind) {
    case ProviderKind.OPENAI:
      return 'openai';
    case ProviderKind.OPENAI_GENERIC:
      return provider.capabilities.tags.includes(JEV_DECISIONS_TAG) ? 'typesafe-jev' : 'openai';
    case ProviderKind.OPENROUTER:
      return 'openrouter-jev';
    default:
      return undefined;
  }
}

export function isJevModel(model: string): boolean {
  return /^(~?typesafe\/)?jev-/u.test(model);
}

/** The model name a backend uses for `model`, or undefined when it cannot serve it. */
export function nativeDecisionsModel(backend: DecisionsBackend, model: string): string | undefined {
  if (backend === 'openai') return isJevModel(model) ? undefined : model;
  if (!isJevModel(model)) return undefined;
  if (backend === 'typesafe-jev') {
    if (model.startsWith('typesafe/')) return undefined; // OpenRouter-only dated names
    return model.replace(/^~typesafe\//u, '');
  }
  if (model.startsWith('~typesafe/') || model.startsWith('typesafe/')) return model;
  return model === TYPESAFE_JEV_MODEL ? OPENROUTER_JEV_MODEL : undefined;
}

export interface DecisionsPlanEntry {
  provider: ProviderRuntime;
  backend: DecisionsBackend;
  model: string;
  /** True when the provider serves the requested (or alias target) model itself. */
  native: boolean;
  jev?: JevTranslation;
}

/**
 * Why a candidate cannot serve this request. `feature` means the backend cannot
 * express something the request uses (the client can change the request);
 * `model` and `provider` are configuration gaps.
 */
export interface DecisionsRejection { provider: string; backend?: DecisionsBackend; kind: 'provider' | 'model' | 'feature'; reason: string }

export interface DecisionsPlan {
  entries: DecisionsPlanEntry[];
  rejections: DecisionsRejection[];
}

/**
 * Order eligible candidates for one request. `candidates` arrive ranked by the
 * router (rules, alias pin, priority). When the client named an alias, every
 * backend can serve it with its own default decision model, and providers that
 * serve the alias target natively come first. A direct model name is served only
 * by backends that understand it.
 */
export function planDecisions(body: DecisionsRequest, candidates: ProviderRuntime[], target: { model: string; viaAlias: boolean }): DecisionsPlan {
  const entries: DecisionsPlanEntry[] = [];
  const rejections: DecisionsRejection[] = [];
  const translations = new Map<string, ReturnType<typeof translateRequestToJev>>();
  for (const provider of candidates) {
    const backend = decisionsBackendFor(provider);
    if (!backend) { rejections.push({ provider: provider.slug, kind: 'provider', reason: `${provider.kind} provider ${provider.slug} cannot serve /v1/decisions` }); continue; }
    if (provider.authMode !== 'NONE' && !provider.authSecret) { rejections.push({ provider: provider.slug, backend, kind: 'provider', reason: 'no API key is stored for this provider' }); continue; }
    const native = nativeDecisionsModel(backend, target.model);
    const model = native ?? (target.viaAlias ? BACKEND_DEFAULT_MODEL[backend] : undefined);
    if (!model) { rejections.push({ provider: provider.slug, backend, kind: 'model', reason: `model ${target.model} is not served by ${backend} backends` }); continue; }
    if (backend === 'openai') { entries.push({ provider, backend, model, native: native !== undefined }); continue; }
    const cacheKey = model;
    let translated = translations.get(cacheKey);
    if (!translated) { translated = translateRequestToJev(body, model); translations.set(cacheKey, translated); }
    if (!translated.ok) { rejections.push({ provider: provider.slug, backend, kind: 'feature', reason: translated.reason }); continue; }
    entries.push({ provider, backend, model, native: native !== undefined, jev: translated.translation });
  }
  // Stable partition: native matches first, router order preserved inside each group.
  return { entries: [...entries.filter((entry) => entry.native), ...entries.filter((entry) => !entry.native)], rejections };
}
