import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerFetch } from '../../src/providers/upstream-fetch.js';

// A real listener so the timeout acts on a real fetch body, as it does in production.
const TIMEOUT_MS = 150;
let server: Server;
let baseUrl = '';
const pending = new Set<ReturnType<typeof setTimeout>>();
const later = (ms: number, run: () => void) => { const timer = setTimeout(() => { pending.delete(timer); run(); }, ms); pending.add(timer); };

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/long-stream') {
      // Runs well past the timeout in total, but never pauses as long as the timeout.
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let sent = 0;
      const tick = () => {
        sent += 1;
        response.write(`data: ${sent}\n\n`);
        if (sent === 8) response.end();
        else later(50, tick);
      };
      tick();
    } else if (request.url === '/stall') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: 1\n\n');
      later(TIMEOUT_MS * 4, () => response.end('data: 2\n\n'));
    } else if (request.url === '/slow-headers') {
      later(TIMEOUT_MS * 4, () => response.writeHead(200).end('late'));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const timer of pending) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('providers/upstream-fetch timeouts', () => {
  it('lets a stream run longer than the timeout while chunks keep arriving', async () => {
    const startedAt = Date.now();
    const response = await providerFetch(`${baseUrl}/long-stream`, { timeoutMs: TIMEOUT_MS });
    const text = await response.text();

    expect(Date.now() - startedAt).toBeGreaterThan(TIMEOUT_MS * 2);
    expect(text.match(/data:/g)).toHaveLength(8);
  });

  it('cuts a stream that goes silent for longer than the timeout', async () => {
    const response = await providerFetch(`${baseUrl}/stall`, { timeoutMs: TIMEOUT_MS });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('fails when the response headers do not arrive in time', async () => {
    await expect(providerFetch(`${baseUrl}/slow-headers`, { timeoutMs: TIMEOUT_MS })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('still stops at once when the caller aborts', async () => {
    const caller = new AbortController();
    const response = await providerFetch(`${baseUrl}/stall`, { timeoutMs: 10_000, signal: caller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    caller.abort(new Error('client went away'));

    await expect(reader.read()).rejects.toThrow('client went away');
  });
});
