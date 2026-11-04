import { expect, it } from 'vitest';
import { observeStream } from '../../src/api/observed-stream.js';

it('bounds capture without truncating the delivered stream', async () => {
  const source = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 100; i++) controller.enqueue(new Uint8Array(1024)); controller.close(); } });
  const observed = observeStream(source, 2048);
  expect((await new Response(observed.stream).arrayBuffer()).byteLength).toBe(102400);
  expect(await observed.completed).toMatchObject({ bytesReceived: 102400, truncated: true, errored: false });
  expect((await observed.completed).text.length).toBe(2048);
});

it('cancels upstream when the consumer disconnects', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([65])); }, cancel() { cancelled = true; } });
  const observed = observeStream(source, 1024);
  const reader = observed.stream.getReader(); await reader.read(); await reader.cancel();
  expect(cancelled).toBe(true);
  expect((await observed.completed).errored).toBe(true);
});
