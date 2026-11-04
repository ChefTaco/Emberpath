import { AuthMode, ProviderKind } from '../generated/prisma/client.js';
import { prisma } from '../storage/client.js';
import { encryptText } from '../security/crypto.js';
import { shouldForwardClientHeader } from '../security/headers.js';
import { buildProviderCreateData } from './runtime.js';
import type { UsageSnapshot } from '../telemetry/tracing.js';
import type { ProviderAdapter, ProviderExecution, ProviderRuntime, RouteRequest } from './types.js';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_PROVIDER_SLUG = 'openai-codex';
export const CODEX_PROVIDER_NAME = 'OpenAI Codex';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_DEFAULT_MODEL = 'gpt-5.3-codex';

const CODEX_REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_REFRESH_SKEW_MS = 60 * 1000;

type FetchLike = typeof fetch;

interface JsonObject {
  [key: string]: unknown;
}

export interface CodexOAuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  planType?: string;
  expiresAt?: string;
  lastRefreshAt?: string;
  refreshTokenQuarantined?: boolean;
}

export interface CodexDeviceCode {
  loginId?: string;
  deviceAuthId: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

export interface CodexDevicePollSuccess {
  authorizationCode: string;
  codeChallenge: string;
  codeVerifier: string;
}

export interface CodexOAuthStatus {
  authorized: boolean;
  providerId?: string;
  accountIdMasked?: string | null;
  planType?: string | null;
  lastRefreshAt?: string | null;
  refreshTokenQuarantined?: boolean;
}

interface TokenEndpointResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

function authBaseUrl(issuer = CODEX_OAUTH_ISSUER): string {
  return `${issuer.replace(/\/$/, '')}/api/accounts`;
}

function tokenEndpoint(issuer = CODEX_OAUTH_ISSUER): string {
  return `${issuer.replace(/\/$/, '')}/oauth/token`;
}

function verificationUrl(issuer = CODEX_OAUTH_ISSUER): string {
  return `${issuer.replace(/\/$/, '')}/codex/device`;
}

function redirectUri(issuer = CODEX_OAUTH_ISSUER): string {
  return `${issuer.replace(/\/$/, '')}/deviceauth/callback`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInterval(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.round(parsed));
    }
  }
  return 5;
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseJwtClaims(token: string | undefined): JsonObject {
  if (!token) {
    return {};
  }
  const [, payload] = token.split('.');
  if (!payload) {
    return {};
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function authClaims(token: string | undefined): JsonObject {
  const claims = parseJwtClaims(token);
  const nested = claims['https://api.openai.com/auth'];
  return isObject(nested) ? nested : claims;
}

function stringClaim(claims: JsonObject, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function expiryFromJwt(token: string | undefined): string | undefined {
  const claims = parseJwtClaims(token);
  const exp = claims['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined;
}

export function parseCodexTokenBundle(secret: string | undefined): CodexOAuthTokenBundle | null {
  if (!secret) {
    return null;
  }

  try {
    const parsed = JSON.parse(secret) as unknown;
    if (!isObject(parsed) || typeof parsed.accessToken !== 'string' || !parsed.accessToken.trim()) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
      ...(typeof parsed.idToken === 'string' ? { idToken: parsed.idToken } : {}),
      ...(typeof parsed.accountId === 'string' ? { accountId: parsed.accountId } : {}),
      ...(typeof parsed.planType === 'string' ? { planType: parsed.planType } : {}),
      ...(typeof parsed.expiresAt === 'string' ? { expiresAt: parsed.expiresAt } : {}),
      ...(typeof parsed.lastRefreshAt === 'string' ? { lastRefreshAt: parsed.lastRefreshAt } : {}),
      ...(parsed.refreshTokenQuarantined === true ? { refreshTokenQuarantined: true } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeCodexTokenBundle(bundle: CodexOAuthTokenBundle): string {
  return JSON.stringify(bundle);
}

export function buildCodexTokenBundle(tokens: TokenEndpointResponse): CodexOAuthTokenBundle {
  if (!tokens.access_token) {
    throw new Error('Codex OAuth response did not include an access token');
  }

  const idAuth = authClaims(tokens.id_token);
  const accessAuth = authClaims(tokens.access_token);
  const accountId = stringClaim(idAuth, 'chatgpt_account_id') ?? stringClaim(accessAuth, 'chatgpt_account_id');
  const planType = stringClaim(accessAuth, 'chatgpt_plan_type') ?? stringClaim(idAuth, 'chatgpt_plan_type');
  const expiresAt = expiryFromJwt(tokens.access_token);

  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    ...(accountId ? { accountId } : {}),
    ...(planType ? { planType } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    lastRefreshAt: new Date().toISOString(),
  };
}

function shouldRefresh(bundle: CodexOAuthTokenBundle): boolean {
  if (!bundle.refreshToken || bundle.refreshTokenQuarantined) {
    return false;
  }

  const expiresAt = bundle.expiresAt ? Date.parse(bundle.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + CODEX_REFRESH_SKEW_MS) {
    return true;
  }

  const lastRefreshAt = bundle.lastRefreshAt ? Date.parse(bundle.lastRefreshAt) : Number.NaN;
  return !Number.isFinite(lastRefreshAt) || Date.now() - lastRefreshAt >= CODEX_REFRESH_MAX_AGE_MS;
}

async function readErrorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return `HTTP ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: string | { message?: string; code?: string }; error_description?: string };
    if (typeof parsed.error_description === 'string') return parsed.error_description;
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.error?.code) return parsed.error.code;
  } catch {
    // Preserve the provider text for the caller without trying to log secrets.
  }
  return text;
}

export async function requestCodexDeviceCode(fetchImpl: FetchLike = fetch): Promise<CodexDeviceCode> {
  const response = await fetchImpl(`${authBaseUrl()}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
  });

  if (!response.ok) {
    throw new Error(`Codex device-code request failed: ${await readErrorText(response)}`);
  }

  const payload = (await response.json()) as JsonObject;
  const deviceAuthId = typeof payload.device_auth_id === 'string' ? payload.device_auth_id : '';
  const userCode = typeof payload.user_code === 'string'
    ? payload.user_code
    : typeof payload.usercode === 'string'
      ? payload.usercode
      : '';

  if (!deviceAuthId || !userCode) {
    throw new Error('Codex device-code response was missing device_auth_id or user_code');
  }

  return {
    deviceAuthId,
    verificationUrl: verificationUrl(),
    userCode,
    intervalSeconds: parseInterval(payload.interval),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

export async function pollCodexDeviceCode(
  deviceCode: Pick<CodexDeviceCode, 'deviceAuthId' | 'userCode' | 'intervalSeconds'>,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: 'pending' } | ({ status: 'authorized' } & CodexDevicePollSuccess) | { status: 'error'; message: string }> {
  const response = await fetchImpl(`${authBaseUrl()}/deviceauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: deviceCode.deviceAuthId,
      user_code: deviceCode.userCode,
    }),
  });

  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' };
  }

  if (!response.ok) {
    return { status: 'error', message: await readErrorText(response) };
  }

  const payload = (await response.json()) as JsonObject;
  const authorizationCode = typeof payload.authorization_code === 'string' ? payload.authorization_code : '';
  const codeChallenge = typeof payload.code_challenge === 'string' ? payload.code_challenge : '';
  const codeVerifier = typeof payload.code_verifier === 'string' ? payload.code_verifier : '';

  if (!authorizationCode || !codeChallenge || !codeVerifier) {
    return { status: 'error', message: 'Codex device authorization response was incomplete' };
  }

  return {
    status: 'authorized',
    authorizationCode,
    codeChallenge,
    codeVerifier,
  };
}

export async function exchangeCodexAuthorizationCode(
  authorization: CodexDevicePollSuccess,
  fetchImpl: FetchLike = fetch,
): Promise<CodexOAuthTokenBundle> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorization.authorizationCode,
    redirect_uri: redirectUri(),
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: authorization.codeVerifier,
  });

  const response = await fetchImpl(tokenEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Codex OAuth token exchange failed: ${await readErrorText(response)}`);
  }

  return buildCodexTokenBundle((await response.json()) as TokenEndpointResponse);
}

export async function refreshCodexTokenBundle(
  bundle: CodexOAuthTokenBundle,
  fetchImpl: FetchLike = fetch,
): Promise<CodexOAuthTokenBundle> {
  if (!bundle.refreshToken || bundle.refreshTokenQuarantined) {
    throw new Error('Codex OAuth refresh token is unavailable; reauthorize Codex');
  }

  const response = await fetchImpl(tokenEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
    }),
  });

  if (!response.ok) {
    const message = await readErrorText(response);
    if (response.status === 401) {
      bundle.refreshTokenQuarantined = true;
    }
    throw new Error(`Codex OAuth token refresh failed: ${message}`);
  }

  const refreshed = buildCodexTokenBundle((await response.json()) as TokenEndpointResponse);
  return {
    ...bundle,
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? bundle.refreshToken,
    refreshTokenQuarantined: false,
  };
}

export function buildCodexProviderData(bundle: CodexOAuthTokenBundle) {
  return buildProviderCreateData({
    slug: CODEX_PROVIDER_SLUG,
    name: CODEX_PROVIDER_NAME,
    kind: ProviderKind.CODEX,
    baseUrl: CODEX_BASE_URL,
    authMode: AuthMode.BEARER,
    authHeaderName: 'Authorization',
    encryptedAuthSecret: encryptText(serializeCodexTokenBundle(bundle)),
    capabilities: {
      reasoning: true,
      tools: true,
      jsonSchema: true,
      vision: false,
      audio: false,
      video: false,
      embeddings: false,
      longContext: true,
      streaming: false,
      supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions'],
      tags: ['codex', 'subscription', 'long-context', 'safe-tools'],
      maxContextWindow: 200000,
    },
    defaultHeaders: {
      version: 'hive-router',
    },
    timeoutMs: 180000,
    maxRetries: 1,
    concurrency: 4,
    priority: 35,
    weight: 135,
    failoverGroup: 'subscription-frontier',
    enabled: true,
  });
}

export async function upsertCodexOAuthProvider(bundle: CodexOAuthTokenBundle) {
  const provider = await prisma.provider.upsert({
    where: { slug: CODEX_PROVIDER_SLUG },
    create: buildCodexProviderData(bundle),
    update: buildCodexProviderData(bundle),
  });

  await prisma.providerModel.upsert({
    where: {
      providerId_model: {
        providerId: provider.id,
        model: CODEX_DEFAULT_MODEL,
      },
    },
    create: {
      providerId: provider.id,
      model: CODEX_DEFAULT_MODEL,
      displayName: 'OpenAI Codex',
      enabled: true,
      maxContextWindow: 200000,
    },
    update: {
      displayName: 'OpenAI Codex',
      enabled: true,
      maxContextWindow: 200000,
    },
  });

  return prisma.provider.findUniqueOrThrow({
    where: { id: provider.id },
    include: { models: true },
  });
}

function buildCodexUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/responses') ? normalized : `${normalized}/responses`;
}

function copyRequestHeaders(route: RouteRequest, provider: ProviderRuntime, bundle: CodexOAuthTokenBundle): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(route.headers)) {
    if (shouldForwardClientHeader(key)) {
      headers.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(provider.defaultHeaders)) {
    headers.set(key, value);
  }

  headers.set('authorization', `Bearer ${bundle.accessToken}`);
  headers.set('content-type', 'application/json');
  if (bundle.accountId) {
    headers.set('ChatGPT-Account-ID', bundle.accountId);
  }
  return headers;
}

function normalizeMessageContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content;
  }
  return content ?? '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!isObject(part)) return '';
      const text = part.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function defaultCodexInstructions(): string {
  return 'You are Codex, an OpenAI coding agent. Follow the user request directly and keep the response concise.';
}

function requestBodyObject(route: RouteRequest): JsonObject {
  if (isObject(route.requestBodyJson)) {
    return route.requestBodyJson;
  }
  if (route.requestBodyText) {
    try {
      const parsed = JSON.parse(route.requestBodyText) as unknown;
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function buildResponsesBody(route: RouteRequest): JsonObject {
  const input = requestBodyObject(route);
  const model = route.model ?? (typeof input.model === 'string' ? input.model : CODEX_DEFAULT_MODEL);

  if (route.endpointKind === 'v1.responses') {
    return {
      ...input,
      model,
      instructions: typeof input.instructions === 'string' && input.instructions.trim()
        ? input.instructions
        : defaultCodexInstructions(),
      store: false,
      stream: true,
    };
  }

  if (route.endpointKind === 'v1.completions') {
    return {
      model,
      instructions: defaultCodexInstructions(),
      input: input.prompt ?? '',
      store: false,
      stream: true,
    };
  }

  const messages = Array.isArray(input.messages) ? input.messages : [];
  const instructions = messages
    .filter((message) => isObject(message) && (message.role === 'system' || message.role === 'developer'))
    .map((message) => contentToText((message as JsonObject).content))
    .filter(Boolean)
    .join('\n\n') || defaultCodexInstructions();

  return {
    model,
    input: messages
      .filter(isObject)
      .filter((message) => message.role !== 'system' && message.role !== 'developer')
      .map((message) => ({
        role: typeof message.role === 'string' ? message.role : 'user',
        content: normalizeMessageContent(message.content),
      })),
    instructions,
    store: false,
    stream: true,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.tool_choice !== undefined ? { tool_choice: input.tool_choice } : {}),
    ...(input.response_format !== undefined ? { response_format: input.response_format } : {}),
  };
}

function extractOutputText(payload: JsonObject): string {
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && isObject(choices[0])) {
    const message = choices[0].message;
    if (isObject(message) && typeof message.content === 'string') {
      return message.content;
    }
  }

  const output = payload.output;
  if (!Array.isArray(output)) {
    return '';
  }

  const chunks: string[] = [];
  for (const item of output) {
    if (!isObject(item)) continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isObject(part)) continue;
      const text = typeof part.text === 'string'
        ? part.text
        : typeof part.output_text === 'string'
          ? part.output_text
          : '';
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n').trim();
}

function usageFromPayload(payload: JsonObject): UsageSnapshot | undefined {
  const usage = payload.usage;
  if (!isObject(usage)) {
    return undefined;
  }
  const numberValue = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === 'number' ? value : undefined;
  };
  return {
    inputTokens: numberValue('input_tokens') ?? numberValue('prompt_tokens'),
    outputTokens: numberValue('output_tokens') ?? numberValue('completion_tokens'),
    totalTokens: numberValue('total_tokens'),
    reasoningTokens: numberValue('reasoning_tokens'),
  };
}

