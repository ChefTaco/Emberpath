import { maintenanceActive } from '../release/runtime.js';
import { metadata } from '../release/runtime.js';
import { packageRoot as releasePackageRoot } from '../config/paths.js';
import { compatibilityWarnings, coordinatorRequest, durableUpgradeStatus, home as upgradeHome, ownRelease, projectFile, updateStatus } from '../release/runtime.js';
import { UpgradeApplyRequest, UpgradePlanRequest } from '../contracts/upgrades.js';
import { HTTPException } from 'hono/http-exception';
import { actorJournal, actorJournalWrite } from './actor-journal-runtime.js';
import type { ActorLease, ActorStep } from './actor-journal.js';
import { routingPatchSchema, routingSnapshot, applyRoutingRevision, routingHistory, savedRoutingRevision } from '../routing/revisions.js';
import { MemoryWriteSchema } from '../contracts/memory-operations.js';
import { AuthMode, ProviderKind, RouteRuleKind, type AdminUser, type ClientApiKey } from '../generated/prisma/client.js';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  metricsRegistry,
  securityExporterAuthCounter,
} from '../telemetry/metrics.js';
import type { AppVariables } from '../types/app.js';
import { requestIdMiddleware } from '../utils/request.js';
import { authenticateAdmin, createAdminSession, destroyAdminSession, requireAdminAuth, verifyAdminSession } from '../security/admin-auth.js';
import { requestIamClientCredentialsToken } from '../security/iam-oidc.js';
import { hiveMemTlsOptions, iamTlsOptions } from '../security/iam-tls.js';
import { decryptText, digestText, encryptText, generateOpenAiStyleApiKey, hashValue, maskSecret, safeEqualText, verifyHash } from '../security/crypto.js';
import { applyAdminSecurityHeaders } from '../security/headers.js';
import { prisma } from '../storage/client.js';
import { getProviderAdapter, listProviderRuntimes } from '../providers/index.js';
import { buildProviderCreateData, parseProviderRuntime } from '../providers/runtime.js';
import { discoverAndReconcileProviderModels } from '../providers/discovery.js';
import {
  exchangeCodexAuthorizationCode,
  parseCodexTokenBundle,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
  upsertCodexOAuthProvider,
  type CodexDeviceCode,
} from '../providers/codex-oauth.js';
import { recordAuditEvent } from '../storage/audit.js';
import { buildRouterOpenApiDocument, builtinApiDocs } from '../openapi/spec.js';
import { loadEnv } from '../config/env.js';
import { uiDistDir } from '../config/paths.js';
import { buildRouterDependencyReport } from '../status/router-health.js';
import { getSecurityExporterJwksStatus } from '../security/security-exporter-jwks-status.js';
import { inspectTlsCertificate } from '../status/tls-certificate.js';
import {
  mapServiceHealthState,
  normalizeIamHealthPayload,
  normalizeMemoryHealthPayload,
  requestIamHealth,
  requestMemoryHealth,
  type HiveAppKey,
  type HiveAppStatus,
  type HiveStatusResponse,
  type ServiceHealthPayload,
} from '../status/service-health.js';
import { safeJsonParse } from '../utils/json.js';
import { resolveRoute } from '../routing/service.js';
import { resolveAdaptiveScores, ADAPTIVE_SETTING_KEY } from '../routing/adaptive.js';
import { parseRoutingObjectiveConfig, loadRoutingObjectiveConfig, ROUTING_OBJECTIVE_SETTING_KEY } from '../routing/objective.js';
import { computeClientKeyUsage, quotaLedger, evaluateQuota, readClientKeyQuota } from '../security/quota.js';
import {
  authorizeSecurityExporterToken,
  SECURITY_EXPORTER_RETRY_AFTER_SECONDS,
  type SecurityExporterAuthResult,
} from '../security/security-exporter-auth.js';
import {
  mapSecurityExportEvent,
  securityExportWhere,
} from '../security/security-export.js';
import { withResolvedRouteModel } from '../routing/request-body.js';
import type { ProviderCapability, ProviderRuntime, RouteRequest } from '../providers/types.js';
import { log } from '../telemetry/logger.js';
import {
  adaptiveRoutingSchema,
  clientKeySchema,
  clientKeyUpdateSchema,
  configImportSchema,
  heuristicSchema,
  modelAliasSchema,
  providerModelSchema,
  providerSchema,
  routingObjectiveSchema,
  routeRuleSchema,
  type ModelAliasInput,
  type ProviderModelInput,
} from './schemas.js';
import { buildHiveActors, buildIncidentTimeline, type HiveActor } from './unified-views.js';

const routingTestRequestSchema = z.object({
  category: z.string().optional(),
  modelAlias: z.string().min(1),
  prompt: z.string().min(1),
  maxResponseChars: z.number().int().min(120).max(8192).optional().default(1500),
});

const actorCreateSchema = z.object({
  agentId: z.string().min(2).max(32).regex(/^[a-z0-9_-]+$/u),
  displayName: z.string().min(2).max(128),
  description: z.string().max(512).optional().default(''),
  iamClientId: z.string().min(1),
  roleIds: z.array(z.string().min(1)).optional().default([]),
  scopes: z.array(z.string().min(1)).optional().default([
      'memories:read',
      'memories:write',
      'sessions:read',
      'sessions:write',
      'context:read',
      'agents:read',
      'workspaces:read',
      'workspaces:write',
      'webhooks:read',
      'webhooks:write',
      'queue:read',
    ]),
  hostLabel: z.string().max(128).optional().default(''),
  workspaceId: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/).default('default'),
  owningProject: z.string().max(100).default(''),
  expiresHours: z.number().int().min(1).max(720).default(24),
  allowedIps: z.array(z.string().min(1)).optional().default([]),
});

const actorLifecycleSchema = z.object({
  operationId: z.guid().optional(),
  kind: z.enum(['user', 'service-account', 'system-user', 'router-key', 'memory-agent']).optional(),
  label: z.string().optional(),
  identifiers: z.record(z.string(), z.unknown()).optional().default({}),
});

const DEFAULT_MEMORY_AGENT_SCOPES = [
  'memories:read',
  'memories:write',
  'sessions:read',
  'sessions:write',
  'context:read',
  'agents:read',
  'workspaces:read',
  'workspaces:write',
  'webhooks:read',
  'webhooks:write',
  'queue:read',
] as const;

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function shouldFailoverStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function resolveResponsePreview(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
      output_text?: string;
      content?: string;
    };

    if (typeof parsed.output_text === 'string' && parsed.output_text.trim()) {
      return parsed.output_text.trim();
    }

    const messageContent = parsed.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string' && messageContent.trim()) {
      return messageContent.trim();
    }
  } catch {
    // intentionally not parsed as JSON
  }

  return payload.trim();
}

function mapProviderRuntimeById(providers: ProviderRuntime[]): Map<string, ProviderRuntime> {
  const map = new Map<string, ProviderRuntime>();
  for (const provider of providers) {
    map.set(provider.id, provider);
  }
  return map;
}

async function buildRouteTestRequest(modelAlias: string, prompt: string): Promise<{ route: RouteRequest; requestBodyText: string }> {
  const requestBodyText = JSON.stringify({
    model: modelAlias,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 300,
  });

  return {
    route: {
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/chat/completions',
      queryString: '',
      endpointKind: 'v1.chat.completions',
      routeKey: 'POST /v1/chat/completions',
      model: modelAlias,
      stream: false,
      toolsRequested: false,
      jsonSchemaRequested: false,
      modalities: [],
      contentType: 'application/json',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      requestBodyText,
      requestBodyJson: {
        model: modelAlias,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300,
      },
      bodyBuffer: new TextEncoder().encode(requestBodyText),
    },
    requestBodyText,
  };
}

function responseToResult(responseText: string): string {
  return resolveResponsePreview(responseText);
}

function summarizeProvider(provider: ProviderRuntime): { id: string; name: string; slug: string; kind: ProviderKind } {
  return {
    id: provider.id,
    name: provider.name,
    slug: provider.slug,
    kind: provider.kind,
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinUrl(base: string, suffix: string): string {
  return `${trimSlash(base)}/${suffix.replace(/^\/+/, '')}`;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

let cachedIamProxyToken: { accessToken: string; expiresAtMs: number } | null = null;

function socketClientIp(context: Context): string | undefined {
  try {
    return getConnInfo(context).remote.address;
  } catch {
    return undefined;
  }
}

function buildProxyRequestHeaders(request: Request, targetUrl: URL, requestId?: string, clientIp?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey)
      && lowerKey !== "host"
      && lowerKey !== "content-length"
      && lowerKey !== "forwarded"
      && lowerKey !== "x-forwarded-for"
      && lowerKey !== "x-real-ip"
      && lowerKey !== "x-forwarded-host"
      && lowerKey !== "x-forwarded-port"
      && lowerKey !== "x-forwarded-proto") {
      headers[key] = value;
    }
  });
  const sourceUrl = new URL(request.url);
  headers.host = targetUrl.host;
  headers["x-forwarded-host"] = sourceUrl.host;
  headers["x-forwarded-proto"] = sourceUrl.protocol.replace(":", "");
  if (clientIp) headers["x-forwarded-for"] = clientIp;
  if (requestId) {
    headers['x-request-id'] = requestId;
    headers['x-hive-request-id'] = requestId;
  }
  return headers;
}

async function getIamProxyAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedIamProxyToken && cachedIamProxyToken.expiresAtMs - 30_000 > now) {
    return cachedIamProxyToken.accessToken;
  }

  const token = await requestIamClientCredentialsToken(loadEnv());
  if (!token) {
    cachedIamProxyToken = null;
    return null;
  }

  cachedIamProxyToken = {
    accessToken: token.accessToken,
    expiresAtMs: now + Math.max(30, token.expiresIn - 30) * 1000,
  };
  return cachedIamProxyToken.accessToken;
}

function buildProxyResponseHeaders(headers: IncomingMessage["headers"]): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || typeof value === "undefined") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(key, entry);
    } else {
      responseHeaders.set(key, String(value));
    }
  }
  return responseHeaders;
}

interface ServiceJsonResult {
  status: number;
  body: unknown;
}

function parseServiceJson(buffer: Buffer): unknown {
  if (buffer.length === 0) return null;
  const text = buffer.toString('utf8');
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

function requestServiceJson(
  targetUrl: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    allowInsecureTls: boolean;
    maxBytes?: number;
    tls?: ReturnType<typeof iamTlsOptions>;
  },
): Promise<ServiceJsonResult> {
  const bodyText = typeof options.body === 'undefined' ? undefined : JSON.stringify(options.body);
  const headers = {
    accept: 'application/json',
    ...(bodyText ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bodyText)) } : {}),
    ...(options.headers ?? {}),
  };

  return new Promise((resolve, reject) => {
    const handleResponse = async (response: IncomingMessage) => {
      try {
        const body = await readProxyBody(response, options.maxBytes);
        resolve({ status: response.statusCode ?? 0, body: parseServiceJson(body) });
      } catch (error) {
        reject(error);
      }
    };

    const upstreamRequest = targetUrl.protocol === 'https:'
      ? httpsRequest(targetUrl, {
          method: options.method ?? 'GET',
          headers,
          ...(options.tls ?? { rejectUnauthorized: !options.allowInsecureTls }),
        }, handleResponse)
      : httpRequest(targetUrl, { method: options.method ?? 'GET', headers }, handleResponse);

    upstreamRequest.setTimeout(15_000, () => upstreamRequest.destroy(new Error(`Service request timed out: ${targetUrl.pathname}`)));
    upstreamRequest.on('error', reject);
    if (bodyText) upstreamRequest.write(bodyText);
    upstreamRequest.end();
  });
}

function extractArray(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  }
  return [];
}

async function requestIamServiceJson(path: string, requestId: string, body?: unknown, method?: string): Promise<ServiceJsonResult | null> {
  const env = loadEnv();
  const accessToken = await getIamProxyAccessToken();
  if (!accessToken) return null;
  const targetUrl = new URL(`api/v1/${path.replace(/^\/+/, '')}`, trimSlash(env.HIVE_IAM_INTERNAL_URL) + '/');
  return requestServiceJson(targetUrl, {
    method: method ?? (typeof body === 'undefined' ? 'GET' : 'POST'),
    body,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-request-id': requestId,
      'x-hive-request-id': requestId,
    },
    allowInsecureTls: env.HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS,
    tls: iamTlsOptions(targetUrl, env),
  });
}

async function requestIamJson(path: string, requestId: string): Promise<unknown> {
  const response = await requestIamServiceJson(path, requestId);
  if (!response) return null;
  return response.status >= 200 && response.status < 300 ? response.body : null;
}

async function requestMemoryJson(path: string, requestId: string, body?: unknown, method?: string): Promise<unknown> {
  const env = loadEnv();
  if (!env.HIVE_ROUTER_MEMORY_PROXY_TOKEN) return null;
  const targetUrl = new URL(path.replace(/^\/+/, ''), trimSlash(env.HIVEMEM_INTERNAL_URL) + '/');
  const response = await requestServiceJson(targetUrl, {
    method: method ?? (typeof body === 'undefined' ? 'GET' : 'POST'),
    body,
    headers: {
      authorization: `Bearer ${env.HIVE_ROUTER_MEMORY_PROXY_TOKEN}`,
      'x-request-id': requestId,
      'x-hive-request-id': requestId,
    },
    allowInsecureTls: env.HIVE_STATUS_ALLOW_INSECURE_TLS,
    tls: hiveMemTlsOptions(targetUrl, env),
  });
  return response.status >= 200 && response.status < 300 ? response.body : null;
}

