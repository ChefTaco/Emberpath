/** Persist outcomes, never the one-time credential responses from actor operations. */
export function sanitizeAuditMetadata(action: string, metadata: unknown): unknown {
  if (!action.startsWith('hive-actor.') || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const source = metadata as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['displayName', 'iamServiceAccountId', 'routerClientKeyId', 'memoryAgentStatus', 'operationId']) {
    if (typeof source[key] === 'string' || typeof source[key] === 'number') result[key] = source[key];
  }
  if (source.identifiers && typeof source.identifiers === 'object') {
    const identifiers = source.identifiers as Record<string, unknown>;
    result.identifiers = Object.fromEntries(['iamUserId', 'iamServiceAccountId', 'routerClientKeyId', 'memoryAgentId']
      .filter((key) => typeof identifiers[key] === 'string').map((key) => [key, identifiers[key]]));
  }
  if (Array.isArray(source.steps)) result.steps = source.steps.map((value: unknown) => {
    if (!value || typeof value !== 'object') return {};
    const step = value as Record<string, unknown>;
    return Object.fromEntries(['service', 'action', 'status', 'ok'].filter((key) => ['string', 'number', 'boolean'].includes(typeof step[key])).map((key) => [key, step[key]]));
  });
  return result;
}
