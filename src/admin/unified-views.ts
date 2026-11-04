type JsonRecord = Record<string, unknown>;

export type HiveActorKind = 'user' | 'service-account' | 'system-user' | 'router-key' | 'memory-agent';
export type HiveActorStatus = 'active' | 'inactive' | 'unknown';

export interface HiveActor {
  id: string;
  kind: HiveActorKind;
  label: string;
  status: HiveActorStatus;
  sources: string[];
  identifiers: JsonRecord;
  capabilities: string[];
  lastActivityAt: string | null;
  linkedResourceCount: number;
}

export interface HiveIncidentEvent {
  id: string;
  service: 'router' | 'iam' | 'memory';
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: string;
  title: string;
  requestId: string | null;
  actor: string | null;
  outcome: string | null;
  details: JsonRecord;
}

export interface HiveIncident {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'resolved';
  title: string;
  summary: string;
  startedAt: string;
  endedAt: string;
  requestIds: string[];
  services: string[];
  actors: string[];
  events: HiveIncidentEvent[];
}

export interface BuildHiveActorsInput {
  iamUsers: JsonRecord[];
  iamServiceAccounts: JsonRecord[];
  iamSystemUsers: JsonRecord[];
  routerClientKeys: JsonRecord[];
  memoryAgents: JsonRecord[];
  traces: JsonRecord[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const sorted = values
    .filter((value): value is string => typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return sorted[0] ?? null;
}

function actorKey(kind: HiveActorKind, id: string): string {
  return `${kind}:${id}`;
}

function actorLabel(record: JsonRecord, fallback: string): string {
  return asString(record.displayName) ?? asString(record.name) ?? asString(record.username) ?? asString(record.email) ?? fallback;
}

function mergeActor(map: Map<string, HiveActor>, actor: HiveActor): void {
  const existing = map.get(actor.id);
  if (!existing) {
    map.set(actor.id, actor);
    return;
  }

  map.set(actor.id, {
    ...existing,
    label: existing.label || actor.label,
    status: existing.status === 'active' || actor.status === 'active' ? 'active' : existing.status,
    sources: uniqueStrings([...existing.sources, ...actor.sources]),
    capabilities: uniqueStrings([...existing.capabilities, ...actor.capabilities]).sort(),
    identifiers: { ...existing.identifiers, ...actor.identifiers },
    lastActivityAt: maxIso([existing.lastActivityAt, actor.lastActivityAt]),
    linkedResourceCount: existing.linkedResourceCount + actor.linkedResourceCount,
  });
}

export function buildHiveActors(input: BuildHiveActorsInput): HiveActor[] {
  const actors = new Map<string, HiveActor>();

  for (const user of input.iamUsers) {
    const id = asString(user.id) ?? asString(user.username) ?? asString(user.email);
    if (!id) continue;
    const roles = asArray(user.roles)
      .map((assignment) => {
        const role = assignment && typeof assignment === 'object' ? (assignment as JsonRecord).role : null;
        return role && typeof role === 'object' ? asString((role as JsonRecord).name) : asString(assignment);
      });
    mergeActor(actors, {
      id: actorKey('user', id),
      kind: 'user',
      label: actorLabel(user, id),
      status: asBoolean(user.active) === false ? 'inactive' : 'active',
      sources: ['iam'],
      identifiers: { iamUserId: id, username: asString(user.username), email: asString(user.email) },
      capabilities: uniqueStrings(roles).sort(),
      lastActivityAt: maxIso([asString(user.lastLoginAt), asString(user.updatedAt), asString(user.createdAt)]),
      linkedResourceCount: 1,
    });
  }

  for (const account of input.iamServiceAccounts) {
    const id = asString(account.id) ?? asString(account.name);
    if (!id) continue;
    const roles = asArray(account.roles)
      .map((assignment) => {
        const role = assignment && typeof assignment === 'object' ? (assignment as JsonRecord).role : null;
        return role && typeof role === 'object' ? asString((role as JsonRecord).name) : asString(assignment);
      });
    mergeActor(actors, {
      id: actorKey('service-account', id),
      kind: 'service-account',
      label: actorLabel(account, id),
      status: asBoolean(account.active) === false ? 'inactive' : 'active',
      sources: ['iam'],
      identifiers: { iamServiceAccountId: id, keyPrefix: asString(account.keyPrefix) ?? asString(account.apiKeyPrefix) },
      capabilities: uniqueStrings(roles).sort(),
      lastActivityAt: maxIso([asString(account.lastUsedAt), asString(account.updatedAt), asString(account.createdAt)]),
      linkedResourceCount: 1,
    });
  }

  for (const systemUser of input.iamSystemUsers) {
    const id = asString(systemUser.id) ?? asString(systemUser.linuxUsername);
    if (!id) continue;
    mergeActor(actors, {
      id: actorKey('system-user', id),
      kind: 'system-user',
      label: asString(systemUser.linuxUsername) ?? id,
      status: 'active',
      sources: ['iam', 'host'],
      identifiers: { iamSystemUserId: id, iamUserId: asString(systemUser.userId), linuxUsername: asString(systemUser.linuxUsername) },
      capabilities: asBoolean(systemUser.sudoEnabled) ? ['sudo'] : [],
      lastActivityAt: asString(systemUser.createdAt),
      linkedResourceCount: 1,
    });
  }

  for (const key of input.routerClientKeys) {
    const id = asString(key.id) ?? asString(key.name);
    if (!id) continue;
    const metadata = parseJson(key.metadataJson);
    const owner = asString(metadata.owner) ?? asString(metadata.host) ?? asString(key.name);
    const traces = input.traces.filter((trace) => asString(trace.clientApiKeyId) === id);
    mergeActor(actors, {
      id: actorKey('router-key', id),
      kind: 'router-key',
      label: owner ?? id,
      status: asBoolean(key.enabled) === false ? 'inactive' : 'active',
      sources: ['router'],
      identifiers: { routerClientKeyId: id, keyPrefix: asString(key.keyPrefix), owner },
      capabilities: uniqueStrings([
        ...asArray(metadata.scopes).map(asString),
        ...asArray(metadata.tags).map(asString),
      ]).sort(),
      lastActivityAt: maxIso([asString(key.lastUsedAt), ...traces.map((trace) => asString(trace.createdAt))]),
      linkedResourceCount: 1 + traces.length,
    });
  }

  for (const agent of input.memoryAgents) {
    const id = asString(agent.agent_id) ?? asString(agent.id) ?? asString(agent.name);
    if (!id) continue;
    mergeActor(actors, {
      id: actorKey('memory-agent', id),
      kind: 'memory-agent',
      label: asString(agent.display_name) ?? asString(agent.name) ?? id,
      status: asBoolean(agent.active) === false ? 'inactive' : 'active',
      sources: ['memory'],
      identifiers: { memoryAgentId: id },
      capabilities: uniqueStrings([...asArray(agent.capabilities).map(asString), ...asArray(agent.scopes).map(asString)]).sort(),
      lastActivityAt: maxIso([asString(agent.last_seen_at), asString(agent.updated_at), asString(agent.created_at)]),
      linkedResourceCount: 1,
    });
  }

  return [...actors.values()].sort((a, b) => {
    const status = Number(b.status === 'active') - Number(a.status === 'active');
    if (status !== 0) return status;
    return (b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0) - (a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0);
  });
}

function eventSeverity(service: string, outcome: string | null, statusCode?: number | null): HiveIncidentEvent['severity'] {
  if (outcome === 'DENIED' || statusCode === 401 || statusCode === 403) return 'warning';
  if (outcome?.includes('FAIL') || (typeof statusCode === 'number' && statusCode >= 500)) return 'critical';
  return service === 'iam' && outcome === 'FAILURE' ? 'critical' : 'info';
}

function eventGroupKey(event: HiveIncidentEvent): string {
  if (event.kind === 'semantic-security') {
    return `semantic:${event.title}:${event.actor ?? 'system'}`;
  }
  if (event.requestId) return `request:${event.requestId}`;
  const bucket = Math.floor(Date.parse(event.timestamp) / (5 * 60 * 1000));
  return `${event.service}:${event.kind}:${event.actor ?? 'system'}:${bucket}`;
}

function bucket15(timestamp: string | null): number {
  return Math.floor(Date.parse(timestamp ?? new Date().toISOString()) / (15 * 60 * 1000));
}

function addSemanticEvent(events: HiveIncidentEvent[], input: Omit<HiveIncidentEvent, 'id' | 'kind' | 'requestId' | 'outcome'> & { id: string; details: JsonRecord }): void {
  events.push({
    ...input,
    kind: 'semantic-security',
    requestId: null,
    outcome: null,
  });
}

function buildSemanticSecurityEvents(input: { traces: JsonRecord[]; routerAudit: JsonRecord[]; iamAudit: JsonRecord[] }): HiveIncidentEvent[] {
  const events: HiveIncidentEvent[] = [];
  const iamFailures = new Map<string, { actor: string; count: number; latest: string; hosts: Set<string>; categories: Set<string> }>();
  for (const audit of input.iamAudit) {
    const outcome = asString(audit.outcome);
    if (outcome !== 'FAILURE' && outcome !== 'DENIED') continue;
    const timestamp = asString(audit.timestamp) ?? asString(audit.createdAt) ?? new Date().toISOString();
    const actor = asString(audit.actorEmail) ?? asString(audit.actorId) ?? asString(audit.ipAddress) ?? 'unknown-actor';
    const key = `${actor}:${bucket15(timestamp)}`;
    const entry = iamFailures.get(key) ?? { actor, count: 0, latest: timestamp, hosts: new Set<string>(), categories: new Set<string>() };
    entry.count += 1;
    entry.latest = Date.parse(timestamp) > Date.parse(entry.latest) ? timestamp : entry.latest;
    const host = asString(audit.hostName) ?? asString(audit.ipAddress);
    if (host) entry.hosts.add(host);
    const category = asString(audit.category) ?? asString(audit.eventType);
    if (category) entry.categories.add(category);
    iamFailures.set(key, entry);
  }
  for (const entry of iamFailures.values()) {
    if (entry.count < 3) continue;
    addSemanticEvent(events, {
      id: `semantic-iam-failures:${entry.actor}:${bucket15(entry.latest)}`,
      service: 'iam',
      severity: entry.count >= 6 ? 'critical' : 'warning',
      timestamp: entry.latest,
      title: 'Repeated IAM authentication failures',
      actor: entry.actor,
      details: {
        reason: 'Multiple denied or failed IAM audit events for the same actor in a 15 minute window.',
        count: entry.count,
        hosts: [...entry.hosts],
        categories: [...entry.categories],
        containment: 'Review active sessions, revoke suspicious sessions or keys, and verify the source host.',
      },
    });
  }

  const deniedRoutes = new Map<string, { actor: string; count: number; latest: string; paths: Set<string> }>();
  for (const trace of input.traces) {
    const outcome = asString(trace.outcome);
    const statusCode = typeof trace.statusCode === 'number' ? trace.statusCode : null;
    if (outcome !== 'DENIED' && statusCode !== 401 && statusCode !== 403) continue;
    const timestamp = asString(trace.createdAt) ?? asString(trace.startedAt) ?? new Date().toISOString();
    const actor = asString(trace.clientApiKeyId) ?? asString(trace.providerId) ?? 'unknown-client';
    const key = `${actor}:${bucket15(timestamp)}`;
    const entry = deniedRoutes.get(key) ?? { actor, count: 0, latest: timestamp, paths: new Set<string>() };
    entry.count += 1;
    entry.latest = Date.parse(timestamp) > Date.parse(entry.latest) ? timestamp : entry.latest;
    const path = asString(trace.path) ?? asString(trace.routeKey);
    if (path) entry.paths.add(path);
    deniedRoutes.set(key, entry);
  }
  for (const entry of deniedRoutes.values()) {
    if (entry.count < 3) continue;
    addSemanticEvent(events, {
      id: `semantic-route-denials:${entry.actor}:${bucket15(entry.latest)}`,
      service: 'router',
      severity: 'warning',
      timestamp: entry.latest,
      title: 'Repeated denied model requests',
      actor: entry.actor,
      details: {
        reason: 'A client triggered repeated denied or unauthorized model routes.',
        count: entry.count,
        paths: [...entry.paths],
        containment: 'Inspect the client key owner, recent prompts, and route rules before re-enabling access.',
      },
    });
  }

  for (const audit of input.routerAudit) {
    const action = asString(audit.action) ?? '';
    const metadata = parseJson(audit.metadataJson);
    const serialized = JSON.stringify(metadata).toLowerCase();
    if (!action.includes('client-key') && !action.includes('route') && !action.includes('provider')) continue;
    if (!serialized.includes('admin') && !serialized.includes('memory:write') && !serialized.includes('local-only') && !serialized.includes('secret')) continue;
    addSemanticEvent(events, {
      id: `semantic-sensitive-change:${asString(audit.id) ?? events.length}`,
      service: 'router',
      severity: 'warning',
      timestamp: asString(audit.createdAt) ?? new Date().toISOString(),
      title: 'Sensitive routing or key change',
      actor: asString((audit.adminUser as JsonRecord | undefined)?.username) ?? asString(audit.actorType),
      details: {
        reason: 'A routing, provider, or client-key change touched sensitive scopes, local-only routing, or secret-like metadata.',
        action,
        metadata,
        containment: 'Confirm the operator intent and compare the config export before and after the change.',
      },
    });
  }

  return events;
}

export function buildIncidentTimeline(input: { traces: JsonRecord[]; routerAudit: JsonRecord[]; iamAudit: JsonRecord[] }): HiveIncident[] {
  const events: HiveIncidentEvent[] = buildSemanticSecurityEvents(input);

  for (const trace of input.traces) {
    const outcome = asString(trace.outcome);
    const statusCode = typeof trace.statusCode === 'number' ? trace.statusCode : null;
    if (outcome === 'SUCCEEDED' && (!statusCode || statusCode < 400)) continue;
    const requestId = asString(trace.requestId);
    events.push({
      id: `router-trace:${asString(trace.id) ?? requestId ?? events.length}`,
      service: 'router',
      kind: 'trace',
      severity: eventSeverity('router', outcome, statusCode),
      timestamp: asString(trace.createdAt) ?? new Date().toISOString(),
      title: `${asString(trace.method) ?? 'HTTP'} ${asString(trace.path) ?? asString(trace.routeKey) ?? 'request'}`,
      requestId,
      actor: asString(trace.clientApiKeyId),
      outcome,
      details: trace,
    });
  }

  for (const audit of input.routerAudit) {
    const metadata = parseJson(audit.metadataJson);
    const requestId = asString(metadata.requestId);
    const action = asString(audit.action) ?? 'router.audit';
    if (!requestId && !action.includes('fail') && !action.includes('deny') && !action.includes('error')) continue;
    events.push({
      id: `router-audit:${asString(audit.id) ?? events.length}`,
      service: 'router',
      kind: 'audit',
      severity: action.includes('deny') ? 'warning' : action.includes('fail') || action.includes('error') ? 'critical' : 'info',
      timestamp: asString(audit.createdAt) ?? new Date().toISOString(),
      title: action,
      requestId,
      actor: asString((audit.adminUser as JsonRecord | undefined)?.username) ?? asString(audit.actorType),
      outcome: null,
      details: audit,
    });
  }

  for (const audit of input.iamAudit) {
    const detail = parseJson(audit.detail);
    const outcome = asString(audit.outcome);
    if (outcome === 'SUCCESS' && !asString(detail.requestId)) continue;
    events.push({
      id: `iam-audit:${asString(audit.id) ?? events.length}`,
      service: 'iam',
      kind: 'audit',
      severity: eventSeverity('iam', outcome),
      timestamp: asString(audit.timestamp) ?? asString(audit.createdAt) ?? new Date().toISOString(),
      title: asString(audit.eventType) ?? asString(audit.action) ?? 'iam.audit',
      requestId: asString(detail.requestId),
      actor: asString(audit.actorEmail) ?? asString(audit.actorType),
      outcome,
      details: audit,
    });
  }

  const groups = new Map<string, HiveIncidentEvent[]>();
  for (const event of events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))) {
    const key = eventGroupKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const sorted = group.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const severity: HiveIncident['severity'] = sorted.some((event) => event.severity === 'critical') ? 'critical' : sorted.some((event) => event.severity === 'warning') ? 'warning' : 'info';
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      id: key,
      severity,
      status: severity === 'info' ? 'resolved' as const : 'open' as const,
      title: first?.requestId ? `Request ${first.requestId}` : first?.title ?? 'Incident',
      summary: sorted.map((event) => `${event.service}:${event.title}`).join(' -> '),
      startedAt: first?.timestamp ?? new Date().toISOString(),
      endedAt: last?.timestamp ?? first?.timestamp ?? new Date().toISOString(),
      requestIds: uniqueStrings(sorted.map((event) => event.requestId)),
      services: uniqueStrings(sorted.map((event) => event.service)).sort(),
      actors: uniqueStrings(sorted.map((event) => event.actor)).sort(),
      events: sorted,
    };
  }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
