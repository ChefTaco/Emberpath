import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import type { Env } from '../config/env.js';

type IamTlsEnv = Pick<
  Env,
  'NODE_ENV' | 'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS' | 'HIVE_ROUTER_IAM_CA_CERT_PATH'
>;

type HiveMemTlsEnv = Pick<
  Env,
  'NODE_ENV' | 'HIVE_STATUS_ALLOW_INSECURE_TLS' | 'HIVEMEM_CA_CERT_PATH'
>;

const caCache = new Map<string, Buffer>();

function readPinnedCa(path: string): Buffer {
  const cached = caCache.get(path);
  if (cached) return cached;
  const ca = readFileSync(path);
  caCache.set(path, ca);
  return ca;
}

export function iamTlsOptions(url: URL, env: IamTlsEnv): ConnectionOptions {
  if (url.protocol !== 'https:') return {};
  if (env.HIVE_ROUTER_IAM_CA_CERT_PATH) {
    return {
      rejectUnauthorized: true,
      ca: readPinnedCa(env.HIVE_ROUTER_IAM_CA_CERT_PATH),
    };
  }
  if (env.HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS) {
    throw new Error(
      'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS is unsupported; use HIVE_ROUTER_IAM_CA_CERT_PATH to trust the IAM certificate',
    );
  }
  return { rejectUnauthorized: true };
}

export function hiveMemTlsOptions(url: URL, env: HiveMemTlsEnv): ConnectionOptions {
  if (url.protocol !== 'https:') return {};
  if (env.HIVEMEM_CA_CERT_PATH) {
    return {
      rejectUnauthorized: true,
      ca: readPinnedCa(env.HIVEMEM_CA_CERT_PATH),
    };
  }
  if (env.HIVE_STATUS_ALLOW_INSECURE_TLS) {
    throw new Error('HIVE_STATUS_ALLOW_INSECURE_TLS is unsupported; use HIVEMEM_CA_CERT_PATH to trust the HiveMem certificate');
  }
  return { rejectUnauthorized: true };
}