async function memoryAdminJson(context: Context<{ Variables: AppVariables }>, path: string, body?: unknown, method?: string): Promise<Response> {
  const env = loadEnv();
  if (!env.HIVE_ROUTER_MEMORY_PROXY_TOKEN) {
    return context.json({ error: 'HIVE_ROUTER_MEMORY_PROXY_TOKEN is not configured on the Router service.' }, 503);
  }
  const targetUrl = new URL(path.replace(/^\/+/, ''), trimSlash(env.HIVEMEM_INTERNAL_URL) + '/');
  const response = await requestServiceJson(targetUrl, {
    method: method ?? (typeof body === 'undefined' ? 'GET' : 'POST'),
    body,
    headers: {
      authorization: `Bearer ${env.HIVE_ROUTER_MEMORY_PROXY_TOKEN}`,
      'x-request-id': context.get('requestId'),
      'x-hive-request-id': context.get('requestId'),
    },
    allowInsecureTls: env.HIVE_STATUS_ALLOW_INSECURE_TLS,
    tls: hiveMemTlsOptions(targetUrl, env),
  });
  return context.json(response.body ?? { ok: response.status >= 200 && response.status < 300 }, response.status as never);
}

export function hiveMemProxyCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const forwarded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^hivemem_[A-Za-z0-9_-]*=/u.test(part));
  return forwarded.length ? forwarded.join("; ") : undefined;
}

