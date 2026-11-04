// Shared seed definitions: baseline tests and bootstrap must use the same policy.
import { ProviderKind, RouteRuleKind } from '../generated/prisma/client.js';

export const defaultHeuristicRules = [
  {
    name: 'prompt-injection-language',
    category: 'prompt-injection',
    pattern: '(ignore previous|override system|developer message|do not obey)',
    score: 30,
    actionJson: JSON.stringify({ action: 'rerank', targetTag: 'safe-tools' }),
  },
  {
    name: 'dangerous-tool-language',
    category: 'dangerous-tooling',
    pattern: '(delete database|rm -rf|disable security|exfiltrate|credential dump)',
    score: 40,
    actionJson: JSON.stringify({ action: 'rerank', targetTag: 'safe-tools' }),
  },
  {
    name: 'reasoning-request-language',
    category: 'reasoning',
    pattern: '(show your chain of thought|show your reasoning|reason step by step)',
    score: 10,
    actionJson: JSON.stringify({ action: 'trace-detail', detail: 'high' }),
  },
  {
    name: 'secret-patterns',
    category: 'secrets',
    pattern: '(sk-[a-zA-Z0-9]{20,}|api[_-]?key|private[_-]?key|BEGIN PRIVATE KEY)',
    score: 25,
    actionJson: JSON.stringify({ action: 'rerank', targetTag: 'local-only' }),
  },
];

export const defaultRouteRules = [
  {
    name: 'passthrough-ollama-native',
    kind: RouteRuleKind.PASSTHROUGH,
    priority: 10,
    matchJson: JSON.stringify({ paths: ['/api/tags', '/api/show', '/api/ps', '/api/embed', '/api/generate', '/api/chat', '/api/pull'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.OLLAMA] }),
  },
  {
    name: 'passthrough-vllm-native',
    kind: RouteRuleKind.PASSTHROUGH,
    priority: 10,
    matchJson: JSON.stringify({ paths: ['/tokenize', '/detokenize', '/version'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.VLLM] }),
  },
];

export const ROUTING_PROFILE_ALIASES = [
  {
    alias: 'standard',
    upstreamModel: 'gpt-4o-mini',
    description: 'General chat, light summaries, and routine planning.',
  },
  {
    alias: 'dangerous',
    upstreamModel: 'claude-sonnet-4-20250514',
    description: 'Safety-critical prompts requiring strict reasoning and policy-aware output.',
  },
  {
    alias: 'internet_data',
    upstreamModel: 'deepseek/deepseek-v4-pro',
    description: 'Web/search-oriented and data-analysis workflows where external knowledge matters.',
  },
  {
    alias: 'hard',
    upstreamModel: 'deepseek/deepseek-v4-pro',
    description: 'Complex reasoning, hard coding, and multi-step planning tasks.',
  },
  {
    alias: 'coding',
    upstreamModel: 'gpt-5.3-codex-spark',
    description: 'Coding, debugging, refactoring, and implementation tasks routed to a coding-specialized Codex model.',
    providerSlug: 'openai-codex',
  },
];

export const ROUTING_PROFILE_RULES = [
  {
    name: 'route-standard-profile',
    kind: RouteRuleKind.MODEL_ALIAS,
    priority: 10,
    matchJson: JSON.stringify({ models: ['standard'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.OPENAI, ProviderKind.CODEX, ProviderKind.OPENAI_GENERIC, ProviderKind.OPENROUTER, ProviderKind.ANTHROPIC] }),
  },
  {
    name: 'route-dangerous-profile',
    kind: RouteRuleKind.MODEL_ALIAS,
    priority: 20,
    matchJson: JSON.stringify({ models: ['dangerous'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.ANTHROPIC, ProviderKind.OPENROUTER] }),
  },
  {
    name: 'route-internet-data-profile',
    kind: RouteRuleKind.MODEL_ALIAS,
    priority: 30,
    matchJson: JSON.stringify({ models: ['internet_data'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.OPENROUTER, ProviderKind.OPENAI, ProviderKind.OPENAI_GENERIC] }),
  },
  {
    name: 'route-hard-profile',
    kind: RouteRuleKind.MODEL_ALIAS,
    priority: 40,
    matchJson: JSON.stringify({ models: ['hard'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.CODEX, ProviderKind.OPENROUTER, ProviderKind.ANTHROPIC, ProviderKind.OPENAI] }),
  },
  {
    name: 'route-coding-profile',
    kind: RouteRuleKind.MODEL_ALIAS,
    priority: 45,
    matchJson: JSON.stringify({ models: ['coding'] }),
    actionJson: JSON.stringify({ providerKinds: [ProviderKind.CODEX, ProviderKind.OPENROUTER, ProviderKind.ANTHROPIC, ProviderKind.OPENAI] }),
  },
];
