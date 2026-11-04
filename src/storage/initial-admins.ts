import { z } from 'zod';
const definition = z
  .object({
    username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/),
    localId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();
export function initialAdminIdentities(
  raw: string,
  allowed: readonly string[],
): Map<string, string> {
  const definitions = z.array(definition).max(100).parse(JSON.parse(raw));
  if (
    new Set(definitions.map((item) => item.username)).size !==
      definitions.length ||
    new Set(definitions.map((item) => item.localId)).size !== definitions.length
  )
    throw new Error('Duplicate initial model account identity');
  for (const item of definitions)
    if (!allowed.includes(item.username))
      throw new Error(
        'Initial model account is outside the configured administrator allowlist',
      );
  return new Map(definitions.map((item) => [item.username, item.localId]));
}
