import { describe, expect, it } from 'vitest';
import { clientKeySchema, clientKeyUpdateSchema } from '../../src/contracts/model-admin.js';
import { shouldCaptureTraceBodies } from '../../src/telemetry/tracing.js';

describe('per-key trace privacy', () => {
  it('accepts the privacy choice through public create and update validators', () => {
    const metadata = { tracePrivacy: 'metadata-only' as const, owner: 'synthetic-owner' };
    const created = clientKeySchema.parse({ name: 'Synthetic client', metadata });
    expect(shouldCaptureTraceBodies(JSON.stringify(created.metadata))).toBe(false);
    expect(clientKeyUpdateSchema.parse({ metadata }).metadata).toEqual(metadata);
    expect(clientKeySchema.safeParse({ name: 'Synthetic client', metadata: { tracePrivacy: 'unknown' } }).success).toBe(false);
    expect(clientKeySchema.safeParse({ name: 'Synthetic client', metadata: { arbitrary: true } }).success).toBe(false);
  });
  it('uses metadata-only only when the actor key explicitly selects it', () => {
    expect(shouldCaptureTraceBodies('{"tracePrivacy":"metadata-only"}')).toBe(false);
    expect(shouldCaptureTraceBodies('{"tracePrivacy":"full"}')).toBe(true);
    expect(shouldCaptureTraceBodies('{}')).toBe(true);
    expect(shouldCaptureTraceBodies('invalid')).toBe(true);
    expect(shouldCaptureTraceBodies(null)).toBe(true);
  });
});
