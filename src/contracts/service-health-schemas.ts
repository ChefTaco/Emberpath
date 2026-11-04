import { z } from 'zod';

export type HiveAppKey = 'iam' | 'memory' | 'router';
export type HiveAppState = 'online' | 'degraded' | 'offline';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export interface HiveHealthCheck {
  name: string;
  status: string;
  message?: string;
  latencyMs?: number;
}

export interface HiveAppStatus {
  key: HiveAppKey;
  name: string;
  role: string;
  status: HiveAppState;
  summary: string;
  internalUrl: string;
  publicUrl: string;
  consoleUrl: string;
  latencyMs?: number;
  checks: HiveHealthCheck[];
  details?: Record<string, JsonValue>;
}

export interface ServiceHealthPayload {
  status?: string;
  checks: HiveHealthCheck[];
  raw: Record<string, JsonValue>;
}

export interface ServiceHealthProbeResult {
  ok: boolean;
  statusCode: number;
  payload: ServiceHealthPayload | null;
}

export interface TypedServiceHealthProbeResult<TPayload> {
  ok: boolean;
  statusCode: number;
  payload: TPayload | null;
}


export const hiveHealthCheckSchema = z.object({
  name: z.string().catch('check'),
  status: z.string().catch('unknown'),
  message: z.string().optional(),
  latencyMs: z.number().finite().optional(),
}).passthrough();

const serviceHealthSchema = z.object({
  status: z.string().optional(),
  checks: z.array(hiveHealthCheckSchema).default([]),
}).passthrough();

export const iamHealthPayloadSchema = z.object({
  status: z.enum(['healthy', 'degraded']),
  version: z.string().optional(),
  uptime: z.number().int().nonnegative().optional(),
  timestamp: z.string().optional(),
  checks: z.array(hiveHealthCheckSchema),
}).passthrough();

export const memoryQdrantHealthSchema = z.object({
  connected: z.boolean(),
  collections: z.array(z.string()).optional(),
  client_version: z.string().nullable().optional(),
  server_version: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
}).passthrough();

export const memoryEmbeddingHealthSchema = z.object({
  ready: z.boolean(),
  model_path: z.string().nullable().optional(),
  vector_dim: z.number().int().positive().nullable().optional(),
}).passthrough();

export const memoryQueueWorkerHealthSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  in_flight: z.number().int().nonnegative().optional(),
  max_workers: z.number().int().positive().optional(),
  poll_interval_seconds: z.number().nonnegative().optional(),
  heartbeat_interval_seconds: z.number().nonnegative().optional(),
  stale_lock_seconds: z.number().nonnegative().optional(),
}).passthrough();

export const memoryConsolidationCronHealthSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  interval_seconds: z.number().nonnegative().optional(),
  last_check_at: z.string().nullable().optional(),
  last_scheduled_at: z.string().nullable().optional(),
  next_check_at: z.string().nullable().optional(),
  last_new_memory_count: z.number().int().nonnegative().optional(),
  last_job_ids: z.array(z.string()).optional(),
  last_error: z.string().nullable().optional(),
  last_run_status: z.string().nullable().optional(),
}).passthrough();

export const memoryHealthPayloadSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string().optional(),
  service: z.string().optional(),
  implementation: z.string().optional(),
  timestamp: z.string().optional(),
  uptime_seconds: z.number().nonnegative().optional(),
  checks: z.array(hiveHealthCheckSchema).optional(),
  qdrant: memoryQdrantHealthSchema.optional(),
  embedding: memoryEmbeddingHealthSchema.optional(),
  queue_worker: memoryQueueWorkerHealthSchema.optional(),
  consolidation_cron: memoryConsolidationCronHealthSchema.optional(),
}).passthrough();

export type IamHealthPayload = z.infer<typeof iamHealthPayloadSchema>;
export type MemoryHealthPayload = z.infer<typeof memoryHealthPayloadSchema>;

function normalizeCheck(check: z.infer<typeof hiveHealthCheckSchema>): HiveHealthCheck {
  return {
    name: check.name,
    status: check.status,
    ...(check.message ? { message: check.message } : {}),
    ...(typeof check.latencyMs === 'number' ? { latencyMs: check.latencyMs } : {}),
  };
}

function parseJsonRecord(text: string): Record<string, JsonValue> | null {
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const result = z.record(z.string(), jsonValueSchema).safeParse(parsed);
  return result.success ? result.data : null;
}

