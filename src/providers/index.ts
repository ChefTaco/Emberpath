import { ProviderKind, type Provider } from '../generated/prisma/client.js';
import { prisma } from '../storage/client.js';
import { parseProviderRuntime } from './runtime.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import { CodexOAuthAdapter } from './codex-oauth.js';
import { AnthropicAdapter } from './anthropic.js';
import { OllamaAdapter } from './ollama.js';
import { VllmAdapter } from './vllm.js';
import type { ProviderAdapter, ProviderRuntime } from './types.js';

const adapterRegistry: Record<ProviderKind, ProviderAdapter> = {
  [ProviderKind.OPENAI]: new OpenAiCompatibleAdapter(ProviderKind.OPENAI),
  [ProviderKind.CODEX]: new CodexOAuthAdapter(),
  [ProviderKind.OPENAI_GENERIC]: new OpenAiCompatibleAdapter(ProviderKind.OPENAI_GENERIC),
  [ProviderKind.OPENROUTER]: new OpenAiCompatibleAdapter(ProviderKind.OPENROUTER),
  [ProviderKind.ANTHROPIC]: new AnthropicAdapter(),
  [ProviderKind.OLLAMA]: new OllamaAdapter(),
  [ProviderKind.LLAMACPP]: new OpenAiCompatibleAdapter(ProviderKind.LLAMACPP),
  [ProviderKind.VLLM]: new VllmAdapter(),
};

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  return adapterRegistry[kind];
}

export async function listProviderRuntimes(): Promise<ProviderRuntime[]> {
  const providers = await prisma.provider.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  return providers.map(parseProviderRuntime);
}

export async function loadProviderRuntimeById(id: string): Promise<ProviderRuntime | null> {
  const provider = await prisma.provider.findUnique({ where: { id } });
  return provider ? parseProviderRuntime(provider) : null;
}

export async function updateProviderHealth(provider: Provider, health: { healthy: boolean; error?: string }): Promise<void> {
  await prisma.provider.update({
    where: { id: provider.id },
    data: {
      lastHealthStatus: health.healthy ? 'healthy' : 'unhealthy',
      lastHealthError: health.error ?? null,
      lastHealthAt: new Date(),
    },
  });
}
