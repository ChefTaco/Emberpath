import { ProviderKind } from '../generated/prisma/client.js';
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

    if (existing) {
      await prisma.apiDocEntry.update({
        where: { id: existing.id },
        data: {
          implemented: entry.implemented,
          title: entry.title,
          summary: entry.summary,
          rationale: entry.rationale ?? null,
          docJson: JSON.stringify(entry),
        },
      });
      continue;
    }

    await prisma.apiDocEntry.create({
      data: {
        route: entry.route,
        method: entry.method,
        scope: entry.scope,
        title: entry.title,
        summary: entry.summary,
        rationale: entry.rationale ?? null,
        implemented: entry.implemented,
        docJson: JSON.stringify(entry),
      },
    });
  }

  await prisma.runtimeSetting.upsert({
    where: { key: 'openapi.document' },
    update: { valueJson: JSON.stringify(buildRouterOpenApiDocument(adminBaseUrl)) },
    create: { key: 'openapi.document', valueJson: JSON.stringify(buildRouterOpenApiDocument(adminBaseUrl)) },
  });
}
