import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/main.js';
import { startServer } from '../../src/server.js';
import { prisma } from '../../src/storage/client.js';
import { loadEnv } from '../../src/config/env.js';

vi.mock('../../src/server.js', () => ({ startServer: vi.fn() }));
vi.mock('../../src/config/env.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/config/env.js')>(),
  loadEnv: vi.fn(),
}));
vi.mock('../../src/upgrade.js', () => ({ routerMigration: vi.fn() }));
vi.mock('../../src/storage/bootstrap.js', () => ({ bootstrapStorage: vi.fn() }));
vi.mock('../../src/storage/client.js', () => ({
  prisma: { $connect: vi.fn(), $disconnect: vi.fn(), clientApiKey: { create: vi.fn() } },
}));

const fixture = 'fixture-private-value';

describe('CLI log privacy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reports unexpected startup failures without the exception or its stack even in debug mode', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    vi.mocked(startServer).mockRejectedValue(new Error(fixture));
    expect(await main(['start'])).toBe(1);
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['hive-router: failed to start. Run "hive-router check" to diagnose the configuration.'],
    ]);
  });

  it('reports invalid environment settings without their value', async () => {
    const { parseEnv } = await import('../../src/config/env.js');
    vi.mocked(startServer).mockImplementation(async () => {
      parseEnv({ HIVE_ROUTER_SECRET: 'fixture-router-secret-0123456789abcdef', ADMIN_PORT: fixture });
    });
    expect(await main(['start'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ADMIN_PORT must be a TCP port'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(fixture);
  });

  it('keeps invalid JSON out of create-key diagnostics', async () => {
    vi.stubEnv('HIVE_ROUTER_CLI_TOKEN', '');
    expect(await main(['create-key', '--name', 'fixture', '--metadata', fixture])).toBe(1);
    expect(vi.mocked(console.error).mock.calls).toEqual([['Error: Metadata must be valid JSON']]);
    expect(prisma.clientApiKey.create).not.toHaveBeenCalled();
  });

  it('keeps bootstrap exceptions out of create-key diagnostics', async () => {
    vi.mocked(loadEnv).mockImplementation(() => { throw new Error(fixture); });
    expect(await main(['create-key', '--name', 'fixture'])).toBe(1);
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['Error: Failed to create key. Check the router configuration and database.'],
    ]);
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });
});
