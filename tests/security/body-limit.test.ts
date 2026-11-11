import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { it } from 'vitest';

// Regression for GHSA-39q9-qp46-w8xg: payload bytes alone did not bound
// retained Uint8Array objects when the transport delivered one byte per chunk.
const maxSize = 4096;
function request(size: number, contentLength?: number): Request {
  let sent = 0;
  return new Request('http://example.com/upload', {
    method: 'POST',
    headers: { 'transfer-encoding': 'chunked', ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) }) },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === size) controller.close();
        else { controller.enqueue(Uint8Array.of(sent % 251)); sent++; }
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

it('bodyLimit coalesces tiny transfer chunks without changing request bytes', async () => {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize }));
  app.post('/upload', async c => {
    const reader = c.req.raw.body!.getReader();
    let chunks = 0, bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks++;
      for (const byte of next.value) assert.equal(byte, bytes++ % 251);
    }
    return c.json({ chunks, bytes });
  });
  for (const declared of [undefined, maxSize]) {
    const response = await app.fetch(request(maxSize, declared));
    assert.equal(response.status, 200);
    // A vulnerable version replays 4096 retained objects to the handler.
    assert.deepEqual(await response.json(), { chunks: 1, bytes: maxSize });
  }
});

it('bodyLimit rejects over-limit tiny chunks before invoking the handler', async () => {
  const app = new Hono();
  let invoked = false;
  app.use('*', bodyLimit({ maxSize }));
  app.post('/upload', c => { invoked = true; return c.text('unexpected'); });
  for (const declared of [undefined, maxSize, maxSize + 1]) {
    const response = await app.fetch(request(maxSize + 1, declared));
    assert.equal(response.status, 413);
    assert.equal(invoked, false);
  }
});
