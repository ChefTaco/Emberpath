import { prisma } from './client.js';
import { sanitizeAuditMetadata } from './audit-metadata.js';

export async function recordAuditEvent(input: {
  actorType: string;
  adminUserId?: string | undefined;
  action: string;
  entityType: string;
  entityId?: string | undefined;
  metadata?: unknown;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actorType: input.actorType,
      adminUserId: input.adminUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadataJson: input.metadata === undefined ? null : JSON.stringify(sanitizeAuditMetadata(input.action, input.metadata)),
    },
  });
}
