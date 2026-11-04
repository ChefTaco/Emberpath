import { z } from 'zod';

const link = z
  .object({
    issuer: z.url(),
    subject: z.string().min(1).max(256),
    localId: z.string().min(1).max(256),
  })
  .strict();
export function parseAccountLinks(raw: string) {
  const links = z.array(link).max(10000).parse(JSON.parse(raw));
  const seen = new Set<string>();
  for (const item of links) {
    const key = JSON.stringify([item.issuer, item.subject]);
    if (seen.has(key)) throw new Error('Duplicate issuer/subject account link');
    seen.add(key);
  }
  return links;
}
export type AccountLink = z.infer<typeof link>;
export function linkedLocalId(
  links: readonly AccountLink[],
  identity: { issuer: string; subject: string },
): string {
  const matches = links.filter(
    (link) =>
      link.issuer === identity.issuer && link.subject === identity.subject,
  );
  if (matches.length !== 1)
    throw new Error('An explicit product account link is required');
  return matches[0]!.localId;
}
