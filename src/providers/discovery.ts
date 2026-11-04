import { prisma } from '../storage/client.js';
import { getProviderAdapter, loadProviderRuntimeById } from './index.js';
import { safeJsonParse } from '../utils/json.js';
import {
  buildModelCapabilityJson,
  reconcileDiscoveredModels,
  type ExistingModelRow,
} from './model-parsers.js';
import type { DiscoveredModel, ProviderCapability } from './types.js';

export interface DiscoveryResult {
  supported: boolean;
  discovered: DiscoveredModel[];
  created: string[];
  updated: string[];
  unchanged: string[];
  stale: string[];
}

/**
 * Probe a provider for its live model list and reconcile it into the database.
 * Returns `supported: false` when the provider kind has no discovery adapter
 * (for example subscription/OAuth providers).
 */
export async function discoverAndReconcileProviderModels(providerId: string): Promise<DiscoveryResult> {
  const runtime = await loadProviderRuntimeById(providerId);
  if (!runtime) {
    throw new Error(`Provider ${providerId} not found`);
  }

  const adapter = getProviderAdapter(runtime.kind);
  if (!adapter.discoverModels) {
    return { supported: false, discovered: [], created: [], updated: [], unchanged: [], stale: [] };
  }

  const discovered = await adapter.discoverModels(runtime);
  const existingRows = await prisma.providerModel.findMany({ where: { providerId } });
  const existing: ExistingModelRow[] = existingRows.map((row) => ({
    model: row.model,
    displayName: row.displayName,
    enabled: row.enabled,
    maxContextWindow: row.maxContextWindow,
    capabilityJson: row.capabilityJson,
  }));

  const plan = reconcileDiscoveredModels(existing, discovered);
  const discoveredByModel = new Map(discovered.map((entry) => [entry.model, entry]));

  for (const entry of plan.toCreate) {
    await prisma.providerModel.create({
      data: {
        providerId,
        model: entry.model,
        displayName: entry.displayName ?? null,
        enabled: true,
        maxContextWindow: entry.maxContextWindow ?? null,
        capabilityJson: buildModelCapabilityJson(entry.capabilities) ?? null,
      },
    });
  }

  for (const update of plan.toUpdate) {
    const entry = discoveredByModel.get(update.model);
    await prisma.providerModel.updateMany({
      where: { providerId, model: update.model },
      data: {
        ...(update.maxContextWindow !== undefined ? { maxContextWindow: update.maxContextWindow } : {}),
        ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
        ...(entry?.capabilities ? { capabilityJson: buildModelCapabilityJson(entry.capabilities) ?? null } : {}),
      },
    });
  }

  return {
    supported: true,
    discovered,
    created: plan.toCreate.map((entry) => entry.model),
    updated: plan.toUpdate.map((entry) => entry.model),
    unchanged: plan.unchanged,
    stale: plan.stale,
  };
}

/** Merge a stored capability JSON string with defaults (used for reporting). */
export function readModelCapabilities(capabilityJson: string | null): Partial<ProviderCapability> {
  if (!capabilityJson) {
    return {};
  }
  return safeJsonParse<Partial<ProviderCapability>>(capabilityJson, {});
}
