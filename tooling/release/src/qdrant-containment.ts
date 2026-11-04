import { hash } from './files.js';
import { qdrantRequest, type StoreSpec } from './backup.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function memoryCollection(name: string): boolean {
  return /^(shared_|.*_private_)(episodic|semantic|procedural)$/.test(name);
}
export async function qdrantContainment(
  config: NonNullable<StoreSpec['qdrant']>,
  collection: string,
): Promise<Record<string, string> | undefined> {
  const memory = memoryCollection(collection);
  if (!memory && !['_agents', '_workspaces', '_webhooks'].includes(collection)) return;
  const values: Record<string, string> = {};
  let offset: unknown;
  do {
    const response = (await (
      await qdrantRequest(
        config,
        `/collections/${encodeURIComponent(collection)}/points/scroll`,
        'POST',
        JSON.stringify({
          limit: 256,
          with_payload: memory
            ? ['id', 'deleted_at']
            : collection === '_agents'
              ? ['agent_id', 'active', 'metadata']
              : true,
          with_vector: false,
          ...(offset !== undefined ? { offset } : {}),
        }),
        'application/json',
      )
    ).json()) as {
      result: { points: { id: unknown; payload?: unknown }[]; next_page_offset?: unknown };
    };
    for (const point of response.result.points)
      values[String(point.id)] = hash(canonical(point.payload));
    offset = response.result.next_page_offset ?? undefined;
  } while (offset !== undefined);
  return values;
}
export function assertQdrantContainment(
  collection: string,
  saved: Record<string, string>,
  current: Record<string, string>,
): void {
  if (
    Object.entries(saved).some(([id, value]) => current[id] !== value) ||
    (!memoryCollection(collection) && Object.keys(current).some((id) => !(id in saved)))
  )
    throw new Error(
      'HiveMem containment changed; reconcile newer disabled agents, credential generations, workspace policy and forgotten content before restoring',
    );
}
