import { describe, expect, it } from 'vitest';
import {
  assertStaticExporterFallbackAllowed,
  SECURITY_EXPORTER_STATIC_FALLBACK_REMOVAL_AT,
} from '../../src/security/static-exporter-fallback.js';

describe('static Security exporter fallback sunset', () => {
  const removal = Date.parse(SECURITY_EXPORTER_STATIC_FALLBACK_REMOVAL_AT);

  it('allows the migration flag only before the absolute removal date', () => {
    expect(() => assertStaticExporterFallbackAllowed(true, removal - 1)).not.toThrow();
    expect(() => assertStaticExporterFallbackAllowed(true, removal)).toThrow(/expired/u);
    expect(() => assertStaticExporterFallbackAllowed(true, removal + 1)).toThrow(/expired/u);
  });

  it('never blocks startup when the fallback is disabled', () => {
    expect(() => assertStaticExporterFallbackAllowed(false, removal + 86_400_000)).not.toThrow();
  });
});
