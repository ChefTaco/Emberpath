import { gunzip, inflate, zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { HTTPException } from 'hono/http-exception';

const decompressors = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  zstd: promisify(zstdDecompress),
};

/** Decode before model selection, quota accounting or forwarding rewritten JSON. */
export async function decodeInferenceBody(bytes: Uint8Array, encoding: string | undefined, maximum: number): Promise<Uint8Array> {
  if (bytes.byteLength > maximum) throw new HTTPException(413, { message: 'Request body too large' });
  const format = encoding?.trim().toLowerCase();
  if (!format || format === 'identity') return bytes;
  if (!Object.hasOwn(decompressors, format)) throw new HTTPException(415, { message: 'Unsupported request content encoding; use identity, gzip, deflate or zstd' });
  try {
    return await decompressors[format as keyof typeof decompressors](bytes, { maxOutputLength: maximum });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new HTTPException(413, { message: 'Expanded request body too large' });
    }
    throw new HTTPException(400, { message: 'Invalid compressed request body' });
  }
}
