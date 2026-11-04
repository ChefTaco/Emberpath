import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapServiceHealthState, parseServiceHealthPayload, requestServiceHealth } from '../../src/status/service-health.js';

let server: ReturnType<typeof createServer> | null = null;
let baseUrl = '';

describe('status/service-health', () => {
  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url === '/healthy') {
        expect(request.headers['x-hive-request-id']).toBe('req_status_1');
        expect(request.headers['x-request-id']).toBe('req_status_1');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          status: 'ok',
          checks: [
            { name: 'redis', status: 'pass', message: 'ready', latencyMs: 4 },
            { name: 7, status: null, ignored: true },
          ],
          version: 'fixture',
        }));
        return;
      }
      if (request.url === '/broken') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'degraded', checks: [{ name: 'redis', status: 'fail' }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not json');
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  it('parses health payloads into normalized checks while preserving raw details', () => {
    const payload = parseServiceHealthPayload(JSON.stringify({
      status: 'ok',
      checks: [{ name: 'qdrant', status: 'pass', message: 'ready', latencyMs: 12 }],
      queueDepth: 3,
    }));

    expect(payload).toEqual({
      status: 'ok',
      checks: [{ name: 'qdrant', status: 'pass', message: 'ready', latencyMs: 12 }],
      raw: { status: 'ok', checks: [{ name: 'qdrant', status: 'pass', message: 'ready', latencyMs: 12 }], queueDepth: 3 },
    });
  });

  it('maps service health states from typed payloads', () => {
    expect(mapServiceHealthState(true, { status: 'ok', checks: [], raw: {} })).toBe('online');
    expect(mapServiceHealthState(true, { status: 'degraded', checks: [], raw: {} })).toBe('degraded');
    expect(mapServiceHealthState(false, null)).toBe('offline');
  });

  it('requests service health over HTTP and normalizes invalid check fields', async () => {
    const result = await requestServiceHealth(`${baseUrl}/healthy`, false, 'req_status_1');

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.payload?.status).toBe('ok');
    expect(result.payload?.checks).toEqual([
      { name: 'redis', status: 'pass', message: 'ready', latencyMs: 4 },
      { name: 'check', status: 'unknown' },
    ]);
    expect(result.payload?.raw.version).toBe('fixture');
  });

  it('returns an HTTP failure with a typed degraded payload', async () => {
    const result = await requestServiceHealth(`${baseUrl}/broken`, false);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.payload?.status).toBe('degraded');
    expect(mapServiceHealthState(result.ok, result.payload)).toBe('degraded');
  });

  it('treats non-JSON payloads as missing details', async () => {
    const result = await requestServiceHealth(`${baseUrl}/plain`, false);

    expect(result.ok).toBe(true);
    expect(result.payload).toBeNull();
    expect(mapServiceHealthState(result.ok, result.payload)).toBe('online');
  });
});
