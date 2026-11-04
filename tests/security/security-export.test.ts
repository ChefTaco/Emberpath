import { describe, expect, it } from 'vitest';
import {
  mapSecurityExportEvent,
  sanitizeSecurityExportMetadata,
  securityExportWhere,
} from '../../src/security/security-export.js';

describe('Security exporter audit export policy', () => {
  it('applies export eligibility in the database query before pagination', () => {
    expect(securityExportWhere('cursor-10')).toEqual({
      action: {
        in: expect.arrayContaining(['auth.login', 'provider.update', 'client-key.rotate']),
      },
      id: { gt: 'cursor-10' },
    });
  });

  it('retains only scalar properties allowlisted for the exact action family', () => {
    expect(sanitizeSecurityExportMetadata('provider.update', JSON.stringify({
      slug: 'local-provider',
      kind: 'OLLAMA',
      value: 'secret',
      details: { email: 'person@example.com' },
      request: { authorization: 'Bearer token' },
      command: 'delete everything',
      metadata: { password: 'hunter2' },
    }))).toEqual({
      slug: 'local-provider',
      kind: 'OLLAMA',
    });
  });

  it.each(['value', 'details', 'request', 'command', 'metadata'])(
    'redacts generic secret-bearing %s metadata from actions with no allowlist',
    (key) => {
      expect(sanitizeSecurityExportMetadata(
        'client-key.rotate',
        JSON.stringify({ [key]: 'personal-or-secret-data' }),
      )).toBeNull();
    },
  );

  it('maps events only after sanitizing their metadata', () => {
    expect(mapSecurityExportEvent({
      id: 'event-1',
      actorType: 'admin-user',
      adminUserId: null,
      action: 'hive-actor.rotate',
      entityType: 'hive-actor',
      entityId: 'actor-1',
      metadataJson: JSON.stringify({
        identifiers: { user: 'person@example.com' },
        steps: [{ body: { apiKey: 'secret' } }],
      }),
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
    })).toMatchObject({
      id: 'event-1',
      action: 'hive-actor.rotate',
      metadata: null,
    });
  });
});
