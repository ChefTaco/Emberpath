export const SECURITY_EXPORTER_STATIC_FALLBACK_REMOVAL_AT = '2026-09-30T00:00:00.000Z';

export function assertStaticExporterFallbackAllowed(enabled: boolean, now = Date.now()): void {
  if (enabled && now >= Date.parse(SECURITY_EXPORTER_STATIC_FALLBACK_REMOVAL_AT)) {
    throw new Error(
      `HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED expired at ${SECURITY_EXPORTER_STATIC_FALLBACK_REMOVAL_AT}`,
    );
  }
}