function usagePayloadFromSnapshot(usage: UsageSnapshot | undefined): JsonObject | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
  };
}

function extractStreamEventText(payload: JsonObject): { delta?: string; final?: string; usage?: UsageSnapshot } {
  const type = typeof payload.type === 'string' ? payload.type : '';
  const delta = typeof payload.delta === 'string'
    ? payload.delta
    : typeof payload.text === 'string' && type.includes('delta')
      ? payload.text
      : undefined;
  const response = isObject(payload.response) ? payload.response : undefined;
  const final = response ? extractOutputText(response) : extractOutputText(payload);
  const usage = response ? usageFromPayload(response) : usageFromPayload(payload);
  return {
    ...(delta ? { delta } : {}),
    ...(final ? { final } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseCodexStreamPayload(text: string): { outputText: string; usage?: UsageSnapshot; rawEvents: JsonObject[] } {
  const deltas: string[] = [];
  let finalText = '';
  let usage: UsageSnapshot | undefined;
  const rawEvents: JsonObject[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }

    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isObject(parsed)) {
        continue;
      }
      rawEvents.push(parsed);
      const extracted = extractStreamEventText(parsed);
      if (extracted.delta) {
        deltas.push(extracted.delta);
      }
      if (extracted.final) {
        finalText = extracted.final;
      }
      if (extracted.usage) {
        usage = extracted.usage;
      }
    } catch {
      // Ignore malformed SSE fragments.
    }
  }

  return {
    outputText: deltas.join('').trim() || finalText.trim(),
    ...(usage ? { usage } : {}),
    rawEvents,
  };
}

