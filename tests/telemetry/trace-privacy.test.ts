import { describe, expect, it } from 'vitest';
import { shouldCaptureTraceBodies } from '../../src/telemetry/tracing.js';

describe('per-key trace privacy', () => {
  it('uses metadata-only only when the actor key explicitly selects it', () => {
    expect(shouldCaptureTraceBodies('{"tracePrivacy":"metadata-only"}')).toBe(false);
    expect(shouldCaptureTraceBodies('{"tracePrivacy":"full"}')).toBe(true);
    expect(shouldCaptureTraceBodies('{}')).toBe(true);
    expect(shouldCaptureTraceBodies('invalid')).toBe(true);
    expect(shouldCaptureTraceBodies(null)).toBe(true);
  });
});
