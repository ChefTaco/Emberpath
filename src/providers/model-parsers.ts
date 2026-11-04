import type { DiscoveredModel, ProviderCapability } from './types.js';

/**
 * Shapes returned by upstream model-listing endpoints. Everything is optional
 * because providers differ and we only trust fields we can validate.
 */
interface OpenAiModelEntry {
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_context_length?: unknown;
  max_model_len?: unknown;
  max_input_tokens?: unknown;
}

interface OllamaTagEntry {
  name?: unknown;
  model?: unknown;
}

function coercePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function firstContextWindow(entry: OpenAiModelEntry): number | undefined {
  return (
    coercePositiveInt(entry.context_length) ??
    coercePositiveInt(entry.context_window) ??
    coercePositiveInt(entry.max_context_length) ??
    coercePositiveInt(entry.max_model_len) ??
    coercePositiveInt(entry.max_input_tokens)
  );
}

/** Parse an OpenAI-compatible `/v1/models` payload into discovered models. */
export function parseOpenAiModels(payload: unknown): DiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as OpenAiModelEntry;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const displayName = typeof entry.display_name === 'string'
      ? entry.display_name
      : typeof entry.name === 'string'
        ? entry.name
        : undefined;
    const maxContextWindow = firstContextWindow(entry);
    models.push({
      model: id,
      ...(displayName ? { displayName } : {}),
      ...(maxContextWindow ? { maxContextWindow } : {}),
    });
  }
  return models;
}

/** Parse an Ollama `/api/tags` payload into discovered models. */
export function parseOllamaTags(payload: unknown): DiscoveredModel[] {
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) {
    return [];
  }

  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as OllamaTagEntry;
    const name = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : typeof entry.model === 'string'
        ? entry.model.trim()
        : '';
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push({ model: name });
  }
  return result;
}

/** Parse an Anthropic `/v1/models` payload into discovered models. */
export function parseAnthropicModels(payload: unknown): DiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as { id?: unknown; display_name?: unknown };
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const displayName = typeof entry.display_name === 'string' ? entry.display_name : undefined;
    models.push({ model: id, ...(displayName ? { displayName } : {}) });
  }
  return models;
}

export interface ExistingModelRow {
  model: string;
  displayName: string | null;
  enabled: boolean;
  maxContextWindow: number | null;
  capabilityJson: string | null;
}

export interface ModelReconcileUpdate {
  model: string;
  maxContextWindow?: number | undefined;
  displayName?: string | undefined;
}

export interface ModelReconcilePlan {
  toCreate: DiscoveredModel[];
  toUpdate: ModelReconcileUpdate[];
  unchanged: string[];
  stale: string[];
}

/**
 * Reconcile discovered models against operator-managed rows. Operator overrides
 * always win: existing rows keep their `enabled`, `displayName`, and capability
 * overrides. Discovery only fills gaps (a missing context window, a missing
 * display name) and reports newly discovered and now-absent (stale) models. It
 * never deletes rows, because operators may have added models manually.
 */
export function reconcileDiscoveredModels(
  existing: ExistingModelRow[],
  discovered: DiscoveredModel[],
): ModelReconcilePlan {
  const existingByModel = new Map(existing.map((row) => [row.model, row]));
  const discoveredByModel = new Map(discovered.map((entry) => [entry.model, entry]));

  const toCreate: DiscoveredModel[] = [];
  const toUpdate: ModelReconcileUpdate[] = [];
  const unchanged: string[] = [];

  for (const entry of discovered) {
    const row = existingByModel.get(entry.model);
    if (!row) {
      toCreate.push(entry);
      continue;
    }

    const update: ModelReconcileUpdate = { model: entry.model };
    let changed = false;
    if (row.maxContextWindow === null && entry.maxContextWindow !== undefined) {
      update.maxContextWindow = entry.maxContextWindow;
      changed = true;
    }
    if ((row.displayName === null || row.displayName === '') && entry.displayName !== undefined) {
      update.displayName = entry.displayName;
      changed = true;
    }

    if (changed) {
      toUpdate.push(update);
    } else {
      unchanged.push(entry.model);
    }
  }

  const stale = existing
    .filter((row) => !discoveredByModel.has(row.model))
    .map((row) => row.model);

  return { toCreate, toUpdate, unchanged, stale };
}

export function buildModelCapabilityJson(capabilities: Partial<ProviderCapability> | undefined): string | undefined {
  if (!capabilities || Object.keys(capabilities).length === 0) {
    return undefined;
  }
  return JSON.stringify(capabilities);
}
