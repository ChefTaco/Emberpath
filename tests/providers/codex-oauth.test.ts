import { AuthMode, ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexOAuthAdapter,
  exchangeCodexAuthorizationCode,
  requestCodexDeviceCode,
  serializeCodexTokenBundle,
  type CodexOAuthTokenBundle,
} from '../../src/providers/codex-oauth.js';
import type { ProviderRuntime, RouteRequest } from '../../src/providers/types.js';
import { decryptText, encryptText } from '../../src/security/crypto.js';
import { prisma } from '../../src/storage/client.js';

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

function buildProvider(): Provider {
  const now = new Date('2026-05-30T00:00:00.000Z');
  return {
    id: 'provider_codex',
    slug: 'openai-codex',
    name: 'OpenAI Codex',
    kind: ProviderKind.CODEX,
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authMode: AuthMode.BEARER,
    authHeaderName: 'Authorization',
    encryptedAuthSecret: null,
    defaultHeadersJson: '{}',
    capabilityJson: '{}',
    passthroughJson: '[]',
    tlsInsecure: false,
    timeoutMs: 120000,
    maxRetries: 1,
    concurrency: 4,
    priority: 35,
    weight: 135,
    failoverGroup: null,
    enabled: true,
    lastHealthStatus: null,
    lastHealthError: null,
    lastHealthAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildRuntime(tokens: CodexOAuthTokenBundle): ProviderRuntime {
  const provider = buildProvider();
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    authHeaderName: provider.authHeaderName,
    authMode: 'BEARER',
    authSecret: serializeCodexTokenBundle(tokens),
    defaultHeaders: { version: 'hive-router-test' },
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
      passthroughRoutes: [],
      supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions'],
      tags: ['codex', 'subscription'],
    },
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    concurrency: provider.concurrency,
    priority: provider.priority,
    weight: provider.weight,
    provider,
  };
}

function buildChatRoute(): RouteRequest {
  const body = {
    model: 'standard',
    messages: [{ role: 'user', content: 'hello codex' }],
    temperature: 0.2,
    max_tokens: 128,
  };
  return {
    requestId: 'req_codex_1',
    method: 'POST',
    path: '/v1/chat/completions',
    queryString: '',
    endpointKind: 'v1.chat.completions',
    routeKey: 'POST /v1/chat/completions',
    model: 'gpt-5.3-codex',
    stream: false,
    toolsRequested: false,
    jsonSchemaRequested: false,
    modalities: [],
    headers: { 'content-type': 'application/json', authorization: 'Bearer downstream' },
    requestBodyJson: body,
    requestBodyText: JSON.stringify(body),
    bodyBuffer: new TextEncoder().encode(JSON.stringify(body)),
  };
}

describe('providers/codex-oauth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the OpenAI Codex device authorization flow', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_auth_id: 'device_123',
        user_code: 'ABCD-EFGH',
        interval: '2',
      }),
    );

    const device = await requestCodexDeviceCode(fetchMock as unknown as typeof fetch);

    expect(device).toMatchObject({
      deviceAuthId: 'device_123',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      intervalSeconds: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
      }),
    );
  });

  it('exchanges an authorized device code into a stored token bundle', async () => {
    const accessToken = jwt({
      exp: 1780000000,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
        chatgpt_plan_type: 'plus',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: accessToken,
        refresh_token: 'refresh_123',
        id_token: jwt({}),
      }),
    );

    const bundle = await exchangeCodexAuthorizationCode(
      {
        authorizationCode: 'auth_123',
        codeChallenge: 'challenge_123',
        codeVerifier: 'verifier_123',
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(bundle).toMatchObject({
      accessToken,
      refreshToken: 'refresh_123',
      accountId: 'acct_123',
      planType: 'plus',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(String(init.body)).toContain('code=auth_123');
  });

  it('routes chat completions through the Codex Responses backend using OAuth headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        id: 'resp_123',
        output_text: 'codex says hello',
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7,
        },
      }),
    );

    const adapter = new CodexOAuthAdapter();
    const execution = await adapter.execute(
      buildChatRoute(),
      buildRuntime({
        accessToken: 'access_123',
        refreshToken: 'refresh_123',
        accountId: 'acct_123',
        lastRefreshAt: new Date().toISOString(),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/responses',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer access_123');
    expect(headers.get('ChatGPT-Account-ID')).toBe('acct_123');
    expect(headers.get('version')).toBe('hive-router-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.3-codex',
      input: [{ role: 'user', content: 'hello codex' }],
      instructions: expect.stringContaining('Codex'),
      store: false,
      stream: true,
    });

    expect(await execution.response.json()).toMatchObject({
      id: 'resp_123',
      choices: [{ message: { content: 'codex says hello' } }],
    });
    expect(execution.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      reasoningTokens: undefined,
    });
  });
});

