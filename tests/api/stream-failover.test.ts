import { describe, expect, it } from 'vitest';
import {
  classifyStreamOutcome,
  looksLikeStreamError,
  peekStreamStart,
} from '../../src/api/stream-failover.js';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index] ?? ''));
      index += 1;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('api/stream-failover classifyStreamOutcome', () => {
  it('marks a clean read as complete', () => {
    expect(classifyStreamOutcome({ bytesReceived: 120, errored: false })).toEqual({
      failed: false,
      phase: 'complete',
      reachedClient: true,
      retrySafe: false,
    });
  });

  it('classifies a pre-first-byte error as retry-safe', () => {
    expect(classifyStreamOutcome({ bytesReceived: 0, errored: true })).toEqual({
      failed: true,
      phase: 'pre-first-byte',
      reachedClient: false,
      retrySafe: true,
    });
  });

  it('classifies a mid-stream error as not retry-safe', () => {
    expect(classifyStreamOutcome({ bytesReceived: 42, errored: true })).toEqual({
      failed: true,
      phase: 'mid-stream',
      reachedClient: true,
      retrySafe: false,
    });
  });
});

describe('api/stream-failover looksLikeStreamError', () => {
  it('detects an explicit SSE error event', () => {
    expect(looksLikeStreamError('event: error\ndata: {"message":"boom"}')).toBe(true);
  });

  it('detects a data payload carrying an error field', () => {
    expect(looksLikeStreamError('data: {"error":{"message":"rate limited"}}')).toBe(true);
  });

  it('does not flag a normal first chunk', () => {
    expect(looksLikeStreamError('data: {"choices":[{"delta":{"content":"Hi"}}]}')).toBe(false);
  });

  it('does not flag an error field that is falsy', () => {
    expect(looksLikeStreamError('data: {"error":null}')).toBe(false);
  });

  it('ignores empty or malformed chunks', () => {
    expect(looksLikeStreamError('')).toBe(false);
    expect(looksLikeStreamError('data: not-json')).toBe(false);
  });
});

describe('api/stream-failover peekStreamStart', () => {
  it('returns the first chunk and replays the full stream', async () => {
    const { firstChunkText, stream } = await peekStreamStart(
      streamFromChunks(['data: one\n\n', 'data: two\n\n', 'data: [DONE]\n\n']),
    );
    expect(firstChunkText).toBe('data: one\n\n');
    expect(await drain(stream)).toBe('data: one\n\ndata: two\n\ndata: [DONE]\n\n');
  });

  it('handles a single-chunk stream', async () => {
    const { firstChunkText, stream } = await peekStreamStart(streamFromChunks(['only\n\n']));
    expect(firstChunkText).toBe('only\n\n');
    expect(await drain(stream)).toBe('only\n\n');
  });

  it('handles an empty stream', async () => {
    const { firstChunkText, stream } = await peekStreamStart(streamFromChunks([]));
    expect(firstChunkText).toBe('');
    expect(await drain(stream)).toBe('');
  });
});
