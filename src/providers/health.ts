import { getProviderAdapter, listProviderRuntimes, updateProviderHealth } from './index.js';
import { providerHealthGauge } from '../telemetry/metrics.js';

export async function runProviderHealthSweep(): Promise<Array<{ providerId: string; healthy: boolean; error?: string | undefined }>> {
  const providers = await listProviderRuntimes();
  const results = await Promise.all(
    providers.map(async (provider) => {
      const adapter = getProviderAdapter(provider.kind);
      const health = await adapter.healthCheck(provider);
      providerHealthGauge.set(
        {
          provider: provider.slug,
          kind: provider.kind,
        },
        health.healthy ? 1 : 0,
      );
      await updateProviderHealth(provider.provider, health);
      return {
        providerId: provider.id,
        healthy: health.healthy,
        error: health.error,
      };
    }),
  );

  return results;
}
