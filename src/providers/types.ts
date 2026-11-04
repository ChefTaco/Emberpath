import type { Provider, ProviderKind } from '../generated/prisma/client.js';
import type { UsageSnapshot } from '../telemetry/tracing.js';

export type EndpointKind =
  | 'v1.models'
  | 'v1.responses'
  | 'v1.chat.completions'
  | 'v1.completions'
  | 'v1.embeddings'
  | 'v1.audio.transcriptions'
  | 'v1.audio.translations'
  | 'v1.images.generations'
  | 'v1.moderations'
  | 'ollama.native'
  | 'vllm.native';

export interface ProviderCapability {
  reasoning: boolean;
  tools: boolean;
  jsonSchema: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  embeddings: boolean;
  longContext: boolean;
  streaming: boolean;
  passthroughRoutes: string[];
  supportedRoutes: EndpointKind[];
  tags: string[];
  maxContextWindow?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  qualityScore?: number;
  throughputTokensPerSecond?: number;
}

export interface ProviderRuntime {
  id: string;
  slug: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authHeaderName: string;
  authMode: 'NONE' | 'BEARER' | 'API_KEY' | 'HEADER';
  authSecret?: string | undefined;
  defaultHeaders: Record<string, string>;
  capabilities: ProviderCapability;
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  priority: number;
  weight: number;
  failoverGroup?: string | undefined;
  provider: Provider;
}

export interface RouteRequest {
  signal?: AbortSignal;
  requestId: string;
  method: string;
  path: string;
  queryString: string;
  endpointKind: EndpointKind;
  routeKey: string;
  model?: string | undefined;
  routingTrait?: string | undefined;
  stream: boolean;
  toolsRequested: boolean;
  jsonSchemaRequested: boolean;
  modalities: string[];
  contentType?: string | undefined;
  headers: Record<string, string>;
  requestBodyText?: string | undefined;
  requestBodyJson?: unknown;
  bodyBuffer?: Uint8Array | undefined;
}

export interface RouteObservation {
  name: string;
  category: string;
  score: number;
  action: string;
  details?: string | undefined;
}

export interface RouteDecision {
  selectedProviderId?: string | undefined;
  selectedProviderKind?: ProviderKind | undefined;
  targetModel?: string | undefined;
  candidateProviderIds: string[];
  fallbackProviderIds: string[];
  observations: RouteObservation[];
  triggeredRuleNames: string[];
  confidence: number;
  denialReason?: string | undefined;
  passthroughTargetPath?: string | undefined;
}

export interface ProviderExecution {
  response: Response;
  providerModel?: string | undefined;
  usage?: UsageSnapshot | undefined;
  reasoningText?: string | undefined;
  tracePromise?: Promise<{
    responseBody?: string | undefined;
    reasoningText?: string | undefined;
    usage?: UsageSnapshot | undefined;
    firstByteMs?: number | undefined;
  }>;
}

export interface DiscoveredModel {
  model: string;
  displayName?: string | undefined;
  maxContextWindow?: number | undefined;
  capabilities?: Partial<ProviderCapability> | undefined;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution>;
  healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }>;
  discoverModels?(provider: ProviderRuntime): Promise<DiscoveredModel[]>;
}