describe('providers/codex-oauth token refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const expired = (): CodexOAuthTokenBundle => ({
    accessToken: 'access_old',
    refreshToken: 'refresh_old',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    lastRefreshAt: new Date().toISOString(),
  });

  /** A stored provider row that updates like the database would, and a token endpoint that rotates. */
  function harness(stored: CodexOAuthTokenBundle) {
    const state = { secret: encryptText(JSON.stringify(stored)), refreshes: [] as string[], health: [] as unknown[] };
    vi.spyOn(prisma.provider, 'findUnique').mockImplementation((async () => ({ encryptedAuthSecret: state.secret })) as never);
    vi.spyOn(prisma.provider, 'update').mockImplementation((async ({ data }: { data: { encryptedAuthSecret: string; lastHealthStatus?: string } }) => {
      state.secret = data.encryptedAuthSecret;
      if (data.lastHealthStatus) state.health.push(data.lastHealthStatus);
      return {};
    }) as never);
    const upstreamTokens: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).endsWith('/oauth/token')) {
        const presented = (JSON.parse(String(init.body)) as { refresh_token: string }).refresh_token;
        state.refreshes.push(presented);
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Refresh tokens rotate: only the first presentation of one is honoured.
        if (state.refreshes.filter((token) => token === presented).length > 1) {
          return Response.json({ error: 'refresh_token_reused' }, { status: 401 });
        }
        return Response.json({ access_token: 'access_new', refresh_token: 'refresh_new' });
      }
      upstreamTokens.push(new Headers(init.headers).get('authorization') ?? '');
      return Response.json({ id: 'resp_1', output_text: 'ok' });
    }) as never);
    return { state, upstreamTokens, bundle: () => JSON.parse(decryptText(state.secret)) as CodexOAuthTokenBundle };
  }

  it('refreshes once when concurrent requests all hold the expiring token', async () => {
    const { state, upstreamTokens, bundle } = harness(expired());
    const adapter = new CodexOAuthAdapter();

    const executions = await Promise.all([1, 2, 3].map(() => adapter.execute(buildChatRoute(), buildRuntime(expired()))));

    expect(executions.map((execution) => execution.response.status)).toEqual([200, 200, 200]);
    expect(state.refreshes).toEqual(['refresh_old']);
    expect(upstreamTokens).toEqual(['Bearer access_new', 'Bearer access_new', 'Bearer access_new']);
    expect(bundle()).toMatchObject({ accessToken: 'access_new', refreshToken: 'refresh_new' });
    expect(bundle().refreshTokenQuarantined).toBeFalsy();
    expect(state.health).toEqual([]);
  });

  it('uses the stored bundle when its own snapshot predates a finished refresh', async () => {
    const { state, upstreamTokens, bundle } = harness(expired());
    const adapter = new CodexOAuthAdapter();

    await adapter.execute(buildChatRoute(), buildRuntime(expired()));
    // A request that loaded the provider before the refresh above was stored.
    const late = await adapter.execute(buildChatRoute(), buildRuntime(expired()));

    expect(late.response.status).toBe(200);
    expect(state.refreshes).toEqual(['refresh_old']);
    expect(upstreamTokens).toEqual(['Bearer access_new', 'Bearer access_new']);
    expect(bundle().refreshTokenQuarantined).toBeFalsy();
  });

  it('still quarantines a refresh token the issuer rejects', async () => {
    const { state, bundle } = harness(expired());
    state.refreshes.push('refresh_old');

    await expect(new CodexOAuthAdapter().execute(buildChatRoute(), buildRuntime(expired()))).rejects.toThrow('Codex OAuth token refresh failed');

    expect(bundle()).toMatchObject({ accessToken: 'access_old', refreshTokenQuarantined: true });
    expect(state.health).toEqual(['unhealthy']);
  });
});
