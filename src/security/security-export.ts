import type { AuditEvent, Prisma } from '../generated/prisma/client.js';

export const SECURITY_EXPORT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'hive-actor.create',
  'hive-actor.disable',
  'hive-actor.rotate',
  'provider.create',
  'provider.codex-oauth.start',
  'provider.codex-oauth.authorize',
  'provider.update',
  'provider.delete',
  'provider.discover',
  'routing.adaptive.update',
  'routing.objective.update',
  'route-rule.create',
  'route-rule.update',
  'route-rule.delete',
  'client-key.create',
  'client-key.rotate',
  'client-key.update',
  'client-key.delete',
] as const;

const METADATA_ALLOWLISTS: Partial<Record<(typeof SECURITY_EXPORT_ACTIONS)[number], readonly string[]>> = {
  'provider.create': ['slug', 'kind'],
  'provider.codex-oauth.start': ['providerSlug'],
  'provider.codex-oauth.authorize': ['slug', 'kind', 'planType'],
  'provider.update': ['slug', 'kind'],
  'provider.discover': ['slug', 'discovered'],
  'routing.adaptive.update': ['enabled'],
};

function safeMetadataValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 256);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

export function sanitizeSecurityExportMetadata(action: string, metadataJson: string | null): Record<string, unknown> | null {
  const allowedKeys = METADATA_ALLOWLISTS[action as (typeof SECURITY_EXPORT_ACTIONS)[number]];
  if (!allowedKeys || !metadataJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const value = safeMetadataValue(source[key]);
    if (value !== undefined) sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export function securityExportWhere(cursor?: string): Prisma.AuditEventWhereInput {
  return {
    action: { in: [...SECURITY_EXPORT_ACTIONS] },
    ...(cursor ? { id: { gt: cursor } } : {}),
  };
}

export function mapSecurityExportEvent(event: AuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    timestamp: event.createdAt.toISOString(),
    eventType: `hive.${event.action}`,
    action: event.action,
    actor: event.actorType,
    outcome: /deny|fail|error/iu.test(event.action) ? 'failure' : 'success',
    entityType: event.entityType,
    entityId: event.entityId,
    summary: `${event.action} on ${event.entityType}`,
    metadata: sanitizeSecurityExportMetadata(event.action, event.metadataJson),
  };
}
