import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { loadEnv } from '../config/env.js';

const gzipAsync = promisify(gzip);

export interface StoredBodyHandle {
  path: string;
  sizeBytes: number;
  contentType: string;
  truncated: boolean;
}

function truncateBody(body: string, maxBytes: number): { body: string; truncated: boolean } {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes <= maxBytes) {
    return { body, truncated: false };
  }

  const truncated = Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8');
  return {
    body: `${truncated}\n\n[truncated by hive-router at ${maxBytes} bytes]`,
    truncated: true,
  };
}

export async function storeBody(
  traceId: string,
  kind: 'request' | 'response' | 'reasoning',
  contentType: string,
  body: string,
): Promise<StoredBodyHandle> {
  const env = loadEnv();
  const filePath = join(env.TRACE_DIR, traceId, `${kind}.txt.gz`);
  await mkdir(dirname(filePath), { recursive: true });
  await chmod(dirname(filePath), 0o700);
  const limited = truncateBody(body, env.MAX_TRACE_BODY_BYTES);
  const payload = await gzipAsync(limited.body);
  await writeFile(filePath, payload, { mode: 0o600 });
  return {
    path: filePath,
    sizeBytes: payload.byteLength,
    contentType,
    truncated: limited.truncated,
  };
}