async function proxyHiveMemRequest(context: Context<{ Variables: AppVariables }>): Promise<Response> {
  const env = loadEnv();
  const incomingUrl = new URL(context.req.url);
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, trimSlash(env.HIVEMEM_INTERNAL_URL) + "/");
  const method = context.req.method.toUpperCase();
  const bodyBuffer = method === "GET" || method === "HEAD" ? undefined : Buffer.from(await context.req.raw.arrayBuffer());
  const headers = buildProxyRequestHeaders(context.req.raw, targetUrl, context.get('requestId'), socketClientIp(context));
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "cookie") delete headers[name];
  }
  const hiveMemCookie = hiveMemProxyCookieHeader(context.req.header("cookie"));
  if (hiveMemCookie) headers.cookie = hiveMemCookie;
  if (bodyBuffer) headers["content-length"] = String(bodyBuffer.length);

  return new Promise((resolve) => {
    const handleResponse = async (response: IncomingMessage) => {
      try {
        const body = await readProxyBody(response, env.MAX_ADMIN_BODY_BYTES);
        resolve(new Response(new Uint8Array(body), {
          status: response.statusCode ?? 502,
          headers: buildProxyResponseHeaders(response.headers),
        }));
      } catch (error) {
        log("warn", "HiveMem proxy response exceeded limit", { error: error instanceof Error ? error.message : String(error) });
        resolve(new Response("Bad Gateway", { status: 502 }));
      }
    };

    const upstreamRequest = targetUrl.protocol === "https:"
      ? httpsRequest(targetUrl, {
          method,
          headers,
          ...hiveMemTlsOptions(targetUrl, env),
        }, handleResponse)
      : httpRequest(targetUrl, { method, headers }, handleResponse);

    upstreamRequest.setTimeout(30_000, () => upstreamRequest.destroy(new Error("HiveMem proxy timed out")));
    upstreamRequest.on("error", (error) => {
      log("warn", "HiveMem proxy failed", {
        path: incomingUrl.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      resolve(new Response("Bad Gateway", { status: 502 }));
    });
    if (bodyBuffer) upstreamRequest.write(bodyBuffer);
    upstreamRequest.end();
  });
}

function readProxyBody(response: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        response.destroy();
        reject(new Error(`Upstream response exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    response.on("error", reject);
    response.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function proxyIamRequest(context: Context<{ Variables: AppVariables }>): Promise<Response> {
  const env = loadEnv();
  const incomingUrl = new URL(context.req.url);
  const normalizedPath = normalizeAdminPath(rawRequestPathname(context.req.url));
  if (normalizedPath === null) return context.json({ error: "Invalid request path" }, 400);
  const suffix = normalizedPath.replace(/^\/api\/iam\/?/, "").split("/").map(encodeURIComponent).join("/");
  const targetUrl = new URL(`api/v1/${suffix}${incomingUrl.search}`, trimSlash(env.HIVE_IAM_INTERNAL_URL) + "/");
  const method = context.req.method.toUpperCase();
  const bodyBuffer = method === "GET" || method === "HEAD" ? undefined : Buffer.from(await context.req.raw.arrayBuffer());
  const headers = buildProxyRequestHeaders(context.req.raw, targetUrl, context.get('requestId'), socketClientIp(context));
  delete headers.authorization;
  delete headers.Authorization;
  delete headers.cookie;
  delete headers.Cookie;
  const accessToken = await getIamProxyAccessToken();
  if (!accessToken) {
    return context.json({ error: "IAM proxy token unavailable" }, 502);
  }
  headers.authorization = `Bearer ${accessToken}`;
  // IAM trusts this header only from the Router's own client token; never pass a caller's copy through.
  delete headers['x-hive-operator'];
  const operator = await verifyAdminSession(context);
  if (operator) {
    headers['x-hive-operator'] = JSON.stringify({
      id: operator.user.id,
      sessionId: operator.sessionId,
      authenticatedAt: operator.authenticatedAt,
      authMode: operator.authMode,
      ...(operator.iamSubject ? { iamSubject: operator.iamSubject } : {}),
    });
  }
  if (bodyBuffer) headers["content-length"] = String(bodyBuffer.length);

  return new Promise((resolve) => {
    const handleResponse = async (response: IncomingMessage) => {
      try {
        const responseHeaders = buildProxyResponseHeaders(response.headers);
        responseHeaders.delete("set-cookie");
        const body = await readProxyBody(response, env.MAX_ADMIN_BODY_BYTES);
        resolve(new Response(new Uint8Array(body), {
          status: response.statusCode ?? 502,
          headers: responseHeaders,
        }));
      } catch (error) {
        log("warn", "IAM proxy response exceeded limit", { error: error instanceof Error ? error.message : String(error) });
        resolve(new Response("Bad Gateway", { status: 502 }));
      }
    };

    const upstreamRequest = targetUrl.protocol === "https:"
      ? httpsRequest(targetUrl, {
          method,
          headers,
          ...iamTlsOptions(targetUrl, env),
        }, handleResponse)
      : httpRequest(targetUrl, { method, headers }, handleResponse);

    upstreamRequest.setTimeout(30_000, () => upstreamRequest.destroy(new Error("IAM proxy timed out")));
    upstreamRequest.on("error", (error) => {
      log("warn", "IAM proxy failed", {
        path: incomingUrl.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      resolve(context.json({ error: "IAM proxy failed" }, 502));
    });
    if (bodyBuffer) upstreamRequest.write(bodyBuffer);
    upstreamRequest.end();
  });
}

async function probeHiveService(
  key: Extract<HiveAppKey, 'iam' | 'memory'>,
  name: string,
  role: string,
  internalUrl: string,
  publicUrl: string,
  healthPath: string,
  consolePath: string,
  allowInsecureTls: boolean,
  requestId?: string,
): Promise<HiveAppStatus> {
  const healthUrl = joinUrl(internalUrl, healthPath);
  const startedAt = Date.now();
  try {
    const env = loadEnv();
    const targetUrl = new URL(healthUrl);
    const options = {
      allowInsecureTls,
      tls: key === 'iam' ? iamTlsOptions(targetUrl, env) : hiveMemTlsOptions(targetUrl, env),
      ...(requestId ? { requestId } : {}),
    };
    let payload: ServiceHealthPayload | null = null;
    let ok = false;
    let statusCode = 0;

    if (key === 'iam') {
      const probe = await requestIamHealth(healthUrl, options);
      ok = probe.ok;
      statusCode = probe.statusCode;
      payload = probe.payload ? normalizeIamHealthPayload(probe.payload) : null;
    } else {
      const probe = await requestMemoryHealth(healthUrl, options);
      ok = probe.ok;
      statusCode = probe.statusCode;
      payload = probe.payload ? normalizeMemoryHealthPayload(probe.payload) : null;
    }

    const latencyMs = Date.now() - startedAt;
    return {
      key,
      name,
      role,
      status: mapServiceHealthState(ok, payload),
      summary: ok ? payload?.status ?? 'responding' : 'HTTP ' + statusCode,
      internalUrl,
      publicUrl,
      consoleUrl: joinUrl(publicUrl, consolePath),
      latencyMs,
      checks: payload?.checks ?? [],
      ...(payload ? { details: payload.raw } : {}),
    };
  } catch (error) {
    return {
      key,
      name,
      role,
      status: 'offline',
      summary: error instanceof Error ? error.message : 'unreachable',
      internalUrl,
      publicUrl,
      consoleUrl: joinUrl(publicUrl, consolePath),
      checks: [],
    };
  }
}

export async function buildHiveStatus(env: ReturnType<typeof loadEnv>, requestId?: string): Promise<HiveStatusResponse> {
  const tlsCertificate = inspectTlsCertificate({ publicUrl: env.PUBLIC_ADMIN_URL, ...(env.TLS_CERT_PATH ? { certPath: env.TLS_CERT_PATH } : {}) });
  const securityExporterJwks = getSecurityExporterJwksStatus(env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS);
  // Exporter keys load on demand; an unused cache is expected on a fresh install.
  const exporterKeysDegraded = securityExporterJwks.state !== 'healthy'
    && securityExporterJwks.state !== 'uninitialized';
  const [providerCount, enabledProviders, routeRuleCount, traceCount, failureCount, failoverCount] = await Promise.all([
    prisma.provider.count(),
    prisma.provider.count({ where: { enabled: true } }),
    prisma.routeRule.count({ where: { enabled: true } }),
    prisma.trace.count(),
    prisma.trace.count({ where: { outcome: { in: ['FAILED', 'STREAM_FAILED'] } } }),
    prisma.traceEvent.count({ where: { type: 'provider.failover' } }),
  ]);

  const routerStatus: HiveAppStatus = {
    key: 'router',
    name: 'Hive Router',
    role: 'traffic routing and OpenAI-compatible gateway',
    status: failureCount > 0 || tlsCertificate.status !== 'pass' || exporterKeysDegraded ? 'degraded' : 'online',
    summary: `${enabledProviders}/${providerCount} providers enabled`,
    internalUrl: env.PUBLIC_ADMIN_URL,
    publicUrl: env.PUBLIC_API_URL,
    consoleUrl: env.PUBLIC_ADMIN_URL,
    checks: [
      { name: 'providers', status: enabledProviders > 0 ? 'pass' : 'warn', message: `${providerCount} configured` },
      { name: 'route-rules', status: routeRuleCount > 0 ? 'pass' : 'warn', message: `${routeRuleCount} enabled` },
      { name: 'traces', status: failureCount > 0 ? 'warn' : 'pass', message: `${traceCount} traces, ${failureCount} failures` },
      { name: 'tls-cert', status: tlsCertificate.status, message: tlsCertificate.message },
      {
        name: 'security-exporter-jwks',
        status: securityExporterJwks.state === 'healthy' ? 'pass' : securityExporterJwks.state === 'expired' ? 'fail' : 'warn',
        message: securityExporterJwks.state === 'uninitialized'
          ? 'not cached yet; first exporter request will load IAM keys'
          : `${Math.ceil(securityExporterJwks.remainingMs / 1_000)}s remaining (${securityExporterJwks.state})`,
      },
    ],
    details: {
      providerCount,
      enabledProviders,
      routeRuleCount,
      traceCount,
      failureCount,
      failoverCount,
      tlsCertificate: { ...tlsCertificate },
      securityExporterJwks: { ...securityExporterJwks },
    },
  };

  const [memoryStatus, iamStatus] = await Promise.all([
    probeHiveService(
      'memory',
      'Hive Memory',
      'semantic memory, task history, and relationship graph',
      env.HIVEMEM_INTERNAL_URL,
      env.HIVEMEM_PUBLIC_URL,
      '/v1/health/ready',
      '/dashboard',
      env.HIVE_STATUS_ALLOW_INSECURE_TLS,
      requestId,
    ),
    probeHiveService(
      'iam',
      'Hive IAM',
      'identity, OAuth clients, roles, and Linux account mapping',
      env.HIVE_IAM_INTERNAL_URL,
      env.HIVE_IAM_PUBLIC_URL,
      '/api/v1/health/ready',
      '/api/v1/docs',
      env.HIVE_STATUS_ALLOW_INSECURE_TLS,
      requestId,
    ),
  ]);

  const skew = compatibilityWarnings({ iam: typeof iamStatus.details?.version === 'string' ? iamStatus.details.version : undefined, memory: typeof memoryStatus.details?.version === 'string' ? memoryStatus.details.version : undefined, router:metadata(releasePackageRoot).version }, ownRelease(releasePackageRoot));
  for (const message of skew.filter(message => !message.startsWith('skills:'))) routerStatus.checks.push({ name:'version-compatibility',status:'warn',message });
  return {
    generatedAt: new Date().toISOString(),
    uiUrl: env.HIVE_UI_PUBLIC_URL,
    apps: [iamStatus, memoryStatus, routerStatus],
  };
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});


const codexOAuthCheckSchema = z.object({
  loginId: z.string().min(1),
});

const pendingCodexOAuth = new Map<string, CodexDeviceCode>();
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_CLIENT_FAILURE_LIMIT = 20;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const LOGIN_THROTTLE_MAX_ENTRIES = 10_000;

type AdminContext = Context<{ Variables: AppVariables }>;

function sanitizeAdminUser(user: AdminUser): Omit<AdminUser, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function buildSessionUser(user: AdminUser, roles: string[] = [], permissions: string[] = []): Omit<AdminUser, 'passwordHash'> & { roles: string[]; permissions: string[] } {
  return {
    ...sanitizeAdminUser(user),
    roles,
    permissions,
  };
}

function sanitizeClientApiKey(key: ClientApiKey): Omit<ClientApiKey, 'keyHash'> {
  const { keyHash: _keyHash, ...safeKey } = key;
  return safeKey;
}

function normalizeLoginUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function createLoginThrottle(options: { accountLimit?: number; clientLimit?: number; lockoutMs?: number; now?: () => number } = {}) {
  const accountLimit = options.accountLimit ?? LOGIN_FAILURE_LIMIT;
  const clientLimit = options.clientLimit ?? LOGIN_CLIENT_FAILURE_LIMIT;
  const lockoutMs = options.lockoutMs ?? LOGIN_LOCKOUT_MS;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { failures: number; lockedUntil?: number }>();
  const keys = (username: string, clientIp: string | undefined) => {
    const client = clientIp ?? 'unknown';
    return { account: `${normalizeLoginUsername(username)}\u0000${client}`, client: `client\u0000${client}` };
  };
  const locked = (key: string): boolean => {
    const state = failures.get(key);
    if (!state?.lockedUntil) return false;
    if (state.lockedUntil <= now()) {
      failures.delete(key);
      return false;
    }
    return true;
  };
  const bump = (key: string, limit: number): void => {
    const state = failures.get(key) ?? { failures: 0 };
    state.failures += 1;
    if (state.failures >= limit) state.lockedUntil = now() + lockoutMs;
    failures.delete(key);
    failures.set(key, state);
    while (failures.size > LOGIN_THROTTLE_MAX_ENTRIES) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  };
  return {
    isLocked(username: string, clientIp: string | undefined): boolean {
      const key = keys(username, clientIp);
      return locked(key.client) || locked(key.account);
    },
    recordFailure(username: string, clientIp: string | undefined): void {
      const key = keys(username, clientIp);
      bump(key.account, accountLimit);
      bump(key.client, clientLimit);
    },
    recordSuccess(username: string, clientIp: string | undefined): void {
      failures.delete(keys(username, clientIp).account);
    },
  };
}

const loginThrottle = createLoginThrottle();
const reauthThrottle = createLoginThrottle();

async function requireMetricsAccess(context: AdminContext, next: Next): Promise<Response | void> {
  const token = loadEnv().HIVE_ROUTER_METRICS_TOKEN;
  const authorization = context.req.header('authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (token && bearer && safeEqualText(bearer, token)) {
    await next();
    return;
  }

  const principal = await verifyAdminSession(context);
  if (!principal) {
    return context.json({ error: 'Unauthorized' }, 401);
  }

  context.set('adminUser', principal.user);
  context.set('adminRoles', principal.roles);
  context.set('adminPermissions', principal.permissions);
  await next();
}

function sanitizeProvider(provider: Awaited<ReturnType<typeof prisma.provider.findUniqueOrThrow>> & { models?: Array<unknown> }): Record<string, unknown> {
  const runtime = parseProviderRuntime(provider);
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    authMode: provider.authMode,
    authHeaderName: provider.authHeaderName,
    authSecretMasked: maskSecret(runtime.authSecret),
    defaultHeaders: runtime.defaultHeaders,
    capabilities: runtime.capabilities,
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    concurrency: provider.concurrency,
    priority: provider.priority,
    weight: provider.weight,
    failoverGroup: provider.failoverGroup,
    enabled: provider.enabled,
    lastHealthStatus: provider.lastHealthStatus,
    lastHealthError: provider.lastHealthError,
    lastHealthAt: provider.lastHealthAt,
    models: (provider.models ?? []) as Array<unknown>,
  };
}

function getParamId(context: { req: { param(name: string): string | undefined } }, name = 'id'): string {
  return context.req.param(name) ?? '';
}

export function hasAdminPermission(granted: readonly string[] | undefined, required: string): boolean {
  if (!required) return true;
  if (!granted?.length) return false;
  const satisfies = (permission: string): boolean => {
    if (granted.includes('*') || granted.includes(permission)) return true;
    const [domain] = permission.split(':');
    return granted.includes(`${domain}:*`) || granted.some((entry) => entry.endsWith(':*') && permission.startsWith(entry.slice(0, -1)));
  };
  return satisfies(required) || (required.endsWith(':read') && satisfies(`${required.slice(0, -5)}:write`));
}

function rawRequestPathname(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/iu, '');
  return withoutOrigin.split(/[?#]/u)[0] || '/';
}

export function normalizeAdminPath(rawPathname: string): string | null {
  if (/%2f|%5c|\\/iu.test(rawPathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0')) return null;
  const segments = decoded.split('/').slice(1);
  if (segments.some((segment, index) => segment === '.' || segment === '..' || (segment === '' && index < segments.length - 1))) return null;
  return decoded;
}

function requiredReadPermission(path: string): string | null {
  if (path.startsWith('/api/auth/')) return null;
  if (path.startsWith('/api/iam/users') || path.startsWith('/api/iam/system-users') || path.startsWith('/api/iam/sessions') || path.startsWith('/api/iam/password-policy')) return 'iam:users:read';
  if (path.startsWith('/api/iam/roles')) return 'iam:roles:read';
  if (path.startsWith('/api/iam/service-accounts')) return 'iam:sa:read';
  if (path.startsWith('/api/iam/clients')) return 'iam:clients:read';
  if (path.startsWith('/api/iam/groups')) return 'iam:groups:read';
  if (path.startsWith('/api/iam/audit')) return 'iam:audit:read';
  if (path.startsWith('/api/iam')) return 'iam:admin:read';
  if (path.startsWith('/api/memory')) return 'memory:read';
  if (path.startsWith('/api/hive/actors')) return 'hive:actors:read';
  if (path.startsWith('/api/providers')) return 'router:providers:read';
  if (path.startsWith('/api/model-aliases') || path.startsWith('/api/route-rules') || path.startsWith('/api/heuristics') || path.startsWith('/api/routing') || path === '/api/routes') return 'router:routing:read';
  if (path.startsWith('/api/client-keys')) return 'router:keys:read';
  if (path.startsWith('/api/testing')) return 'router:testing:read';
  if (path === '/api/config/export') return 'router:settings:write';
  if (path.startsWith('/api/config') || path.startsWith('/api/runtime-settings')) return 'router:settings:read';
  return 'router:admin:read';
}

export function requiredPermissionForRequest(method: string, path: string): string | null {
  const verb = method.toUpperCase();
  if (verb === 'OPTIONS') return null;
  if (verb === 'GET' || verb === 'HEAD') return requiredReadPermission(path);
  if (path === '/api/auth/reauthenticate' || path === '/api/auth/logout' || path === '/api/auth/login') return null;
  if (path.startsWith('/api/hive/upgrades/')) return 'hive:upgrades:write';
  if (path.startsWith('/api/iam/users')) return verb === 'DELETE' ? 'iam:users:delete' : 'iam:users:write';
  if (path.startsWith('/api/iam/roles')) return 'iam:roles:write';
  if (path.startsWith('/api/iam/service-accounts')) return verb === 'DELETE' ? 'iam:sa:delete' : 'iam:sa:write';
  if (path.startsWith('/api/iam/clients')) return 'iam:clients:write';
  if (path.startsWith('/api/iam/sessions')) return 'iam:sessions:revoke';
  if (path.startsWith('/api/iam/system-users')) return verb === 'DELETE' ? 'iam:users:delete' : 'iam:users:write';
  if (path.startsWith('/api/iam/password-policy')) return 'iam:policy:write';
  if (path === '/api/memory/search') return 'memory:read';
  if (path.startsWith('/api/memory')) return 'memory:write';
  if (path.startsWith('/api/hive/actors')) return 'hive:actors:write';
  if (path.startsWith('/api/providers')) return 'router:providers:write';
  if (path.startsWith('/api/model-aliases') || path.startsWith('/api/route-rules') || path.startsWith('/api/heuristics') || path.startsWith('/api/routing')) return 'router:routing:write';
  if (path.startsWith('/api/client-keys')) return 'router:keys:write';
  if (path.startsWith('/api/testing')) return 'router:testing:write';
  if (path.startsWith('/api/config') || path.startsWith('/api/runtime-settings')) return 'router:settings:write';
  return 'router:admin:write';
}

export function hasRecentOperatorAuthentication(authenticatedAt: number | undefined, now = Date.now()): boolean {
  return typeof authenticatedAt === 'number' && authenticatedAt <= now + 30_000 && now - authenticatedAt <= 15 * 60_000;
}

async function attachAdminSessionAndEnforcePermission(context: AdminContext, next: Next): Promise<Response | void> {
  const pathname = normalizeAdminPath(rawRequestPathname(context.req.url));
  if (pathname === null) return context.json({ error: 'Invalid request path' }, 400);
  if (pathname === '/api/auth/login' || pathname === '/api/security/events') {
    await next();
    return;
  }
  const principal = await verifyAdminSession(context);
  if (!principal) return context.json({ error: 'Unauthorized' }, 401);
  context.set('adminUser', principal.user);
  context.set('adminRoles', principal.roles);
  context.set('adminPermissions', principal.permissions);
  const required = requiredPermissionForRequest(context.req.method, pathname);
  if (required && !hasAdminPermission(principal.permissions, required)) {
    return context.json({ error: 'Forbidden', requiredPermission: required }, 403);
  }
  const sensitive = required && ((pathname.startsWith('/api/hive/upgrades') && !['GET','HEAD'].includes(context.req.method)) || pathname.startsWith('/api/iam/password-policy') || pathname.startsWith('/api/iam/clients') || pathname.startsWith('/api/iam/roles') || pathname.startsWith('/api/hive/actors') || pathname.startsWith('/api/client-keys'));
  if (sensitive && !hasRecentOperatorAuthentication(principal.authenticatedAt)) return context.json({ error: 'STEP_UP_REQUIRED', message: 'Sign in again before changing credentials or security policy.' }, 403);
  await next();
}

function normalizeProviderCapabilities(capabilities: Record<string, unknown>): Partial<ProviderCapability> {
  return Object.fromEntries(Object.entries(capabilities).filter(([, value]) => value !== undefined)) as Partial<ProviderCapability>;
}

function buildProviderModelInputs(models: ProviderModelInput[]) {
  return models.map((model) => ({
    model: model.model,
    displayName: model.displayName ?? null,
    enabled: model.enabled,
    maxContextWindow: model.maxContextWindow ?? null,
    capabilityJson: JSON.stringify(normalizeProviderCapabilities(model.capabilityJson)),
  }));
}

function collectModelIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const addModel = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    for (const key of ['id', 'model', 'name']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        ids.add(value);
      }
    }
  };

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      record.data.forEach(addModel);
    }
    if (Array.isArray(record.models)) {
      record.models.forEach(addModel);
    }
  }

  return [...ids];
}

async function validateAliasModelChoice(body: ModelAliasInput): Promise<string | null> {
  const upstreamModel = body.upstreamModel.trim();
  const provider = body.providerId
    ? await prisma.provider.findUnique({ where: { id: body.providerId }, include: { models: true } })
    : null;

  if (body.providerId && !provider) {
    return 'Selected provider was not found.';
  }

  if (provider?.kind === ProviderKind.LLAMACPP) {
    return null;
  }

  if (!upstreamModel) {
    return 'Upstream model is required unless the selected provider is llama.cpp.';
  }

  if (!provider) {
    return null;
  }

  if (provider.kind === ProviderKind.CODEX) {
    return null;
  }

  const configuredModels = provider.models.filter((model) => model.enabled).map((model) => model.model);
  if (configuredModels.includes(upstreamModel)) {
    return null;
  }

  const runtime = parseProviderRuntime(provider);
  if (!runtime.capabilities.supportedRoutes.includes('v1.models')) {
    return configuredModels.length > 0
      ? `Model "${upstreamModel}" is not registered on provider "${provider.name}".`
      : null;
  }

  try {
    const adapter = getProviderAdapter(runtime.kind);
    const execution = await adapter.execute(
      {
        requestId: randomUUID(),
        method: 'GET',
        path: '/v1/models',
        queryString: '',
        endpointKind: 'v1.models',
        routeKey: 'GET /v1/models',
        stream: false,
        toolsRequested: false,
        jsonSchemaRequested: false,
        modalities: [],
        headers: { accept: 'application/json' },
      },
      { ...runtime, timeoutMs: Math.min(runtime.timeoutMs, 10000) },
    );

    if (!execution.response.ok) {
      return null;
    }

    const modelIds = collectModelIds(await execution.response.json());
    if (modelIds.length === 0) {
      return null;
    }

    return modelIds.includes(upstreamModel)
      ? null
      : `Model "${upstreamModel}" was not found on provider "${provider.name}".`;
  } catch {
    return configuredModels.length > 0
      ? `Model "${upstreamModel}" is not registered on provider "${provider.name}".`
      : null;
  }
}

async function listProviders(): Promise<Response> {
  const providers = await prisma.provider.findMany({
    include: { models: true },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  return Response.json({
    data: providers.map((provider) => sanitizeProvider(provider)),
  });
}

async function listRoutes(): Promise<Response> {
  const [rules, aliases] = await Promise.all([
    prisma.routeRule.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
    prisma.modelAlias.findMany({ orderBy: { alias: 'asc' } }),
  ]);
  return Response.json({ routeRules: rules, modelAliases: aliases });
}

async function listTelemetry(): Promise<Response> {
  const [tracesTotal, failures, latestTrace, failovers] = await Promise.all([
    prisma.trace.count(),
    prisma.trace.count({ where: { outcome: { in: ['FAILED', 'STREAM_FAILED'] } } }),
    prisma.trace.findFirst({ orderBy: { createdAt: 'desc' } }),
    prisma.traceEvent.count({ where: { type: 'provider.failover' } }),
  ]);

  return Response.json({
    totals: {
      traces: tracesTotal,
      failures,
      failovers,
    },
    latestTrace,
  });
}

async function listTraces(): Promise<Response> {
  const traces = await prisma.trace.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      events: {
        orderBy: { occurredAt: 'asc' },
      },
      provider: true,
      clientApiKey: true,
    },
  });

  return Response.json({
    data: traces.map((trace) => ({
      ...trace,
      clientApiKey: trace.clientApiKey ? sanitizeClientApiKey(trace.clientApiKey) : null,
    })),
  });
}

async function buildMemoryConsoleData(requestId: string): Promise<Response> {
  const env = loadEnv();
  if (!env.HIVE_ROUTER_MEMORY_PROXY_TOKEN) {
    return Response.json({
      configured: false,
      error: 'HIVE_ROUTER_MEMORY_PROXY_TOKEN is not configured on the Router service.',
      stats: null,
      queue: null,
      memories: [],
      sessions: [],
      agents: [],
      graphEntities: [],
    }, { status: 503 });
  }

  const [stats, queue, memories, sessions, agents, graphEntities] = await Promise.all([
    requestMemoryJson('/v1/stats', requestId).catch(() => null),
    requestMemoryJson('/v1/queue/status?limit=8', requestId).catch(() => null),
    requestMemoryJson('/v1/memories/browse?limit=12&workspace_id=*', requestId).catch(() => null),
    requestMemoryJson('/v1/sessions?limit=8&workspace_id=*', requestId).catch(() => null),
    requestMemoryJson('/v1/agents', requestId).catch(() => null),
    requestMemoryJson('/v1/graph/entities?limit=12&workspace_id=*', requestId).catch(() => null),
  ]);

  return Response.json({
    configured: true,
    stats,
    queue,
    memories: extractArray(memories, ['results', 'memories', 'items']),
    memoryTotal: typeof memories === 'object' && memories && 'total' in memories ? (memories as Record<string, unknown>).total : null,
    sessions: extractArray(sessions, ['results', 'sessions', 'items']),
    agents: extractArray(agents, ['agents', 'results', 'items']),
    graphEntities: extractArray(graphEntities, ['entities', 'results', 'items', 'nodes']),
  });
}

async function loadHiveActors(requestId: string): Promise<HiveActor[]> {
  const [iamUsers, iamServiceAccounts, iamSystemUsers, memoryAgents, routerClientKeys, traces] = await Promise.all([
    requestIamJson('users?limit=200', requestId).catch(() => null),
    requestIamJson('service-accounts', requestId).catch(() => null),
    requestIamJson('system-users', requestId).catch(() => null),
    requestMemoryJson('/v1/agents', requestId).catch(() => null),
    prisma.clientApiKey.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 }),
    prisma.trace.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
  ]);

  return buildHiveActors({
    iamUsers: extractArray(iamUsers, ['users', 'results', 'items']),
    iamServiceAccounts: extractArray(iamServiceAccounts, ['serviceAccounts', 'service_accounts', 'results', 'items']),
    iamSystemUsers: extractArray(iamSystemUsers, ['systemUsers', 'system_users', 'results', 'items']),
    memoryAgents: extractArray(memoryAgents, ['agents', 'results', 'items']),
    routerClientKeys: routerClientKeys.map((key) => sanitizeClientApiKey(key) as Record<string, unknown>),
    traces: traces as unknown as Record<string, unknown>[],
  });
}

async function listHiveActors(requestId: string): Promise<Response> {
  const actors = await loadHiveActors(requestId);
  return Response.json({ data: actors });
}

function actorIdentifier(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mergeActorIdentifiers(target: Record<string, unknown>, actor: HiveActor): void {
  for (const [key, value] of Object.entries(actor.identifiers)) {
    if (typeof value === 'string' && value.trim() && !target[key]) target[key] = value;
  }
}

async function resolveActorLifecycleTargets(requestId: string, actorId: string): Promise<Record<string, unknown>> {
  let binding = await prisma.actorEnrollment.findUnique({ where: { actorId } });
  const identifiers: Record<string, unknown> = {};
  if (!binding) {
    const actors = await loadHiveActors(requestId).catch(() => []);
    const selected = actors.find((actor) => actor.id === actorId);
    if (!selected) return identifiers;
    mergeActorIdentifiers(identifiers, selected);
    // Resolve only server-inventoried IDs. Submitted labels/identifiers cannot
    // redirect a request to a different actor's persisted binding.
    binding = await prisma.actorEnrollment.findFirst({ where: { OR: [
      { routerKeyId: actorIdentifier(identifiers, 'routerClientKeyId') ?? '__none__' },
      { iamId: actorIdentifier(identifiers, 'iamServiceAccountId') ?? '__none__' },
      { memoryId: actorIdentifier(identifiers, 'memoryAgentId') ?? '__none__' },
    ] } });
  }
  return binding ? { iamServiceAccountId: binding.iamId, routerClientKeyId: binding.routerKeyId, memoryAgentId: binding.memoryId } : identifiers;
}

function responseStep(service: string, action: string, status: number, body: unknown): Record<string, unknown> {
  return {
    service,
    action,
    status,
    ok: status >= 200 && status < 300,
    body,
  };
}

async function createActor(context: AdminContext): Promise<Response> {
  const body = actorCreateSchema.parse(await context.req.json());
  await requireMemoryCredentialDeadline(context.get('requestId'));
  const journal = actorJournal();
  const lease = await actorJournalWrite(() => journal.holdEnrollment('enrollment:' + body.agentId));
  try { return await createEnrolledActor(context, body, lease); }
  finally { await actorJournalWrite(() => journal.release(lease)); }
}

async function requireMemoryCredentialDeadline(requestId: string): Promise<void> {
  const capabilities = await requestMemoryJson('/v1/capabilities', requestId).catch(() => null);
  if (actorIdentifier(capabilities, 'credential_expiry') !== 'absolute-deadline') throw new HTTPException(503, { message: 'This installation needs Memory absolute credential-deadline support before onboarding or rotation; deploy Memory before Router' });
}

async function createEnrolledActor(context: AdminContext, body: z.infer<typeof actorCreateSchema>, lease: ActorLease): Promise<Response> {
  await prisma.actorEnrollment.updateMany({ where: { receiptExpiresAt: { lt: new Date() }, encryptedSecrets: { not: null } }, data: { encryptedSecrets: null, receiptExpiresAt: null } });
  const user = context.get('adminUser')!;
  const requestId = context.get('requestId');
  if (body.scopes.some((scope) => scope.includes('*') || scope.startsWith('admin:'))) return context.json({ error: 'Use explicit non-admin Memory permissions for onboarding' }, 400);
  const requestHash = digestText(JSON.stringify(body));
  let enrollment = await prisma.actorEnrollment.upsert({ where: { actorId: body.agentId }, create: { actorId: body.agentId, ownerId: user.id, requestHash, requestJson: JSON.stringify(body), credentialExpiresAt: new Date(Date.now() + body.expiresHours * 3600_000) }, update: {} });
  if (enrollment.requestHash !== requestHash || enrollment.ownerId !== user.id) return context.json({ error: 'Actor ID is already bound to another enrollment' }, 409);
  if (enrollment.status === 'contained') return context.json({ error: 'This enrollment was contained by Disable; use a new actor ID for a new enrollment' }, 409);
  const secrets: Record<string, string | null> = enrollment.encryptedSecrets && enrollment.receiptExpiresAt && enrollment.receiptExpiresAt > new Date() ? JSON.parse(decryptText(enrollment.encryptedSecrets)) : {};
  const steps: Record<string, unknown>[] = [];
  const persist = async (patch: { iamId?: string; routerKeyId?: string; memoryId?: string; status?: string }) => {
    enrollment = await prisma.$transaction(async (transaction) => {
      const locked = await transaction.$executeRaw`UPDATE ActorLifecycleLease SET leaseUntil = ${Date.now() + 120_000} WHERE bindingKey = ${lease.bindingKey} AND token = ${lease.token} AND leaseUntil > ${Date.now()}`;
      if (!locked) throw new HTTPException(409, { message: 'Enrollment lease was lost; retry its durable state' });
      return transaction.actorEnrollment.update({ where: { actorId: body.agentId }, data: { ...patch, encryptedSecrets: encryptText(JSON.stringify(secrets)), receiptExpiresAt: new Date(Date.now() + 900_000), leaseUntil: null } });
    });
  };
  try {
    if (!enrollment.iamId) {
      const response = await requestIamServiceJson('service-accounts', requestId, { name: `hive-actor-${body.agentId}`, description: body.description, clientId: body.iamClientId, roleIds: body.roleIds, allowedIps: body.allowedIps, ...(enrollment.credentialExpiresAt ? { expiresAt: enrollment.credentialExpiresAt.toISOString() } : {}), operationId: digestText('actor:' + body.agentId + ':' + requestHash) }, 'POST');
      const id = actorIdentifier(response?.body, 'id');
      if (!response || response.status >= 300 || !id) throw new Error('iam_enrollment_failed');
      secrets.iamApiKey = actorIdentifier(response.body, 'apiKey');
      if (!secrets.iamApiKey) { const rotation = await requestIamServiceJson(`service-accounts/${encodeURIComponent(id)}/rotate`, requestId, {}, 'POST'); secrets.iamApiKey = actorIdentifier(rotation?.body, 'apiKey'); if (!secrets.iamApiKey) throw new Error('iam_receipt_recovery_failed'); }
      await persist({ iamId: id });
    }
    steps.push(responseStep('iam', 'service-account.enroll', 200, { id: enrollment.iamId }));
    if (!enrollment.routerKeyId) {
      const key = generateOpenAiStyleApiKey(); secrets.routerApiKey = key;
      const id = `actor-key-${body.agentId}`;
      await prisma.$transaction(async (transaction) => {
        const locked = await transaction.$executeRaw`UPDATE ActorLifecycleLease SET leaseUntil = ${Date.now() + 120_000} WHERE bindingKey = ${lease.bindingKey} AND token = ${lease.token} AND leaseUntil > ${Date.now()}`;
        if (!locked) throw new HTTPException(409, { message: 'Enrollment lease was lost; retry its durable state' });
        await transaction.clientApiKey.create({ data: { id, name: body.displayName, keyPrefix: key.slice(0, 8), keyHash: hashValue(key), expiresAt: enrollment.credentialExpiresAt, metadataJson: JSON.stringify({ owner: body.displayName, actorId: body.agentId, host: body.hostLabel, scopes: ['models:read', 'inference:write'], iamServiceAccountId: enrollment.iamId, memoryAgentId: body.agentId, workspaceId: body.workspaceId, owningProject: body.owningProject, tracePrivacy: 'metadata-only' }) } });
        await transaction.actorEnrollment.update({ where: { actorId: body.agentId }, data: { routerKeyId: id, encryptedSecrets: encryptText(JSON.stringify(secrets)), receiptExpiresAt: new Date(Date.now() + 900_000) } });
      });
      enrollment = (await prisma.actorEnrollment.findUniqueOrThrow({ where: { actorId: body.agentId } }));
    }
    steps.push(responseStep('router', 'client-key.enroll', 200, { id: enrollment.routerKeyId }));
    if (!enrollment.memoryId) {
      let memory: unknown;
      try { memory = await requestMemoryJson('/v1/agents/register', requestId, { agent_id: body.agentId, display_name: body.displayName, description: body.description, token_scopes: body.scopes, workspace_ids: [body.workspaceId], expires_hours: body.expiresHours, expires_at: enrollment.credentialExpiresAt?.toISOString(), operation_id: requestHash }, 'POST'); }
      catch { /* A prior request may have committed before the connection failed. */ }
      secrets.memoryToken = actorIdentifier(memory, 'token');
      if (!secrets.memoryToken) {
        const existing = await requestMemoryJson(`/v1/agents/${encodeURIComponent(body.agentId)}`, requestId);
        const metadata = existing && typeof existing === 'object' ? (existing as Record<string, unknown>).metadata : null;
        if (actorIdentifier(metadata, 'operation_id') !== requestHash) throw new Error('memory_binding_unverified');
        const issuance = await requestMemoryJson('/v1/auth/tokens', requestId, { agent_id: body.agentId, scopes: body.scopes, workspace_ids: [body.workspaceId], expires_hours: body.expiresHours, expires_at: enrollment.credentialExpiresAt?.toISOString(), rotate_previous: true }, 'POST');
        secrets.memoryToken = actorIdentifier(issuance, 'token');
      }
      if (!secrets.memoryToken) throw new Error('memory_enrollment_failed');
      await persist({ memoryId: body.agentId });
    }
    if (body.workspaceId !== 'default') {
      const workspace = await requestMemoryJson('/v1/workspaces', requestId, { workspace_id: body.workspaceId, title: body.owningProject || body.workspaceId }, 'POST');
      if (!workspace) throw new Error('workspace_enrollment_failed');
      const membership = await requestMemoryJson(`/v1/workspaces/${encodeURIComponent(body.workspaceId)}/members/${encodeURIComponent(body.agentId)}`, requestId, { role: 'member', scopes: body.scopes }, 'PUT');
      if (!membership) throw new Error('workspace_membership_failed');
    }
    steps.push(responseStep('memory', 'agent.enroll', 200, { id: enrollment.memoryId }));
    await persist({ status: 'completed' });
  } catch (error) {
    await persist({ status: 'partial' });
    steps.push({ service: 'enrollment', action: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'dependency_failed', status: 503, ok: false });
  }
  const identifiers = { iamServiceAccountId: enrollment.iamId, routerClientKeyId: enrollment.routerKeyId, memoryAgentId: enrollment.memoryId };
  await recordAuditEvent({ actorType: 'admin-user', adminUserId: user.id, action: 'hive-actor.create', entityType: 'hive-actor', entityId: body.agentId, metadata: { identifiers, steps } });
  const ok = enrollment.status === 'completed';
  return context.json({ ok, actorId: body.agentId, identifiers, secrets, steps, receiptExpiresAt: enrollment.receiptExpiresAt, configuration: { installation: loadEnv().PUBLIC_ADMIN_URL, routerUrl: loadEnv().PUBLIC_API_URL, memoryUrl: loadEnv().HIVEMEM_PUBLIC_URL, workspaceId: body.workspaceId, agentId: body.agentId, routerApiKey: '<one-time secret>', memoryToken: '<one-time secret>' }, remediation: ok ? null : 'Capture returned credentials, then retry the unchanged enrollment to resume its missing steps.' }, ok ? 201 : 207);
}

async function disableActor(context: AdminContext): Promise<Response> {
  return runActorLifecycle(context, 'disable');
}

async function rotateActor(context: AdminContext): Promise<Response> {
  return runActorLifecycle(context, 'rotate');
}

async function rotateClientKey(id: string): Promise<{ safeKey: Omit<ClientApiKey, 'keyHash'>; apiKey: string }> {
  const apiKey = generateOpenAiStyleApiKey();
  const updated = await prisma.clientApiKey.update({ where: { id }, data: { keyPrefix: apiKey.slice(0, 8), keyHash: hashValue(apiKey), lastUsedAt: null } });
  return { safeKey: sanitizeClientApiKey(updated), apiKey };
}

async function runActorLifecycle(context: AdminContext, action: 'rotate' | 'disable'): Promise<Response> {
  const user = context.get('adminUser')!;
  const requestId = context.get('requestId');
  const actorId = getParamId(context);
  const body = actorLifecycleSchema.parse(await context.req.json().catch(() => ({})));
  const identifiers = await resolveActorLifecycleTargets(requestId, actorId);
  const enrollment = await prisma.actorEnrollment.findFirst({ where: { OR: [
    { actorId },
    { routerKeyId: actorIdentifier(identifiers, 'routerClientKeyId') ?? '__none__' },
    { iamId: actorIdentifier(identifiers, 'iamServiceAccountId') ?? '__none__' },
    { memoryId: actorIdentifier(identifiers, 'memoryAgentId') ?? '__none__' },
  ] } });
  const enrollmentPolicy = enrollment ? actorCreateSchema.safeParse(JSON.parse(enrollment.requestJson)) : null;
  const targets = [
    { key: 'iamUserId', service: 'iam', action: 'user.disable' },
    { key: 'iamServiceAccountId', service: 'iam', action: 'service-account.' + action },
    { key: 'routerClientKeyId', service: 'router', action: 'client-key.' + action },
    { key: 'memoryAgentId', service: 'memory', action: 'agent.' + action },
  ].flatMap((target) => {
    const id = actorIdentifier(identifiers, target.key);
    return id && !(action === 'rotate' && target.key === 'iamUserId') ? [{ ...target, id }] : [];
  });
  if (!targets.length) return context.json({ ok: false, error: 'No linked resources support this operation' }, 404);
  if (action === 'rotate' && (enrollment?.status === 'contained' || (enrollment?.credentialExpiresAt && enrollment.credentialExpiresAt.getTime() <= Date.now()))) return context.json({ error: 'Contained or expired enrollments cannot rotate; create a new explicitly scoped enrollment' }, 409);
  if (action === 'rotate' && actorIdentifier(identifiers, 'memoryAgentId') && !enrollmentPolicy?.success) return context.json({ error: 'Legacy Memory rotation requires a reviewed explicit permission/workspace policy; use service-specific issuance with that policy' }, 409);
  if (action === 'rotate' && actorIdentifier(identifiers, 'memoryAgentId')) await requireMemoryCredentialDeadline(requestId);
  const bindingIds = Object.entries(identifiers).filter(([key]) => ['iamUserId', 'iamServiceAccountId', 'routerClientKeyId', 'memoryAgentId'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  const bindingKey = enrollment ? 'enrollment:' + enrollment.actorId : 'resources:' + digestText(JSON.stringify(bindingIds));
  const journal = actorJournal();
  const run = await actorJournalWrite(() => journal.begin({ bindingKey, actorId, ownerId: user.id, action, identifiers, operationId: body.operationId }));
  const checkpoint = (mutate?: Parameters<typeof journal.checkpoint>[1]) => actorJournalWrite(() => journal.checkpoint(run, mutate));
  if (run.lease) {
    try {
      if (enrollment) await checkpoint((database) => {
        database.prepare('UPDATE ActorEnrollment SET encryptedSecrets = NULL, receiptExpiresAt = NULL, status = ?, updatedAt = ? WHERE actorId = ?').run(action === 'disable' ? 'contained' : enrollment.status, Date.now(), enrollment.actorId);
      });
      for (const target of targets) {
        if (run.steps[target.key]?.ok) continue;
        const step: ActorStep = { service: target.service, action: target.action, resourceId: target.id, status: 503, ok: false, attempts: (run.steps[target.key]?.attempts ?? 0) + 1 };
        run.steps[target.key] = step;
        // Persist intent before contacting the service. A lost remote response may
        // require another rotation, but a checkpointed success is never repeated.
        await checkpoint();
        try {
          if (target.key === 'routerClientKeyId') {
            const key = action === 'rotate' ? generateOpenAiStyleApiKey() : null;
            if (key) run.secrets.routerApiKey = key;
            step.ok = true; step.status = 200;
            await checkpoint((database) => {
              const changed = key
                ? database.prepare('UPDATE ClientApiKey SET keyPrefix = ?, keyHash = ?, lastUsedAt = NULL, updatedAt = ? WHERE id = ?').run(key.slice(0, 8), hashValue(key), Date.now(), target.id)
                : database.prepare('UPDATE ClientApiKey SET enabled = 0, updatedAt = ? WHERE id = ?').run(Date.now(), target.id);
              if (!changed.changes) throw new Error('Router key no longer exists');
            });
          } else if (target.service === 'iam') {
            const path = target.key === 'iamUserId' ? 'users/' : 'service-accounts/';
            const response = await requestIamServiceJson(path + encodeURIComponent(target.id) + (action === 'rotate' ? '/rotate' : ''), requestId, action === 'rotate' ? {} : { active: false }, action === 'rotate' ? 'POST' : 'PATCH');
            step.status = response?.status ?? 503;
            step.ok = step.status >= 200 && step.status < 300;
            if (action === 'rotate') {
              const key = actorIdentifier(response?.body, 'apiKey');
              if (step.ok && key) run.secrets.iamApiKey = key;
              else { step.ok = false; step.status = 502; }
            }
          } else {
            const policy = enrollmentPolicy?.success ? enrollmentPolicy.data : null;
            const payload = action === 'disable'
              ? await requestMemoryJson('/v1/agents/' + encodeURIComponent(target.id), requestId, { active: false }, 'PATCH')
              : await requestMemoryJson('/v1/auth/tokens', requestId, { agent_id: target.id, scopes: policy?.scopes ?? DEFAULT_MEMORY_AGENT_SCOPES, workspace_ids: [policy?.workspaceId ?? 'default'], rotate_previous: true, expires_hours: policy?.expiresHours ?? 24, expires_at: enrollment?.credentialExpiresAt?.toISOString() }, 'POST');
            step.ok = Boolean(payload); step.status = payload ? 200 : 503;
            if (action === 'rotate') {
              const token = actorIdentifier(payload, 'token');
              if (step.ok && token) run.secrets.memoryToken = token;
              else { step.ok = false; step.status = 502; }
            }
          }
        } catch { step.ok = false; step.status = 503; }
        if (!step.ok && target.key === 'routerClientKeyId') delete run.secrets.routerApiKey;
        await checkpoint();
      }
      run.operation.status = targets.every((target) => run.steps[target.key]?.ok) ? 'completed' : 'partial';
      await checkpoint();
    } finally { await actorJournalWrite(() => journal.release(run.lease!)); }
  }
  const steps = Object.values(run.steps);
  const ok = ['completed', 'acknowledged'].includes(run.operation.status);
  await recordAuditEvent({ actorType: 'admin-user', adminUserId: user.id, action: 'hive-actor.' + action, entityType: 'hive-actor', entityId: actorId, metadata: { operationId: run.operation.id, identifiers, steps } });
  return context.json({ ok, actorId, action, operationId: run.operation.id, identifiers, secrets: run.secrets, steps, receiptExpiresAt: run.operation.receiptExpiresAt ? new Date(run.operation.receiptExpiresAt).toISOString() : null,
    remediation: ok ? null : 'Retry this operation ID to resume failed steps. Disable explicitly contains partial resources without deleting their records.' }, ok ? 200 : 207);
}

async function listHiveIncidents(requestId: string): Promise<Response> {
  const [traces, routerAudit, iamAudit] = await Promise.all([
    prisma.trace.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { events: { orderBy: { occurredAt: 'asc' } }, clientApiKey: true, provider: true },
    }),
    prisma.auditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { adminUser: true },
    }),
    requestIamJson('audit?limit=100', requestId).catch(() => null),
  ]);

  const incidents = buildIncidentTimeline({
    traces: traces.map((trace) => ({
      ...trace,
      clientApiKey: trace.clientApiKey ? sanitizeClientApiKey(trace.clientApiKey) : null,
    })) as unknown as Record<string, unknown>[],
    routerAudit: routerAudit.map((event) => ({
      ...event,
      adminUser: event.adminUser ? sanitizeAdminUser(event.adminUser) : null,
    })) as unknown as Record<string, unknown>[],
    iamAudit: extractArray(iamAudit, ['events', 'results', 'items']),
  });

  return Response.json({ data: incidents });
}

async function readUiIndex(): Promise<string> {
  const builtIndex = resolve(uiDistDir, 'index.html');
  if (existsSync(builtIndex)) {
    return readFile(builtIndex, 'utf8');
  }

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hive Router</title>
    <style>
      body { font-family: "IBM Plex Sans", sans-serif; background: #111827; color: #f9fafb; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      main { max-width: 40rem; padding: 2rem; background: rgba(17,24,39,0.88); border: 1px solid rgba(255,255,255,0.12); border-radius: 1.25rem; }
      h1 { margin-top: 0; }
      p { color: #d1d5db; line-height: 1.6; }
      code { background: rgba(255,255,255,0.08); padding: 0.1rem 0.35rem; border-radius: 0.4rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Hive Router Admin UI</h1>
      <p>The embedded UI has not been built yet. Run <code>npm run build:ui</code> inside <code>hive-router</code> to serve the compiled admin interface.</p>
    </main>
  </body>
</html>`;
}

interface AdminAppDependencies {
  authorizeSecurityExporterToken?: (token: string) => Promise<SecurityExporterAuthResult>;
  authorizeStaticSecurityExporterToken?: (token: string) => boolean;
}

export function createAdminApp(dependencies: AdminAppDependencies = {}): Hono<{ Variables: AppVariables }> {
  const env = loadEnv();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c,next)=>{if(maintenanceActive(new URL(c.req.url).pathname))return c.json({error:'Hive is undergoing maintenance'},503);await next();});
  const authorizeExporter = dependencies.authorizeSecurityExporterToken ?? authorizeSecurityExporterToken;
  const authorizeStaticExporter = dependencies.authorizeStaticSecurityExporterToken
    ?? ((token: string) => Boolean(
      env.HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED
      && env.HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH
      && token
      && verifyHash(token, env.HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH),
    ));

  app.use('*', requestIdMiddleware);
  app.use('*', async (context, next) => {
    await next();
    applyAdminSecurityHeaders(context.res.headers, env.NODE_ENV === 'production');
  });
  app.use('/api/*', bodyLimit({
    maxSize: env.MAX_ADMIN_BODY_BYTES,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/v1/*', bodyLimit({
    maxSize: env.MAX_ADMIN_BODY_BYTES,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/dashboard/*', bodyLimit({
    maxSize: env.MAX_ADMIN_BODY_BYTES,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/api/*', attachAdminSessionAndEnforcePermission);

  app.all('/v1/*', proxyHiveMemRequest);
  app.all('/dashboard', proxyHiveMemRequest);

  app.get('/api/security/events', async (context) => {
    const bearer = context.req.header('authorization')?.replace(/^Bearer\s+/iu, '') ?? '';
    const hashAuthorized = Boolean(bearer && authorizeStaticExporter(bearer));
    if (hashAuthorized) {
      securityExporterAuthCounter.inc({ method: 'static', outcome: 'authorized' });
      context.header('Warning', '299 Hive "Static security exporter credential is deprecated"');
    }
    if (!hashAuthorized) {
      const iamAuth = bearer
        ? await authorizeExporter(bearer)
        : { status: 'invalid' as const };
      securityExporterAuthCounter.inc({ method: 'iam', outcome: iamAuth.status });
      if (iamAuth.status === 'unavailable') {
        context.header('Retry-After', String(SECURITY_EXPORTER_RETRY_AFTER_SECONDS));
        context.header('Cache-Control', 'no-store');
        return context.json({ error: 'IAM authorization temporarily unavailable' }, 503);
      }
      if (iamAuth.status !== 'authorized') {
        return context.json({ error: 'Unauthorized' }, 401);
      }
    }
    const limit = Math.min(Math.max(Number(context.req.query('limit') ?? 200), 1), 500);
    const cursor = context.req.query('cursor');
    const rows = await prisma.auditEvent.findMany({
      where: securityExportWhere(cursor),
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const events = page.map(mapSecurityExportEvent);
    return context.json({
      events,
      nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
    });
  });
  app.all('/dashboard/*', proxyHiveMemRequest);
  app.all('/api/iam/*', requireAdminAuth, proxyIamRequest);

  app.get('/health', (context) => context.json({ ...metadata(releasePackageRoot), status: 'ok', plane: 'admin' }));
  app.get('/health/live', (context) => context.json({ ...metadata(releasePackageRoot), status: 'ok', plane: 'admin', checks: [{ name: 'process', status: 'pass', message: 'running' }] }));
  app.get('/health/dependencies', async (context) => {
    const report = await buildRouterDependencyReport();
    return context.json(report, report.status === 'ready' ? 200 : 503);
  });
  app.get('/health/ready', async (context) => {
    const report = await buildRouterDependencyReport();
    return context.json(report, report.status === 'ready' ? 200 : 503);
  });
  app.get('/ready', async (context) => {
    const report = await buildRouterDependencyReport();
    return context.json(report, report.status === 'ready' ? 200 : 503);
  });
  app.get('/metrics', requireMetricsAccess, async (context) => {
    context.header('content-type', metricsRegistry.contentType);
    return context.body(await metricsRegistry.metrics());
  });

  app.post('/api/auth/login', async (context) => {
    const body = loginSchema.parse(await context.req.json());
    const clientIp = socketClientIp(context);
    if (loginThrottle.isLocked(body.username, clientIp)) {
      return context.json({ error: 'Too many failed login attempts. Try again later.' }, 429);
    }

    const principal = await authenticateAdmin(body.username, body.password);
    if (!principal) {
      loginThrottle.recordFailure(body.username, clientIp);
      return context.json({ error: 'Invalid credentials' }, 401);
    }

    loginThrottle.recordSuccess(body.username, clientIp);
    await createAdminSession(principal, context);
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: principal.user.id,
      action: 'auth.login',
      entityType: 'admin-session',
    });
    return context.json({ ok: true, user: buildSessionUser(principal.user, principal.roles, principal.permissions) });
  });

  app.post('/api/auth/reauthenticate', requireAdminAuth, async (context) => {
    const current = context.get('adminUser');
    const input = z.object({ password: z.string().min(1).max(1024) }).parse(await context.req.json());
    const clientIp = socketClientIp(context);
    const throttleUser = current?.username ?? '';
    if (reauthThrottle.isLocked(throttleUser, clientIp)) {
      return context.json({ error: 'Too many failed reauthentication attempts. Try again later.' }, 429);
    }
    const principal = current ? await authenticateAdmin(current.username, input.password) : null;
    if (!principal) {
      reauthThrottle.recordFailure(throttleUser, clientIp);
      return context.json({ error: 'Reauthentication failed' }, 401);
    }
    reauthThrottle.recordSuccess(throttleUser, clientIp);
    await destroyAdminSession(context); await createAdminSession(principal, context);
    return context.json({ ok: true });
  });
  app.post('/api/auth/logout', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    await destroyAdminSession(context);
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'auth.logout',
      entityType: 'admin-session',
    });
    return context.json({ ok: true });
  });

  app.get('/api/auth/me', requireAdminAuth, (context) => {
    const user = context.get('adminUser');
    return context.json({ user: user ? buildSessionUser(user, context.get('adminRoles') ?? [], context.get('adminPermissions') ?? []) : null });
  });

  app.get('/api/providers', requireAdminAuth, async () => listProviders());
  app.get('/api/routes', requireAdminAuth, async () => listRoutes());
  app.get('/api/telemetry', requireAdminAuth, async () => listTelemetry());
  app.get('/api/traces', requireAdminAuth, async () => listTraces());
  app.get('/api/hive/status', requireAdminAuth, async (context) => context.json(await buildHiveStatus(env, context.get('requestId'))));
  app.get('/api/hive/updates', requireAdminAuth, async (context) => context.json({
    ...await updateStatus(metadata(releasePackageRoot).release, upgradeHome()),
    canApply: process.env['HIVE_UI_UPGRADE'] === 'true' && existsSync(projectFile(upgradeHome())),
  }));
  app.get('/api/hive/upgrades/status', requireAdminAuth, async (context) => {
    try { return context.json(await coordinatorRequest(upgradeHome(), 'status')); }
    catch { return context.json({ busy: false, result: durableUpgradeStatus(upgradeHome()), coordinatorAvailable: false }); }
  });
  for (const action of ['plan','apply'] as const) app.post(`/api/hive/upgrades/${action}`, requireAdminAuth, async (context) => {
    if (!hasAdminPermission(context.get('adminPermissions'), 'hive:upgrades:write')) return context.json({ error:'Forbidden' },403);
    if (context.req.header('origin') !== new URL(env.PUBLIC_ADMIN_URL).origin) return context.json({ error:'Invalid request origin' },403);
    if (process.env['HIVE_UI_UPGRADE'] !== 'true') return context.json({ error:'UI upgrades are disabled; enable HIVE_UI_UPGRADE for the enrolled coordinator and Router' },403);
    const parsed = (action === 'plan' ? UpgradePlanRequest : UpgradeApplyRequest).safeParse(await context.req.json().catch(()=>null));
    if (!parsed.success) return context.json({ error:'Invalid upgrade request' },400);
    try { return context.json(await coordinatorRequest(upgradeHome(),action,parsed.data), action === 'apply' ? 202 : 200); }
    catch { return context.json({ error:'Coordinator refused the request; inspect hive upgrade --dry-run locally' },409); }
  });
  app.get('/api/hive/skills', requireAdminAuth, async (context) => {
    if (!env.HIVE_SKILLS_INTERNAL_URL) return context.json({ configured: false, reason: 'Skills is not enabled for this installation' });
    try {
      const base = env.HIVE_SKILLS_INTERNAL_URL.replace(/\/$/, '');
      const [health, catalog] = await Promise.all([fetch(base + '/healthz', { signal: AbortSignal.timeout(5000) }), fetch(base + '/v1/skills', { signal: AbortSignal.timeout(5000) })]);
      return context.json({ configured: true, ready: health.ok, health: await health.json(), catalog: await catalog.json(), publicUrl: env.HIVE_SKILLS_PUBLIC_URL ?? base, sampledAt: new Date().toISOString() });
    } catch { return context.json({ configured: true, ready: false, error: 'Skills registry is unavailable', sampledAt: new Date().toISOString() }, 503); }
  });
  app.get('/api/hive/actors', requireAdminAuth, async (context) => listHiveActors(context.get('requestId')));
  app.post('/api/hive/actors', requireAdminAuth, createActor);
  app.delete('/api/hive/actors/:id/receipt', requireAdminAuth, async (context) => { await prisma.actorEnrollment.updateMany({ where: { actorId: getParamId(context), ownerId: context.get('adminUser')!.id }, data: { encryptedSecrets: null, receiptExpiresAt: null } }); return context.json({ ok: true }); });
  app.delete('/api/hive/actors/:id/operations/:operationId/receipt', requireAdminAuth, async (context) => {
    await actorJournalWrite(() => actorJournal().acknowledge(z.guid().parse(context.req.param('operationId')), context.get('adminUser')!.id));
    return context.json({ ok: true });
  });
  app.post('/api/hive/actors/:id/disable', requireAdminAuth, disableActor);
  app.post('/api/hive/actors/:id/rotate', requireAdminAuth, rotateActor);
  app.get('/api/hive/incidents', requireAdminAuth, async (context) => listHiveIncidents(context.get('requestId')));
  app.get('/api/memory/dashboard-data', requireAdminAuth, async (context) => buildMemoryConsoleData(context.get('requestId')));
  app.get('/api/memory/search', requireAdminAuth, async (context) => {
    const query = context.req.query('query')?.trim();
    const limit = context.req.query('limit') ?? '25';
    const workspaceId = context.req.query('workspace_id') ?? '*';
    const offset = context.req.query('offset') ?? '0';
    const scope = context.req.query('scope')?.trim();
    if (query) {
      return memoryAdminJson(context, '/v1/memories/search?explain=true', { query, limit: Number(limit), offset: Number(offset), workspace_id: workspaceId, ...(scope ? { scope } : {}) });
    }
    const scopeQuery = scope ? `&scope=${encodeURIComponent(scope)}` : '';
    return memoryAdminJson(context, `/v1/memories/browse?cursor=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}&workspace_id=${encodeURIComponent(workspaceId)}${scopeQuery}`);
  });
  app.post('/api/memory/memories', requireAdminAuth, async (context) => {
    const body = MemoryWriteSchema.parse(await context.req.json());
    return memoryAdminJson(context, '/v1/memories', body, 'POST');
  });
  app.get('/api/memory/memories/:id/graph', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/memories/${encodeURIComponent(context.req.param('id') ?? '')}/graph`);
  });
  app.get('/api/memory/memories/:id', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/memories/${encodeURIComponent(context.req.param('id') ?? '')}`);
  });
  app.patch('/api/memory/memories/:id', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/memories/${encodeURIComponent(context.req.param('id') ?? '')}`, await context.req.json(), 'PUT');
  });
  app.delete('/api/memory/memories/:id', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/memories/${encodeURIComponent(context.req.param('id') ?? '')}`, undefined, 'DELETE');
  });
  app.get('/api/memory/graph/neighborhood', requireAdminAuth, async (context) => {
    const incoming = new URL(context.req.url);
    return memoryAdminJson(context, `/v1/graph/neighborhood${incoming.search}`);
  });
  app.get('/api/memory/queue', requireAdminAuth, async (context) => {
    const incoming = new URL(context.req.url);
    return memoryAdminJson(context, `/v1/queue/status${incoming.search}`);
  });
  app.post('/api/memory/queue/run-next', requireAdminAuth, async (context) => {
    const incoming = new URL(context.req.url);
    return memoryAdminJson(context, `/v1/queue/run-next${incoming.search}`, {}, 'POST');
  });
  app.post('/api/memory/queue/:id/run', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/queue/jobs/${encodeURIComponent(context.req.param('id') ?? '')}/run`, {}, 'POST');
  });
  app.post('/api/memory/queue/:id/retry', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/queue/jobs/${encodeURIComponent(context.req.param('id') ?? '')}/retry`, {}, 'POST');
  });
  app.delete('/api/memory/queue/:id', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, `/v1/queue/jobs/${encodeURIComponent(context.req.param('id') ?? '')}`, undefined, 'DELETE');
  });
  app.post('/api/memory/conflicts', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, '/v1/memories/conflicts', await context.req.json(), 'POST');
  });
  app.get('/api/memory/webhooks', requireAdminAuth, async (context) => {
    return memoryAdminJson(context, '/v1/webhooks');
  });
  app.get('/api/memory/webhook-deliveries', requireAdminAuth, async (context) => {
    const incoming = new URL(context.req.url);
    return memoryAdminJson(context, `/v1/webhooks/deliveries${incoming.search}`);
  });

  app.post('/api/testing/preview', requireAdminAuth, async (context) => {
    const body = z.object({ cases: z.array(routingTestRequestSchema).min(1).max(30), ...routingPatchSchema.shape }).parse(await context.req.json());
    const providers = await listProviderRuntimes();
    const currentAliases = await prisma.modelAlias.findMany();
    const results = [];
    for (const sample of body.cases) {
      const { route } = await buildRouteTestRequest(sample.modelAlias, sample.prompt);
      const current = await resolveRoute(route, providers);
      const aliasPatch = body.aliases?.find((alias) => alias.alias === sample.modelAlias);
      const existing = currentAliases.find((alias) => alias.alias === sample.modelAlias);
      const proposed = await resolveRoute(route, providers, { ...(body.objective ? { objective: parseRoutingObjectiveConfig(body.objective) } : {}), ...(body.rules ? { rules: body.rules.filter((rule) => rule.enabled).map((rule, index) => ({ ...rule, id: 'preview-' + index, createdAt: new Date(0), updatedAt: new Date(0), matchJson: JSON.stringify(rule.matchJson), actionJson: JSON.stringify(rule.actionJson) })).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)) } : {}), ...(body.aliases ? { alias: aliasPatch ? { id: existing?.id ?? 'preview', createdAt: new Date(0), updatedAt: new Date(0), ...aliasPatch, providerId: aliasPatch.providerId ?? null, description: aliasPatch.description ?? null } : null } : {}) });
      results.push({ category: sample.modelAlias, current, proposed, changed: current.selectedProviderId !== proposed.selectedProviderId || current.targetModel !== proposed.targetModel, rejectedProviders: providers.filter((provider) => !proposed.candidateProviderIds.includes(provider.id)).map((provider) => ({ id: provider.id, reason: 'Excluded by capabilities, alias, or active rules' })) });
    }
    return context.json({ mode: 'selection-only', inferenceCalls: 0, results });
  });

  app.get('/api/routing/revisions', requireAdminAuth, async (context) => context.json({ ...await routingSnapshot(), history: await routingHistory() }));
  app.post('/api/routing/revisions', requireAdminAuth, async (context) => {
    const body = z.object({ baseRevision: z.string(), patch: routingPatchSchema }).parse(await context.req.json());
    const previous = await applyRoutingRevision(body.baseRevision, body.patch, context.get('adminUser')!.id);
    const current = await routingSnapshot();
    await recordAuditEvent({ actorType: 'admin-user', adminUserId: context.get('adminUser')!.id, action: 'routing.revision.apply', entityType: 'routing', entityId: current.revision, metadata: previous });
    return context.json({ ...current, ...previous });
  });
  app.post('/api/routing/revisions/:id/rollback', requireAdminAuth, async (context) => {
    const body = z.object({ baseRevision: z.string() }).parse(await context.req.json());
    await applyRoutingRevision(body.baseRevision, await savedRoutingRevision(getParamId(context)), context.get('adminUser')!.id);
    const current = await routingSnapshot();
    await recordAuditEvent({ actorType: 'admin-user', adminUserId: context.get('adminUser')!.id, action: 'routing.revision.rollback', entityType: 'routing', entityId: current.revision });
    return context.json(current);
  });

  app.post('/api/testing/run' , requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = routingTestRequestSchema.parse(await context.req.json());
    const providers = await listProviderRuntimes();
    const providerMap = mapProviderRuntimeById(providers);
    const startedAt = Date.now();

    const { route, requestBodyText } = await buildRouteTestRequest(body.modelAlias, body.prompt);
    const decision = await resolveRoute(route, providers);
    const upstreamRoute = withResolvedRouteModel(route, decision.targetModel);

    const candidateProviders = decision.candidateProviderIds
      .map((providerId) => providerMap.get(providerId))
      .filter((provider): provider is ProviderRuntime => Boolean(provider));

    let selectedProvider: ProviderRuntime | undefined;
    let responseText = '';
    let statusCode = decision.denialReason ? 403 : 0;
    let routingError = decision.denialReason;
    const attempts: Array<{
      provider: ReturnType<typeof summarizeProvider>;
      latencyMs: number;
      statusCode: number;
      success: boolean;
      error: string | null;
    }> = [];

    if (!routingError) {
      if (candidateProviders.length === 0) {
        routingError = 'No providers match the route decision criteria';
        statusCode = 503;
      } else {
        for (const provider of candidateProviders) {
          const adapter = getProviderAdapter(provider.kind);
          const attemptStartedAt = Date.now();
          try {
            const execution = await adapter.execute(upstreamRoute, provider);
            const text = await execution.response.text();
            statusCode = execution.response.status;
            responseText = text;
            const preview = resolveResponsePreview(text);

            attempts.push({
              provider: summarizeProvider(provider),
              latencyMs: Date.now() - attemptStartedAt,
              statusCode: execution.response.status,
              success: execution.response.ok,
              error: execution.response.ok ? null : preview,
            });

            if (execution.response.ok) {
              selectedProvider = provider;
              routingError = undefined;
              break;
            }

            if (shouldFailoverStatus(execution.response.status)) {
              routingError = preview;
              continue;
            }

            routingError = preview;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Provider execution error';
            statusCode = 503;
            responseText = JSON.stringify({ error: message });
            routingError = message;
            attempts.push({
              provider: summarizeProvider(provider),
              latencyMs: Date.now() - attemptStartedAt,
              statusCode,
              success: false,
              error: message,
            });
            continue;
          }
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const outcomeStatus = selectedProvider ? statusCode : 0;
    const success = Boolean(selectedProvider && outcomeStatus >= 200 && outcomeStatus < 300);

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'testing.run',
      entityType: 'routing-test',
      entityId: decision.selectedProviderId,
      metadata: {
        category: body.category ?? body.modelAlias,
        modelAlias: body.modelAlias,
        targetModel: decision.targetModel,
        selectedProviderId: selectedProvider?.id,
        success,
      },
    });

    return context.json({
      data: {
        requestId: route.requestId,
        category: body.category ?? body.modelAlias,
        modelAlias: body.modelAlias,
        prompt: body.prompt,
        requestBody: upstreamRoute.requestBodyText ?? requestBodyText,
        targetModel: decision.targetModel,
        latencyMs: elapsedMs,
        success,
        statusCode,
        providerError: routingError ?? null,
        decision: {
          selectedProviderId: decision.selectedProviderId,
          selectedProviderKind: decision.selectedProviderKind,
          targetModel: decision.targetModel,
          candidateProviderIds: decision.candidateProviderIds,
          fallbackProviderIds: decision.fallbackProviderIds,
          observations: decision.observations,
          triggeredRuleNames: decision.triggeredRuleNames,
          confidence: decision.confidence,
          denialReason: decision.denialReason,
          passthroughTargetPath: decision.passthroughTargetPath,
        },
        candidates: candidateProviders.map((provider) => summarizeProvider(provider)),
        attempts,
        selectedProvider: selectedProvider
          ? {
              id: selectedProvider.id,
              slug: selectedProvider.slug,
              name: selectedProvider.name,
              kind: selectedProvider.kind,
              model: decision.targetModel,
            }
          : null,
        responsePreview: clampText(responseToResult(responseText), body.maxResponseChars),
      },
    });
  });

  app.get('/api/heuristics', requireAdminAuth, async (context) => {
    const heuristics = await prisma.heuristicRule.findMany({ orderBy: [{ score: 'desc' }, { name: 'asc' }] });
    return context.json({ data: heuristics });
  });

  app.post('/api/providers', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = providerSchema.parse(await context.req.json());
    const encryptedAuthSecret = body.authSecret ? encryptText(body.authSecret) : undefined;
    const provider = await prisma.provider.create({
      data: {
        ...buildProviderCreateData({
          slug: body.slug,
          name: body.name,
          kind: body.kind,
          baseUrl: body.baseUrl,
          authMode: body.authMode,
          authHeaderName: body.authHeaderName,
          encryptedAuthSecret,
          defaultHeaders: body.defaultHeaders,
          capabilities: normalizeProviderCapabilities(body.capabilities),
          timeoutMs: body.timeoutMs,
          maxRetries: body.maxRetries,
          concurrency: body.concurrency,
          priority: body.priority,
          weight: body.weight,
          failoverGroup: body.failoverGroup,
          enabled: body.enabled,
        }),
        models: {
          create: buildProviderModelInputs(body.models),
        },
      },
      include: { models: true },
    });

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'provider.create',
      entityType: 'provider',
      entityId: provider.id,
      metadata: { slug: provider.slug, kind: provider.kind },
    });
    return context.json({ data: sanitizeProvider(provider) }, 201);
  });

  app.get('/api/providers/codex-oauth/status', requireAdminAuth, async (context) => {
    const provider = await prisma.provider.findUnique({
      where: { slug: 'openai-codex' },
      include: { models: true },
    });

    if (!provider) {
      return context.json({
        data: {
          authorized: false,
          provider: null,
        },
      });
    }

    const runtime = parseProviderRuntime(provider);
    const bundle = parseCodexTokenBundle(runtime.authSecret);
    return context.json({
      data: {
        authorized: Boolean(bundle?.accessToken && !bundle.refreshTokenQuarantined),
        provider: sanitizeProvider(provider),
        accountIdMasked: maskSecret(bundle?.accountId),
        planType: bundle?.planType ?? null,
        lastRefreshAt: bundle?.lastRefreshAt ?? null,
        refreshTokenQuarantined: bundle?.refreshTokenQuarantined ?? false,
      },
    });
  });

  app.post('/api/providers/codex-oauth/start', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const deviceCode = await requestCodexDeviceCode();
    const loginId = randomUUID();
    const pending = { ...deviceCode, loginId };
    pendingCodexOAuth.set(loginId, pending);

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'provider.codex-oauth.start',
      entityType: 'provider',
      metadata: { providerSlug: 'openai-codex' },
    });

    return context.json({
      data: pending,
    });
  });

  app.post('/api/providers/codex-oauth/check', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = codexOAuthCheckSchema.parse(await context.req.json());
    const pending = pendingCodexOAuth.get(body.loginId);

    if (!pending) {
      return context.json({
        data: {
          status: 'expired',
          message: 'This Codex authorization session is no longer active. Start a new authorization.',
        },
      });
    }

    if (Date.parse(pending.expiresAt) <= Date.now()) {
      pendingCodexOAuth.delete(body.loginId);
      return context.json({
        data: {
          status: 'expired',
          message: 'The Codex authorization code expired. Start a new authorization.',
        },
      });
    }

    const poll = await pollCodexDeviceCode(pending);
    if (poll.status === 'pending') {
      return context.json({ data: { status: 'pending' } });
    }
    if (poll.status === 'error') {
      return context.json({ data: { status: 'error', message: poll.message } });
    }

    const bundle = await exchangeCodexAuthorizationCode(poll);
    const provider = await upsertCodexOAuthProvider(bundle);
    pendingCodexOAuth.delete(body.loginId);

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'provider.codex-oauth.authorize',
      entityType: 'provider',
      entityId: provider.id,
      metadata: { slug: provider.slug, kind: provider.kind, planType: bundle.planType },
    });

    return context.json({
      data: {
        status: 'authorized',
        provider: sanitizeProvider(provider),
        accountIdMasked: maskSecret(bundle.accountId),
        planType: bundle.planType ?? null,
        lastRefreshAt: bundle.lastRefreshAt ?? null,
      },
    });
  });

  app.put('/api/providers/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = providerSchema.parse(await context.req.json());
    const encryptedAuthSecret = body.authSecret ? encryptText(body.authSecret) : undefined;
    const providerId = getParamId(context);
    const providerData: Partial<ReturnType<typeof buildProviderCreateData>> = buildProviderCreateData({
      slug: body.slug,
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl,
      authMode: body.authMode,
      authHeaderName: body.authHeaderName,
      encryptedAuthSecret,
      defaultHeaders: body.defaultHeaders,
      capabilities: normalizeProviderCapabilities(body.capabilities),
      timeoutMs: body.timeoutMs,
      maxRetries: body.maxRetries,
      concurrency: body.concurrency,
      priority: body.priority,
      weight: body.weight,
      failoverGroup: body.failoverGroup,
      enabled: body.enabled,
    });
    if (!encryptedAuthSecret) {
      delete providerData.encryptedAuthSecret;
    }

    await prisma.providerModel.deleteMany({ where: { providerId } });
    const updated = await prisma.provider.update({
      where: { id: providerId },
      data: {
        ...providerData,
        models: {
          create: buildProviderModelInputs(body.models),
        },
      },
      include: { models: true },
    });

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'provider.update',
      entityType: 'provider',
      entityId: updated.id,
      metadata: { slug: updated.slug, kind: updated.kind },
    });
    return context.json({ data: sanitizeProvider(updated) });
  });

  app.delete('/api/providers/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const providerId = getParamId(context);
    await prisma.provider.delete({ where: { id: providerId } });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'provider.delete',
      entityType: 'provider',
      entityId: providerId,
    });
    return context.json({ ok: true });
  });

  app.post('/api/providers/:id/discover', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const providerId = getParamId(context);
    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) {
      return context.json({ error: 'Provider not found' }, 404);
    }

    let result: Awaited<ReturnType<typeof discoverAndReconcileProviderModels>>;
    try {
      result = await discoverAndReconcileProviderModels(providerId);
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : 'Model discovery failed' },
        502,
      );
    }

    if (!result.supported) {
      return context.json(
        { error: `Model discovery is not supported for ${provider.kind} providers` },
        400,
      );
    }

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'provider.discover',
      entityType: 'provider',
      entityId: providerId,
      metadata: {
        slug: provider.slug,
        discovered: result.discovered.length,
        created: result.created.length,
        updated: result.updated.length,
        stale: result.stale.length,
      },
    });

    const refreshed = await prisma.provider.findUnique({
      where: { id: providerId },
      include: { models: true },
    });

    return context.json({
      data: {
        provider: refreshed ? sanitizeProvider(refreshed) : null,
        discovered: result.discovered,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        stale: result.stale,
      },
    });
  });

  app.get('/api/routing/adaptive', requireAdminAuth, async (context) => {
    const result = await resolveAdaptiveScores();
    const providers = await prisma.provider.findMany({ select: { id: true, slug: true, name: true } });
    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    return context.json({
      data: {
        config: result.config,
        providers: [...result.stats.values()].map((stat) => ({
          providerId: stat.providerId,
          slug: providerById.get(stat.providerId)?.slug ?? null,
          name: providerById.get(stat.providerId)?.name ?? null,
          samples: stat.samples,
          successRate: Math.round(stat.successRate * 1000) / 1000,
          avgLatencyMs: Math.round(stat.avgLatencyMs),
          avgTotalTokens: Math.round(stat.avgTotalTokens),
          scoreAdjustment: result.scores.get(stat.providerId) ?? 0,
        })),
      },
    });
  });

  app.put('/api/routing/adaptive', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = adaptiveRoutingSchema.parse(await context.req.json());
    const valueJson = JSON.stringify(body);
    await prisma.runtimeSetting.upsert({
      where: { key: ADAPTIVE_SETTING_KEY },
      create: { key: ADAPTIVE_SETTING_KEY, valueJson },
      update: { valueJson },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'routing.adaptive.update',
      entityType: 'runtime-setting',
      entityId: ADAPTIVE_SETTING_KEY,
      metadata: { enabled: body.enabled },
    });
    return context.json({ data: { config: body } });
  });

  app.get('/api/routing/objective', requireAdminAuth, async (context) => {
    return context.json({ data: { config: await loadRoutingObjectiveConfig() } });
  });

  app.put('/api/routing/objective', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = routingObjectiveSchema.parse(await context.req.json());
    const valueJson = JSON.stringify(body);
    await prisma.runtimeSetting.upsert({
      where: { key: ROUTING_OBJECTIVE_SETTING_KEY },
      create: { key: ROUTING_OBJECTIVE_SETTING_KEY, valueJson },
      update: { valueJson },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'routing.objective.update',
      entityType: 'runtime-setting',
      entityId: ROUTING_OBJECTIVE_SETTING_KEY,
      metadata: { goal: body.goal },
    });
    return context.json({ data: { config: body } });
  });

  app.get('/api/model-aliases', requireAdminAuth, async (context) => {
    const aliases = await prisma.modelAlias.findMany({
      include: { provider: true },
      orderBy: { alias: 'asc' },
    });
    return context.json({ data: aliases });
  });

  app.post('/api/model-aliases', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = modelAliasSchema.parse(await context.req.json());
    const validationError = await validateAliasModelChoice(body);
    if (validationError) {
      return context.json({ error: validationError }, 400);
    }

    const alias = await prisma.modelAlias.create({
      data: {
        alias: body.alias.trim(),
        upstreamModel: body.upstreamModel.trim(),
        enabled: body.enabled,
        description: body.description ?? null,
        ...(body.providerId ? { provider: { connect: { id: body.providerId } } } : {}),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'model-alias.create',
      entityType: 'model-alias',
      entityId: alias.id,
      metadata: body,
    });
    return context.json({ data: alias }, 201);
  });

  app.put('/api/model-aliases/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = modelAliasSchema.parse(await context.req.json());
    const validationError = await validateAliasModelChoice(body);
    if (validationError) {
      return context.json({ error: validationError }, 400);
    }

    const alias = await prisma.modelAlias.update({
      where: { id: getParamId(context) },
      data: {
        alias: body.alias.trim(),
        upstreamModel: body.upstreamModel.trim(),
        enabled: body.enabled,
        description: body.description ?? null,
        ...(body.providerId
          ? { provider: { connect: { id: body.providerId } } }
          : { provider: { disconnect: true } }),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'model-alias.update',
      entityType: 'model-alias',
      entityId: alias.id,
      metadata: body,
    });
    return context.json({ data: alias });
  });

  app.delete('/api/model-aliases/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const aliasId = getParamId(context);
    await prisma.modelAlias.delete({ where: { id: aliasId } });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'model-alias.delete',
      entityType: 'model-alias',
      entityId: aliasId,
    });
    return context.json({ ok: true });
  });

  app.get('/api/route-rules', requireAdminAuth, async (context) => {
    const rules = await prisma.routeRule.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
    return context.json({ data: rules });
  });

  app.post('/api/route-rules', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = routeRuleSchema.parse(await context.req.json());
    const rule = await prisma.routeRule.create({
      data: {
        ...body,
        matchJson: JSON.stringify(body.matchJson),
        actionJson: JSON.stringify(body.actionJson),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'route-rule.create',
      entityType: 'route-rule',
      entityId: rule.id,
      metadata: body,
    });
    return context.json({ data: rule }, 201);
  });

  app.put('/api/route-rules/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = routeRuleSchema.parse(await context.req.json());
    const rule = await prisma.routeRule.update({
      where: { id: getParamId(context) },
      data: {
        ...body,
        matchJson: JSON.stringify(body.matchJson),
        actionJson: JSON.stringify(body.actionJson),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'route-rule.update',
      entityType: 'route-rule',
      entityId: rule.id,
      metadata: body,
    });
    return context.json({ data: rule });
  });

  app.delete('/api/route-rules/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const ruleId = getParamId(context);
    await prisma.routeRule.delete({ where: { id: ruleId } });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'route-rule.delete',
      entityType: 'route-rule',
      entityId: ruleId,
    });
    return context.json({ ok: true });
  });

  app.post('/api/heuristics', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = heuristicSchema.parse(await context.req.json());
    const heuristic = await prisma.heuristicRule.create({
      data: {
        ...body,
        actionJson: JSON.stringify(body.actionJson),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'heuristic.create',
      entityType: 'heuristic',
      entityId: heuristic.id,
      metadata: body,
    });
    return context.json({ data: heuristic }, 201);
  });

  app.put('/api/heuristics/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = heuristicSchema.parse(await context.req.json());
    const heuristic = await prisma.heuristicRule.update({
      where: { id: getParamId(context) },
      data: {
        ...body,
        actionJson: JSON.stringify(body.actionJson),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'heuristic.update',
      entityType: 'heuristic',
      entityId: heuristic.id,
      metadata: body,
    });
    return context.json({ data: heuristic });
  });

  app.delete('/api/heuristics/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const heuristicId = getParamId(context);
    await prisma.heuristicRule.delete({ where: { id: heuristicId } });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'heuristic.delete',
      entityType: 'heuristic',
      entityId: heuristicId,
    });
    return context.json({ ok: true });
  });

  app.get('/api/client-keys', requireAdminAuth, async (context) => {
    const keys = await prisma.clientApiKey.findMany({ orderBy: { createdAt: 'desc' } });
    return context.json({ data: keys.map((key) => sanitizeClientApiKey(key)) });
  });

  app.post('/api/client-keys', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = clientKeySchema.parse(await context.req.json());
    const rawKey = generateOpenAiStyleApiKey();
    const created = await prisma.clientApiKey.create({
      data: {
        name: body.name,
        keyPrefix: rawKey.slice(0, 8),
        keyHash: hashValue(rawKey),
        metadataJson: JSON.stringify(body.metadata ?? {}),
      },
    });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'client-key.create',
      entityType: 'client-key',
      entityId: created.id,
      metadata: { name: created.name },
    });
    return context.json({
      data: {
        id: created.id,
        name: created.name,
        keyPrefix: created.keyPrefix,
        apiKey: rawKey,
      },
    }, 201);
  });

  app.post('/api/client-keys/:id/rotate', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const id = getParamId(context);
    const rotated = await rotateClientKey(id);
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'client-key.rotate',
      entityType: 'client-key',
      entityId: id,
      metadata: { name: rotated.safeKey.name },
    });
    return context.json({ data: { ...rotated.safeKey, apiKey: rotated.apiKey } });
  });

  app.put('/api/client-keys/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const id = getParamId(context);
    const body = clientKeyUpdateSchema.parse(await context.req.json());

    const updated = await prisma.clientApiKey.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.metadata !== undefined ? { metadataJson: JSON.stringify(body.metadata) } : {}),
      },
    });

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'client-key.update',
      entityType: 'client-key',
      entityId: updated.id,
      metadata: { name: updated.name },
    });

    return context.json({ data: sanitizeClientApiKey(updated) });
  });

  app.delete('/api/client-keys/:id', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const id = getParamId(context);
    await prisma.clientApiKey.delete({ where: { id } });
    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'client-key.delete',
      entityType: 'client-key',
      entityId: id,
    });
    return context.json({ ok: true });
  });

  app.get('/api/client-keys/:id/usage', requireAdminAuth, async (context) => {
    const id = getParamId(context);
    const key = await prisma.clientApiKey.findUnique({ where: { id } });
    if (!key) {
      return context.json({ error: 'Client key not found' }, 404);
    }
    const limits = readClientKeyQuota(key.metadataJson);
    const usage = await computeClientKeyUsage(id);
    const evaluation = evaluateQuota(limits, usage);
    return context.json({
      data: {
        clientApiKeyId: id,
        history: quotaLedger().history(),
        daily: quotaLedger().trends(id),
        name: key.name,
        limits,
        usage: evaluation.usage,
        allowed: evaluation.allowed,
        exceeded: evaluation.exceeded,
        warnings: evaluation.warnings,
      },
    });
  });

  app.get('/api/config/export', requireAdminAuth, async (context) => {
    const [providers, aliases, routeRules, heuristicRules, runtimeSettings] = await Promise.all([
      prisma.provider.findMany({ include: { models: true }, orderBy: { priority: 'asc' } }),
      prisma.modelAlias.findMany({ orderBy: { alias: 'asc' } }),
      prisma.routeRule.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
      prisma.heuristicRule.findMany({ orderBy: [{ score: 'desc' }, { name: 'asc' }] }),
      prisma.runtimeSetting.findMany({ orderBy: { key: 'asc' } }),
    ]);

    return context.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        providers: providers.map(({ encryptedAuthSecret: _encryptedAuthSecret, ...provider }) => provider),
        aliases,
        routeRules,
        heuristicRules,
        runtimeSettings,
      },
    });
  });

  app.post('/api/config/import', requireAdminAuth, async (context) => {
    const user = context.get('adminUser');
    const body = configImportSchema.parse(await context.req.json());

    const payload = body.data;
    if (!payload) {
      return context.json({ error: 'Missing import payload' }, 400);
    }

    for (const provider of payload.providers ?? []) {
      const existing = await prisma.provider.findUnique({ where: { slug: provider.slug } });
      const saved = existing
        ? await prisma.provider.update({
            where: { id: existing.id },
            data: {
              name: provider.name,
              kind: provider.kind,
              baseUrl: provider.baseUrl,
              authMode: provider.authMode ?? AuthMode.BEARER,
              authHeaderName: provider.authHeaderName ?? 'Authorization',
              encryptedAuthSecret: provider.encryptedAuthSecret === undefined ? existing.encryptedAuthSecret : provider.encryptedAuthSecret,
              defaultHeadersJson: provider.defaultHeadersJson ?? '{}',
              capabilityJson: provider.capabilityJson ?? '{}',
              timeoutMs: provider.timeoutMs ?? 120000,
              maxRetries: provider.maxRetries ?? 1,
              concurrency: provider.concurrency ?? 16,
              priority: provider.priority ?? 100,
              weight: provider.weight ?? 100,
              failoverGroup: provider.failoverGroup ?? null,
              enabled: provider.enabled ?? true,
            },
          })
        : await prisma.provider.create({
            data: {
              slug: provider.slug,
              name: provider.name,
              kind: provider.kind,
              baseUrl: provider.baseUrl,
              authMode: provider.authMode ?? AuthMode.BEARER,
              authHeaderName: provider.authHeaderName ?? 'Authorization',
              encryptedAuthSecret: provider.encryptedAuthSecret ?? null,
              defaultHeadersJson: provider.defaultHeadersJson ?? '{}',
              capabilityJson: provider.capabilityJson ?? '{}',
              passthroughJson: '[]',
              timeoutMs: provider.timeoutMs ?? 120000,
              maxRetries: provider.maxRetries ?? 1,
              concurrency: provider.concurrency ?? 16,
              priority: provider.priority ?? 100,
              weight: provider.weight ?? 100,
              failoverGroup: provider.failoverGroup ?? null,
              enabled: provider.enabled ?? true,
            },
          });

      await prisma.providerModel.deleteMany({ where: { providerId: saved.id } });
      if (provider.models?.length) {
        await prisma.providerModel.createMany({
          data: provider.models.map((model) => ({
            providerId: saved.id,
            model: model.model,
            displayName: model.displayName ?? null,
            enabled: model.enabled ?? true,
            maxContextWindow: model.maxContextWindow ?? null,
            capabilityJson: model.capabilityJson ?? '{}',
          })),
        });
      }
    }

    for (const alias of payload.aliases ?? []) {
      const aliasData = {
        alias: alias.alias,
        providerId: alias.providerId ?? null,
        upstreamModel: alias.upstreamModel,
        enabled: alias.enabled ?? true,
        description: alias.description ?? null,
      };
      await prisma.modelAlias.upsert({
        where: { alias: alias.alias },
        update: aliasData,
        create: aliasData,
      });
    }

    for (const rule of payload.routeRules ?? []) {
      await prisma.routeRule.upsert({
        where: { name: rule.name },
        update: {
          kind: rule.kind,
          priority: rule.priority ?? 100,
          enabled: rule.enabled ?? true,
          matchJson: rule.matchJson,
          actionJson: rule.actionJson,
        },
        create: {
          name: rule.name,
          kind: rule.kind,
          priority: rule.priority ?? 100,
          enabled: rule.enabled ?? true,
          matchJson: rule.matchJson,
          actionJson: rule.actionJson,
        },
      });
    }

    for (const heuristic of payload.heuristicRules ?? []) {
      await prisma.heuristicRule.upsert({
        where: { name: heuristic.name },
        update: {
          category: heuristic.category,
          pattern: heuristic.pattern,
          score: heuristic.score ?? 10,
          enabled: heuristic.enabled ?? true,
          actionJson: heuristic.actionJson,
        },
        create: {
          name: heuristic.name,
          category: heuristic.category,
          pattern: heuristic.pattern,
          score: heuristic.score ?? 10,
          enabled: heuristic.enabled ?? true,
          actionJson: heuristic.actionJson,
        },
      });
    }

    for (const setting of payload.runtimeSettings ?? []) {
      await prisma.runtimeSetting.upsert({
        where: { key: setting.key },
        update: { valueJson: setting.valueJson },
        create: { key: setting.key, valueJson: setting.valueJson },
      });
    }

    await recordAuditEvent({
      actorType: 'admin-user',
      adminUserId: user?.id,
      action: 'config.import',
      entityType: 'config',
      metadata: { imported: true },
    });

    return context.json({ ok: true });
  });

  for (const route of ['/api-docs/index', '/api/docs/index']) app.get(route, requireAdminAuth, async (context) => {
    const providers = await prisma.provider.findMany({ orderBy: { name: 'asc' } });
    return context.json({
      docs: builtinApiDocs,
      providers,
    });
  });

  for (const route of ['/api-docs/openapi.json', '/api/docs/openapi.json']) app.get(route, requireAdminAuth, async (context) => {
    const doc = buildRouterOpenApiDocument(env.PUBLIC_ADMIN_URL);
    return context.json(doc);
  });

  for (const route of ['/api-docs/providers/:providerId', '/api/docs/providers/:providerId']) app.get(route, requireAdminAuth, async (context) => {
    const providerId = getParamId(context, 'providerId');
    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) {
      return context.json({ error: 'Provider not found' }, 404);
    }

    const entries = builtinApiDocs.filter((entry) => entry.providerKind === provider.kind || entry.scope === 'router');
    return context.json({
      provider: sanitizeProvider({ ...provider, models: [] }),
      docs: entries,
    });
  });

  app.get('/api/audit', requireAdminAuth, async (context) => {
    const events = await prisma.auditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { adminUser: true },
    });
    return context.json({
      data: events.map((event) => ({
        ...event,
        adminUser: event.adminUser ? sanitizeAdminUser(event.adminUser) : null,
      })),
    });
  });

  app.get('/api/runtime-settings', requireAdminAuth, async (context) => {
    const settings = await prisma.runtimeSetting.findMany({ orderBy: { key: 'asc' } });
    return context.json({ data: settings.map((setting) => ({ ...setting, parsed: safeJsonParse(setting.valueJson, null) })) });
  });

  app.get('/assets/*', async (context) => {
    // Resolve and validate that the path stays within ui/dist to prevent traversal.
    const filePath = resolve(uiDistDir, context.req.path.slice(1));
    if (!filePath.startsWith(uiDistDir + '/') || !existsSync(filePath)) {
      return context.notFound();
    }
    const content = await readFile(filePath);
    const contentType = filePath.endsWith('.js')
      ? 'application/javascript'
      : filePath.endsWith('.css')
        ? 'text/css'
        : filePath.endsWith('.svg')
          ? 'image/svg+xml'
          : 'application/octet-stream';
    context.header('content-type', contentType);
    return context.body(content);
  });

  app.get('*', async (context) => {
    if (context.req.path.startsWith('/api/')) {
      return context.notFound();
    }
    context.header('content-type', 'text/html; charset=utf-8');
    return context.body(await readUiIndex());
  });

  app.onError((err, context) => {
    if (err instanceof HTTPException) return context.json({ error: err.message }, err.status);
    if (err instanceof ZodError) {
      return context.json({ error: 'Validation error', issues: err.issues }, 400);
    }
    log('error', 'Admin request failed', {
      requestId: context.get('requestId'),
      path: context.req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    return context.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