function looksLikeSse(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('event:') || trimmed.startsWith('data:');
}

function responsesApiResponse(route: RouteRequest, outputText: string, usage: UsageSnapshot | undefined): Response {
  return Response.json({
    id: `resp_${route.requestId}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: route.model ?? CODEX_DEFAULT_MODEL,
    output_text: outputText,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: outputText }],
      },
    ],
    ...(usage ? { usage: usagePayloadFromSnapshot(usage) } : {}),
  });
}

function chatCompletionResponse(route: RouteRequest, payload: JsonObject): Response {
  const id = typeof payload.id === 'string' ? payload.id : `chatcmpl-${route.requestId}`;
  const model = route.model ?? CODEX_DEFAULT_MODEL;
  const usage = isObject(payload.usage) ? payload.usage : undefined;
  const body = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: extractOutputText(payload),
        },
        finish_reason: 'stop',
      },
    ],
    ...(usage ? { usage } : {}),
  };
  return Response.json(body);
}

async function updateStoredBundle(providerId: string, bundle: CodexOAuthTokenBundle): Promise<void> {
  const data: {
    encryptedAuthSecret: string;
    lastHealthStatus?: string;
    lastHealthError?: string;
    lastHealthAt?: Date;
  } = {
    encryptedAuthSecret: encryptText(serializeCodexTokenBundle(bundle)),
  };
  if (bundle.refreshTokenQuarantined) {
    data.lastHealthStatus = 'unhealthy';
    data.lastHealthError = 'Codex OAuth refresh token needs reauthorization';
    data.lastHealthAt = new Date();
  }

  await prisma.provider.update({
    where: { id: providerId },
    data,
  });
}

async function freshTokenBundle(provider: ProviderRuntime): Promise<CodexOAuthTokenBundle | null> {
  const bundle = parseCodexTokenBundle(provider.authSecret);
  if (!bundle) {
    return null;
  }
  if (!shouldRefresh(bundle)) {
    return bundle;
  }

  try {
    const refreshed = await refreshCodexTokenBundle(bundle);
    await updateStoredBundle(provider.id, refreshed);
    return refreshed;
  } catch (error) {
    if (bundle.refreshTokenQuarantined) {
      await updateStoredBundle(provider.id, bundle);
    }
    throw error;
  }
}

async function runCodexRequest(route: RouteRequest, provider: ProviderRuntime, bundle: CodexOAuthTokenBundle): Promise<ProviderExecution> {
  if (route.endpointKind === 'v1.models') {
    return {
      response: Response.json({
        object: 'list',
        data: [
          {
            id: CODEX_DEFAULT_MODEL,
            object: 'model',
            owned_by: 'openai-codex',
          },
        ],
      }),
      providerModel: CODEX_DEFAULT_MODEL,
    };
  }

  const body = JSON.stringify(buildResponsesBody(route));
  const response = await fetch(buildCodexUrl(provider.baseUrl), {
    method: 'POST',
    headers: copyRequestHeaders(route, provider, bundle),
    body,
    signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
  });

  if (!response.ok || route.endpointKind === 'v1.responses') {
    if (response.ok) {
      const responseText = await response.text();
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream') || looksLikeSse(responseText)) {
        const streamPayload = parseCodexStreamPayload(responseText);
        return {
          response: responsesApiResponse(route, streamPayload.outputText, streamPayload.usage),
          providerModel: route.model,
          usage: streamPayload.usage,
        };
      }

      return {
        response: new Response(responseText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        providerModel: route.model,
      };
    }

    let usage: UsageSnapshot | undefined;
    try {
      usage = usageFromPayload((await response.clone().json()) as JsonObject);
    } catch {
      usage = undefined;
    }
    return {
      response,
      providerModel: route.model,
      usage,
    };
  }

  const responseText = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream') || looksLikeSse(responseText)) {
    const streamPayload = parseCodexStreamPayload(responseText);
    const payload = {
      id: `resp_${route.requestId}`,
      output_text: streamPayload.outputText,
      ...(streamPayload.usage ? { usage: usagePayloadFromSnapshot(streamPayload.usage) } : {}),
    };
    return {
      response: chatCompletionResponse(route, payload),
      providerModel: route.model,
      usage: streamPayload.usage,
    };
  }

  try {
    const payload = JSON.parse(responseText) as JsonObject;
    return {
      response: chatCompletionResponse(route, payload),
      providerModel: route.model,
      usage: usageFromPayload(payload),
    };
  } catch (error) {
    return {
      response: Response.json({ error: error instanceof Error ? error.message : 'Invalid Codex response' }, { status: 502 }),
      providerModel: route.model,
    };
  }
}

export class CodexOAuthAdapter implements ProviderAdapter {
  readonly kind = ProviderKind.CODEX;

  async execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution> {
    const bundle = await freshTokenBundle(provider);
    if (!bundle?.accessToken) {
      return {
        response: Response.json({ error: 'OpenAI Codex is not authorized. Authorize Codex OAuth from Providers.' }, { status: 401 }),
        providerModel: route.model,
      };
    }

    const first = await runCodexRequest(route, provider, bundle);
    if (first.response.status !== 401 || !bundle.refreshToken || bundle.refreshTokenQuarantined) {
      return first;
    }

    const refreshed = await refreshCodexTokenBundle(bundle);
    await updateStoredBundle(provider.id, refreshed);
    return runCodexRequest(route, provider, refreshed);
  }

  async healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }> {
    const bundle = parseCodexTokenBundle(provider.authSecret);
    if (!bundle?.accessToken) {
      return { healthy: false, error: 'Codex OAuth is not authorized' };
    }
    if (bundle.refreshTokenQuarantined) {
      return { healthy: false, error: 'Codex OAuth refresh token needs reauthorization' };
    }
    return { healthy: true };
  }
}
