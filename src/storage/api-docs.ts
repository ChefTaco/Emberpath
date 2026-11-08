import { builtinApiDocs, buildRouterOpenApiDocument } from '../openapi/spec.js';
import { prisma } from './client.js';

export async function syncBuiltinApiDocs(adminBaseUrl: string): Promise<void> {
  for (const entry of builtinApiDocs) {
    const existing = await prisma.apiDocEntry.findFirst({
      where: {
        route: entry.route,
        method: entry.method,
        scope: entry.scope,
      },
    });

    const desired = {
      implemented: entry.implemented,
      title: entry.title,
      summary: entry.summary,
      rationale: entry.rationale ?? null,
      docJson: JSON.stringify(entry),
    };
    if (existing) {
      if (Object.entries(desired).every(([key,value]) => existing[key as keyof typeof desired] === value)) continue;
      await prisma.apiDocEntry.update({
        where: { id: existing.id },
        data: desired,
      });
      continue;
    }

    await prisma.apiDocEntry.create({
      data: {
        route: entry.route,
        method: entry.method,
        scope: entry.scope,
        ...desired,
      },
    });
  }

  const valueJson = JSON.stringify(buildRouterOpenApiDocument(adminBaseUrl));
  const existingDocument = await prisma.runtimeSetting.findUnique({ where: { key: 'openapi.document' } });
  if (existingDocument?.valueJson !== valueJson) await prisma.runtimeSetting.upsert({
    where: { key: 'openapi.document' }, update: { valueJson },
    create: { key: 'openapi.document', valueJson },
  });
}
