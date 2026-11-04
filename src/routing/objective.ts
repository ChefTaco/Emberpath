import type { ProviderRuntime } from '../providers/types.js';
import { prisma } from '../storage/client.js';
import { safeJsonParse } from '../utils/json.js';

export type RoutingGoal = 'balanced' | 'cheapest' | 'fastest' | 'highest-quality';

export interface RoutingObjectiveConfig {
  goal: RoutingGoal;
  costWeight: number;
  qualityWeight: number;
  throughputWeight: number;
  missingPricePenalty: number;
}

export const ROUTING_OBJECTIVE_SETTING_KEY = 'routing.objective';

export const DEFAULT_ROUTING_OBJECTIVE: RoutingObjectiveConfig = {
  goal: 'balanced',
  costWeight: 1,
  qualityWeight: 1,
  throughputWeight: 1,
  missingPricePenalty: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function providerCostPerMillionTokens(provider: ProviderRuntime): number | undefined {
  const input = finiteNumber(provider.capabilities.inputCostPerMillionTokens);
  const output = finiteNumber(provider.capabilities.outputCostPerMillionTokens);
  if (typeof input === 'number' && typeof output === 'number') {
    return (input + output) / 2;
  }
  return input ?? output;
}

function quality(provider: ProviderRuntime): number {
  return clamp(finiteNumber(provider.capabilities.qualityScore) ?? 50, 0, 100);
}

function throughput(provider: ProviderRuntime): number {
  const tokensPerSecond = finiteNumber(provider.capabilities.throughputTokensPerSecond);
  if (typeof tokensPerSecond !== 'number' || tokensPerSecond <= 0) {
    return 0;
  }
  return clamp(tokensPerSecond / 20, 0, 100);
}

function costPenalty(provider: ProviderRuntime, config: RoutingObjectiveConfig): number {
  const cost = providerCostPerMillionTokens(provider);
  if (typeof cost !== 'number') {
    return config.missingPricePenalty;
  }
  return Math.max(0, cost);
}

export function computeObjectiveScore(provider: ProviderRuntime, config: RoutingObjectiveConfig): number {
  const cost = costPenalty(provider, config);
  const qualityScore = quality(provider);
  const throughputScore = throughput(provider);

  switch (config.goal) {
    case 'cheapest':
      return (qualityScore * 0.05 * config.qualityWeight) - (cost * 4 * config.costWeight);
    case 'fastest':
      return (throughputScore * 0.6 * config.throughputWeight) + (qualityScore * 0.1 * config.qualityWeight) - (cost * 0.2 * config.costWeight);
    case 'highest-quality':
      return (qualityScore * 0.8 * config.qualityWeight) + (throughputScore * 0.05 * config.throughputWeight) - (cost * 0.2 * config.costWeight);
    case 'balanced':
      return (qualityScore * 0.3 * config.qualityWeight) + (throughputScore * 0.15 * config.throughputWeight) - (cost * 0.5 * config.costWeight);
  }
}

function parseGoal(value: unknown): RoutingGoal {
  return value === 'cheapest' || value === 'fastest' || value === 'highest-quality' || value === 'balanced'
    ? value
    : DEFAULT_ROUTING_OBJECTIVE.goal;
}

function parseWeight(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function parseRoutingObjectiveConfig(raw: unknown): RoutingObjectiveConfig {
  const value = typeof raw === 'object' && raw !== null ? raw as Partial<RoutingObjectiveConfig> : {};
  return {
    goal: parseGoal(value.goal),
    costWeight: parseWeight(value.costWeight, DEFAULT_ROUTING_OBJECTIVE.costWeight),
    qualityWeight: parseWeight(value.qualityWeight, DEFAULT_ROUTING_OBJECTIVE.qualityWeight),
    throughputWeight: parseWeight(value.throughputWeight, DEFAULT_ROUTING_OBJECTIVE.throughputWeight),
    missingPricePenalty: parseWeight(value.missingPricePenalty, DEFAULT_ROUTING_OBJECTIVE.missingPricePenalty),
  };
}

export async function loadRoutingObjectiveConfig(): Promise<RoutingObjectiveConfig> {
  try {
    const setting = await prisma.runtimeSetting.findUnique({ where: { key: ROUTING_OBJECTIVE_SETTING_KEY } });
    if (!setting) {
      return DEFAULT_ROUTING_OBJECTIVE;
    }
    return parseRoutingObjectiveConfig(safeJsonParse(setting.valueJson, {}));
  } catch {
    return DEFAULT_ROUTING_OBJECTIVE;
  }
}
