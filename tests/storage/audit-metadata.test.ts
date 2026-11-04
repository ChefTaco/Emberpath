import { describe, expect, it } from 'vitest';
import { sanitizeAuditMetadata } from '../../src/storage/audit-metadata.js';

describe('actor audit privacy', () => {
  it('retains outcomes but drops nested one-time credentials and unknown fields', () => {
    const value = sanitizeAuditMetadata('hive-actor.rotate', {
      identifiers: { memoryAgentId: 'agent', token: 'sentinel-token' },
      secrets: { apiKey: 'sentinel-key' },
      steps: [{ service: 'iam', action: 'rotate', status: 200, ok: true, body: { apiKey: 'sentinel-key' } },
        { service: 'memory', status: 201, body: { token: 'sentinel-token', access_token: 'sentinel-token' } }],
    });
    expect(JSON.stringify(value)).not.toContain('sentinel');
    expect(value).toMatchObject({ identifiers: { memoryAgentId: 'agent' }, steps: [{ service: 'iam', status: 200 }, { service: 'memory', status: 201 }] });
  });
});
