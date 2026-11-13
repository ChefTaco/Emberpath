import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface TraceRow {
  id: string;
  requestId: string;
  createdAt: Date;
  requestBodyPath: string | null;
  responseBodyPath: string | null;
  reasoningBodyPath: string | null;
}

const { state, deleteManyMock, receiptMock, lifecycleReceiptMock } = vi.hoisted(() => ({
  state: { root: '', traceDir: '', traces: [] as TraceRow[] },
  deleteManyMock: vi.fn(),
  receiptMock: vi.fn(),
  lifecycleReceiptMock: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({ DEFAULT_TRACE_RETENTION_DAYS: 7, TRACE_DIR: state.traceDir }),
}));

type TraceWhere = { createdAt?: { lt: Date }; OR?: [{ id: { in: string[] } }, { requestId: { in: string[] } }] };

vi.mock('../../src/storage/client.js', () => ({
  prisma: {
    actorEnrollment: { updateMany: receiptMock },
    $executeRaw: lifecycleReceiptMock,
    trace: {
      findMany: async ({ where, take }: { where: TraceWhere; take?: number }) => {
        const createdBefore = where.createdAt?.lt;
        const names = where.OR ? new Set([...where.OR[0].id.in, ...where.OR[1].requestId.in]) : undefined;
        const rows = state.traces
          .filter((trace) => !createdBefore || trace.createdAt < createdBefore)
          .filter((trace) => !names || names.has(trace.id) || names.has(trace.requestId))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
        return take === undefined ? rows : rows.slice(0, take);
      },
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        deleteManyMock(args);
        const ids = new Set(args.where.id.in);
        state.traces = state.traces.filter((trace) => !ids.has(trace.id));
        return { count: ids.size };
      },
    },
  },
}));

import { pruneExpiredTraces } from '../../src/telemetry/retention.js';

const now = new Date('2026-07-09T12:00:00.000Z');
const expiredAt = new Date('2026-07-01T00:00:00.000Z');
const recentAt = new Date('2026-07-08T00:00:00.000Z');

function bodyDir(name: string, modifiedAt: Date): string {
  const directory = join(state.traceDir, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'body.txt.gz'), 'synthetic');
  utimesSync(directory, modifiedAt, modifiedAt);
  return directory;
}

/** A trace as the API plane stores it: request body under the request ID, the rest under the trace ID. */
function trace(id: string, createdAt: Date): TraceRow {
  const requestId = `request-${id}`;
  return {
    id,
    requestId,
    createdAt,
    requestBodyPath: join(bodyDir(requestId, createdAt), 'request.txt.gz'),
    responseBodyPath: join(bodyDir(id, createdAt), 'response.txt.gz'),
    reasoningBodyPath: null,
  };
}

describe('trace retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (state.root) rmSync(state.root, { recursive: true, force: true });
    state.root = mkdtempSync(join(tmpdir(), 'emberpath-retention-'));
    state.traceDir = join(state.root, 'traces');
    mkdirSync(state.traceDir);
    state.traces = [];
  });
  afterAll(() => rmSync(state.root, { recursive: true, force: true }));

  it('removes expired rows with every stored body and clears expired receipts', async () => {
    state.traces = [trace('expired-a', expiredAt), trace('expired-b', expiredAt), trace('live', recentAt)];

    await expect(pruneExpiredTraces(now)).resolves.toBe(2);

    expect(receiptMock).toHaveBeenCalledWith({ where: { receiptExpiresAt: { lt: now }, encryptedSecrets: { not: null } }, data: { encryptedSecrets: null, receiptExpiresAt: null } });
    expect(lifecycleReceiptMock.mock.calls[0]?.[1]).toBe(now.getTime());
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ['expired-a', 'expired-b'] } } });
    for (const name of ['expired-a', 'expired-b']) {
      expect(existsSync(join(state.traceDir, name))).toBe(false);
      // The request body is filed under the request ID, not the trace ID.
      expect(existsSync(join(state.traceDir, `request-${name}`))).toBe(false);
    }
    expect(existsSync(join(state.traceDir, 'live'))).toBe(true);
    expect(existsSync(join(state.traceDir, 'request-live'))).toBe(true);
    expect(state.traces.map((row) => row.id)).toEqual(['live']);
  });

  it('never removes a stored path outside the trace directory', async () => {
    const outside = join(state.root, 'elsewhere');
    mkdirSync(outside);
    writeFileSync(join(outside, 'request.txt.gz'), 'synthetic');
    state.traces = [{ ...trace('expired', expiredAt), requestBodyPath: join(outside, 'request.txt.gz'), reasoningBodyPath: join(state.traceDir, 'request.txt.gz') }];

    await expect(pruneExpiredTraces(now)).resolves.toBe(1);

    expect(existsSync(join(outside, 'request.txt.gz'))).toBe(true);
    expect(existsSync(state.traceDir)).toBe(true);
  });

  it('removes body directories an earlier release orphaned, once they are past retention', async () => {
    state.traces = [trace('live', recentAt)];
    bodyDir('orphaned-request-id', expiredAt);
    bodyDir('recent-unreferenced', recentAt);
    // A live trace keeps its bodies however old the directory looks.
    utimesSync(join(state.traceDir, 'request-live'), expiredAt, expiredAt);

    await expect(pruneExpiredTraces(now)).resolves.toBe(0);

    expect(existsSync(join(state.traceDir, 'orphaned-request-id'))).toBe(false);
    expect(existsSync(join(state.traceDir, 'recent-unreferenced'))).toBe(true);
    expect(existsSync(join(state.traceDir, 'request-live'))).toBe(true);
    expect(existsSync(join(state.traceDir, 'live'))).toBe(true);
  });

  it('prunes a large backlog in bounded batches', async () => {
    state.traces = Array.from({ length: 1201 }, (_, index) => ({
      id: `expired-${index}`, requestId: `request-${index}`, createdAt: new Date(expiredAt.getTime() + index),
      requestBodyPath: null, responseBodyPath: null, reasoningBodyPath: null,
    }));

    await expect(pruneExpiredTraces(now)).resolves.toBe(1201);

    expect(deleteManyMock).toHaveBeenCalledTimes(3);
    for (const [args] of deleteManyMock.mock.calls) expect(args.where.id.in.length).toBeLessThanOrEqual(500);
    expect(state.traces).toEqual([]);
  });
});
