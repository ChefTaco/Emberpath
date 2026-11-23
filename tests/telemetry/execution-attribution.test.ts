import { describe, expect, it } from 'vitest';
import { encodeExecutionHeader } from '@hivemagnus/hive-common/execution';
import { attemptDeadline, readInboundAttribution, storedExecution } from '../../src/telemetry/execution-attribution.js';
import { deriveTraceAttempts, traceExecution } from '../../src/telemetry/trace-attempts.js';

const root = 'hx1:studio:lab:request:r1';

describe('inbound execution attribution', () => {
  it('reads a valid context, request id and traceparent and ignores malformed values', () => {
    const header = encodeExecutionHeader({ v: 1, root, self: 'hx1:ardent:n1.agent-a:attempt:t/1/1' })!;
    expect(readInboundAttribution({ 'x-hive-execution': header, 'x-request-id': 'client-1', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' })).toEqual({
      execution: { v: 1, root, self: 'hx1:ardent:n1.agent-a:attempt:t/1/1' },
      clientRequestId: 'client-1',
      inboundTraceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    const unknownVersion = Buffer.from(JSON.stringify({ v: 2, root })).toString('base64url');
    expect(readInboundAttribution({ 'x-hive-execution': unknownVersion, 'x-request-id': 'bad id', traceparent: 'nope' })).toEqual({ executionIgnored: true });
    expect(readInboundAttribution({ 'x-hive-execution': 'a'.repeat(4096) })).toEqual({ executionIgnored: true });
    expect(readInboundAttribution({})).toEqual({});
  });

  it('marks an Ardent instance that is not the key actor as client-asserted', () => {
    const context = { v: 1 as const, root, self: 'hx1:ardent:node1.agent-a:attempt:t/1/1' };
    expect(storedExecution(context, 'agent-a')).toEqual(context);
    expect(storedExecution(context, 'agent-b')).toEqual({ ...context, asserted_by: 'client' });
    expect(storedExecution(context, null)).toEqual({ ...context, asserted_by: 'client' });
    expect(storedExecution({ v: 1, root, self: 'hx1:ardent:local.agent-a:task:t' }, 'agent-a')).toEqual({ v: 1, root, self: 'hx1:ardent:local.agent-a:task:t' });
    // Only Ardent instances are compared; other products are stored as sent.
    expect(storedExecution({ v: 1, root, self: 'hx1:studio:lab:node:n1' }, null)).toEqual({ v: 1, root, self: 'hx1:studio:lab:node:n1' });
  });

  it('bounds attempts by the earlier of the server budget and the execution deadline', () => {
    expect(attemptDeadline(1000, 300_000, undefined)).toBe(301_000);
    expect(attemptDeadline(1000, 300_000, { v: 1, root, deadline_ms: 5000 })).toBe(5000);
    expect(attemptDeadline(1000, 3000, { v: 1, root, deadline_ms: 50_000 })).toBe(4000);
  });
});

describe('trace attempts', () => {
  it('derives attempts from legacy events without attempt data', () => {
    const attempts = deriveTraceAttempts({ providerId: null, statusCode: 503, outcome: 'FAILED', endedAt: new Date() }, [
      { type: 'provider.skipped', message: 'skipped', dataJson: null },
      { type: 'provider.failover', message: 'Provider a returned 503', dataJson: null },
      { type: 'provider.stream_failover', message: 'stream error', dataJson: '{"phase":"pre-first-byte"}' },
      { type: 'provider.error', message: 'fetch failed', dataJson: '{"providerId":"p","attempt":1}' },
      { type: 'provider.error', message: 'Client disconnected before a provider responded', dataJson: '{"providerId":"p","attempt":2}' },
    ]);
    expect(attempts).toEqual([
      { providerId: null, attempt: null, failover: true, outcome: 'http_error' },
      { providerId: null, attempt: null, failover: true, outcome: 'stream_error' },
      { providerId: 'p', attempt: 1, failover: false, outcome: 'network_error' },
      { providerId: 'p', attempt: 2, failover: false, outcome: 'client_aborted' },
    ]);
  });

  it('adds the answering attempt, in progress until the trace is finalized', () => {
    const events = [{ type: 'provider.error', message: 'x', dataJson: '{"providerId":"p","attempt":1,"outcome":"network_error","failover":false,"delayMs":40}' }];
    expect(deriveTraceAttempts({ providerId: 'p', statusCode: null, outcome: 'SUCCEEDED', endedAt: null }, events).at(-1))
      .toEqual({ providerId: 'p', attempt: 2, failover: false, outcome: 'in_progress' });
    expect(deriveTraceAttempts({ providerId: 'p', statusCode: 400, outcome: 'FAILED', endedAt: new Date() }, events))
      .toEqual([{ providerId: 'p', attempt: 1, delayMs: 40, failover: false, outcome: 'network_error' }, { providerId: 'p', attempt: 2, status: 400, failover: false, outcome: 'failed' }]);
  });

  it('exposes stored execution columns with the parsed context', () => {
    expect(traceExecution({ executionRootRef: root, executionSelfRef: null, executionParentRef: null, clientRequestId: null, inboundTraceparent: null,
      executionJson: JSON.stringify({ v: 1, root, attempt: 2, deadline_ms: 99, asserted_by: 'client' }) })).toEqual({
      root, self: null, parent: null, clientRequestId: null, inboundTraceparent: null, attempt: 2, deadlineMs: 99, assertedBy: 'client',
      context: { v: 1, root, attempt: 2, deadline_ms: 99, asserted_by: 'client' },
    });
    expect(traceExecution({ executionRootRef: null, executionSelfRef: null, executionParentRef: null, clientRequestId: 'c', inboundTraceparent: null, executionJson: null }))
      .toMatchObject({ root: null, clientRequestId: 'c', context: null, assertedBy: null });
  });
});
