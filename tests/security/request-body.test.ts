import { deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeInferenceBody } from '../../src/api/request-body.js';

const json = Buffer.from(JSON.stringify({ model: 'synthetic-alias', stream: true, input: 'Reply with OK' }));

describe('compressed inference request boundary', () => {
  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['zstd', zstdCompressSync],
  ] as const)('decodes %s before alias and stream selection', async (encoding, compress) => {
    const decoded = await decodeInferenceBody(compress(json), encoding, 1024);
    expect(JSON.parse(Buffer.from(decoded).toString())).toEqual({ model: 'synthetic-alias', stream: true, input: 'Reply with OK' });
  });
  it.each([gzipSync, deflateSync, zstdCompressSync])('bounds expanded data independently of its compressed size', async compress => {
    await expect(decodeInferenceBody(compress(Buffer.alloc(100_000)), compress === gzipSync ? 'gzip' : compress === deflateSync ? 'deflate' : 'zstd', 1024)).rejects.toMatchObject({ status: 413 });
  });
  it.each(['gzip', 'deflate', 'zstd'])('rejects malformed %s without returning its contents', async encoding => {
    await expect(decodeInferenceBody(Buffer.from('obviously-fake-private-payload'), encoding, 1024)).rejects.toMatchObject({ status: 400, message: 'Invalid compressed request body' });
  });
  it.each(['br', 'gzip, zstd', '__proto__', 'constructor'])('rejects unsupported or stacked encoding %s', async encoding => {
    await expect(decodeInferenceBody(json, encoding, 1024)).rejects.toMatchObject({ status: 415 });
  });
  it('also bounds identity requests and preserves binary payloads', async () => {
    await expect(decodeInferenceBody(json, undefined, 4)).rejects.toMatchObject({ status: 413 });
    expect(await decodeInferenceBody(json, 'identity', 1024)).toEqual(json);
  });
});
