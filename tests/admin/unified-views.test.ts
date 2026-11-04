import { describe, expect, it } from 'vitest';
import { buildHiveActors, buildIncidentTimeline } from '../../src/admin/unified-views.js';

describe('unified Hive views', () => {
  it('builds a shared actor inventory from IAM, Router, and Memory records', () => {
    const actors = buildHiveActors({
      iamUsers: [{
        id: 'user-1',
        username: 'admin',
        displayName: 'Example Operator',
        active: true,
        roles: [{ role: { name: 'admin' } }],
        lastLoginAt: '2026-07-06T10:00:00.000Z',
      }],
      iamServiceAccounts: [{
        id: 'sa-1',
        name: 'memory-host-hermes',
        active: true,
        roles: [{ role: { name: 'memory-reader' } }],
        lastUsedAt: '2026-07-06T11:00:00.000Z',
      }],
      iamSystemUsers: [{
        id: 'sys-1',
        userId: 'user-1',
        linuxUsername: 'admin',
        sudoEnabled: true,
        createdAt: '2026-07-06T09:00:00.000Z',
      }],
      routerClientKeys: [{
        id: 'key-1',
        name: 'memory-host gateway',
        keyPrefix: 'sk-live',
        enabled: true,
        metadataJson: '{"owner":"memory-host","scopes":["chat:write"],"tags":["agent"]}',
      }],
      memoryAgents: [{
        agent_id: 'service:hermes-agent:memory-host',
        name: 'Hermes memory-host',
        active: true,
        scopes: ['memory:read'],
        last_seen_at: '2026-07-06T12:00:00.000Z',
      }],
      traces: [{
        id: 'trace-1',
        clientApiKeyId: 'key-1',
        createdAt: '2026-07-06T12:30:00.000Z',
      }],
    });

    expect(actors).toHaveLength(5);
    expect(actors[0]?.label).toBe('memory-host');
    expect(actors.find((actor) => actor.kind === 'router-key')?.linkedResourceCount).toBe(2);
    expect(actors.find((actor) => actor.kind === 'system-user')?.capabilities).toEqual(['sudo']);
  });

  it('groups Router traces and IAM audit events by propagated request ID', () => {
    const incidents = buildIncidentTimeline({
      traces: [{
        id: 'trace-1',
        requestId: 'req-abc',
        method: 'POST',
        path: '/v1/chat/completions',
        outcome: 'FAILED',
        statusCode: 502,
        createdAt: '2026-07-06T12:00:00.000Z',
        clientApiKeyId: 'key-1',
      }],
      routerAudit: [],
      iamAudit: [{
        id: 'iam-1',
        eventType: 'auth.denied',
        outcome: 'DENIED',
        actorEmail: 'operator@example.test',
        timestamp: '2026-07-06T12:00:02.000Z',
        detail: { requestId: 'req-abc' },
      }],
    });

    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.requestIds).toEqual(['req-abc']);
    expect(incidents[0]?.services).toEqual(['iam', 'router']);
    expect(incidents[0]?.severity).toBe('critical');
    expect(incidents[0]?.events).toHaveLength(2);
  });

  it('creates semantic security incidents for repeated IAM failures', () => {
    const incidents = buildIncidentTimeline({
      traces: [],
      routerAudit: [],
      iamAudit: Array.from({ length: 4 }, (_, index) => ({
        id: `iam-fail-${index}`,
        eventType: 'auth.login',
        category: 'AUTHENTICATION',
        outcome: 'FAILURE',
        actorEmail: 'operator@example.test',
        ipAddress: '100.64.0.7',
        timestamp: `2026-07-06T12:0${index}:00.000Z`,
        detail: {},
      })),
    });

    const semantic = incidents.find((incident) => incident.title === 'Repeated IAM authentication failures');
    expect(semantic?.severity).toBe('warning');
    expect(semantic?.actors).toEqual(['operator@example.test']);
    expect(semantic?.events[0]?.details.count).toBe(4);
  });

  it('flags sensitive routing and client-key changes as semantic incidents', () => {
    const incidents = buildIncidentTimeline({
      traces: [],
      routerAudit: [{
        id: 'audit-sensitive-1',
        action: 'client-key.update',
        actorType: 'admin-user',
        adminUser: { username: 'admin' },
        metadataJson: JSON.stringify({ scopes: ['memory:write', 'admin'] }),
        createdAt: '2026-07-06T12:00:00.000Z',
      }],
      iamAudit: [],
    });

    const semantic = incidents.find((incident) => incident.title === 'Sensitive routing or key change');
    expect(semantic?.severity).toBe('warning');
    expect(semantic?.actors).toEqual(['admin']);
    expect(semantic?.events[0]?.details.reason).toContain('sensitive scopes');
  });
});
