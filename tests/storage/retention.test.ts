import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock, deleteManyMock, rmMock, receiptMock, lifecycleReceiptMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  rmMock: vi.fn(),
  receiptMock: vi.fn(),
  lifecycleReceiptMock: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({ DEFAULT_TRACE_RETENTION_DAYS: 7, TRACE_DIR: '/private/traces' }),
}));

vi.mock('../../src/storage/client.js', () => ({
  prisma: { actorEnrollment: { updateMany: receiptMock }, $executeRaw: lifecycleReceiptMock, trace: { findMany: findManyMock, deleteMany: deleteManyMock } },
}));

vi.mock('node:fs/promises', () => ({ rm: rmMock }));

import { pruneExpiredTraces } from '../../src/telemetry/retention.js';

describe('trace retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([{ id: 'expired-a' }, { id: 'expired-b' }]);
    deleteManyMock.mockResolvedValue({ count: 2 });
    rmMock.mockResolvedValue(undefined);
  });

  it('removes expired body directories and their database rows using the configured cutoff', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    await expect(pruneExpiredTraces(now)).resolves.toBe(2);
    expect(receiptMock).toHaveBeenCalledWith({ where: { receiptExpiresAt: { lt: now }, encryptedSecrets: { not: null } }, data: { encryptedSecrets: null, receiptExpiresAt: null } });
    expect(lifecycleReceiptMock.mock.calls[0]?.[1]).toBe(now.getTime());
    expect(findManyMock).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-07-02T12:00:00.000Z') } },
      select: { id: true },
    });
    expect(rmMock).toHaveBeenNthCalledWith(1, '/private/traces/expired-a', { recursive: true, force: true });
    expect(rmMock).toHaveBeenNthCalledWith(2, '/private/traces/expired-b', { recursive: true, force: true });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ['expired-a', 'expired-b'] } } });
  });
});