export function parseServiceHealthPayload(text: string): ServiceHealthPayload | null {
  const raw = parseJsonRecord(text);
  if (!raw) return null;

  const result = serviceHealthSchema.safeParse(raw);
  if (!result.success) return null;
  return {
    ...(result.data.status ? { status: result.data.status } : {}),
    checks: result.data.checks.map(normalizeCheck),
    raw,
  };
}

export function parseIamHealthPayload(text: string): IamHealthPayload | null {
  const raw = parseJsonRecord(text);
  if (!raw) return null;
  const result = iamHealthPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseMemoryHealthPayload(text: string): MemoryHealthPayload | null {
  const raw = parseJsonRecord(text);
  if (!raw) return null;
  const result = memoryHealthPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function normalizeIamHealthPayload(payload: IamHealthPayload): ServiceHealthPayload {
  return {
    status: payload.status,
    checks: payload.checks.map(normalizeCheck),
    raw: jsonValueSchema.parse(payload) as Record<string, JsonValue>,
  };
}

function statusFromBoolean(pass: boolean): 'pass' | 'fail' {
  return pass ? 'pass' : 'fail';
}

function optionalRuntimeCheck(name: string, enabled: boolean | undefined, running: boolean | undefined): HiveHealthCheck | null {
  if (typeof enabled !== 'boolean' || typeof running !== 'boolean') return null;
  if (!enabled) return { name, status: 'pass', message: 'disabled' };
  return { name, status: running ? 'pass' : 'warn', message: running ? 'running' : 'enabled but stopped' };
}

export function normalizeMemoryHealthPayload(payload: MemoryHealthPayload): ServiceHealthPayload {
  const checks: HiveHealthCheck[] = payload.checks?.map(normalizeCheck) ?? [];
  if (payload.qdrant) {
    checks.push({
      name: 'qdrant',
      status: statusFromBoolean(payload.qdrant.connected),
      message: payload.qdrant.connected ? 'connected' : payload.qdrant.error ?? 'unreachable',
    });
  }
  if (payload.embedding) {
    checks.push({
      name: 'embedding',
      status: statusFromBoolean(payload.embedding.ready),
      message: payload.embedding.ready ? 'ready' : 'not ready',
    });
  }
  const queueCheck = optionalRuntimeCheck('queue-worker', payload.queue_worker?.enabled, payload.queue_worker?.running);
  if (queueCheck) checks.push(queueCheck);
  const cronCheck = optionalRuntimeCheck('consolidation-cron', payload.consolidation_cron?.enabled, payload.consolidation_cron?.running);
  if (cronCheck) checks.push(cronCheck);

  return {
    status: payload.status,
    checks,
    raw: jsonValueSchema.parse(payload) as Record<string, JsonValue>,
  };
}

export function mapServiceHealthState(responseOk: boolean, payload: ServiceHealthPayload | null): HiveAppState {
  const rawStatus = payload?.status?.toLowerCase();
  if (rawStatus === 'healthy' || rawStatus === 'ready' || rawStatus === 'ok') return 'online';
  if (rawStatus === 'degraded' || rawStatus === 'pass') return 'degraded';
  return responseOk ? 'online' : 'offline';
}

export const tlsCertificateStatusSchema = z.object({
  configured: z.boolean(),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
  certPath: z.string().optional(),
  expectedHost: z.string().optional(),
  hostnameMatched: z.boolean().optional(),
  subject: z.string().optional(),
  issuer: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  daysRemaining: z.number().int().optional(),
  domains: z.array(z.string()),
}).strict();

export const hiveAppStatusSchema = z.object({
  key: z.enum(['iam', 'memory', 'router']),
  name: z.string(),
  role: z.string(),
  status: z.enum(['online', 'degraded', 'offline']),
  summary: z.string(),
  internalUrl: z.string(),
  publicUrl: z.string(),
  consoleUrl: z.string(),
  latencyMs: z.number().finite().optional(),
  checks: z.array(hiveHealthCheckSchema),
  details: z.record(z.string(), jsonValueSchema).optional(),
}).strict();

export const hiveStatusResponseSchema = z.object({
  generatedAt: z.string(),
  uiUrl: z.string(),
  apps: z.array(hiveAppStatusSchema),
}).strict();

export type TlsCertificateStatus = z.infer<typeof tlsCertificateStatusSchema>;
export interface HiveStatusResponse {
  generatedAt: string;
  uiUrl: string;
  apps: HiveAppStatus[];
}

export function parseHiveStatusResponse(payload: unknown): HiveStatusResponse {
  return hiveStatusResponseSchema.parse(payload) as HiveStatusResponse;
}
