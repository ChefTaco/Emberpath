import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hiveMemTlsOptions, iamTlsOptions } from '../../src/security/iam-tls.js';

describe('IAM TLS policy', () => {
  it('loads an explicit private CA while retaining certificate verification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hive-router-iam-ca-'));
    const caPath = join(directory, 'iam-ca.crt');
    writeFileSync(caPath, 'test-private-ca');
    const options = iamTlsOptions(new URL('https://127.0.0.1:4200'), {
      NODE_ENV: 'production',
      HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: false,
      HIVE_ROUTER_IAM_CA_CERT_PATH: caPath,
    });
    expect(options.rejectUnauthorized).toBe(true);
    expect(Buffer.isBuffer(options.ca)).toBe(true);
  });

  it('loads a current-and-next PEM trust bundle without disabling verification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hive-router-iam-ca-overlap-'));
    const caPath = join(directory, 'iam-ca-bundle.crt');
    writeFileSync(caPath, 'current-private-ca\nnext-private-ca\n');
    const options = iamTlsOptions(new URL('https://iam.internal:4200'), {
      NODE_ENV: 'production',
      HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: false,
      HIVE_ROUTER_IAM_CA_CERT_PATH: caPath,
    });
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca?.toString()).toContain('current-private-ca\nnext-private-ca');
  });

  it('rejects insecure TLS in production even for loopback', () => {
    expect(() => iamTlsOptions(new URL('https://127.0.0.1:4200'), {
      NODE_ENV: 'production',
      HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: true,
      HIVE_ROUTER_IAM_CA_CERT_PATH: undefined,
    })).toThrow(/use HIVE_ROUTER_IAM_CA_CERT_PATH/u);
  });

  it('rejects insecure TLS outside loopback in development', () => {
    expect(() => iamTlsOptions(new URL('https://iam.internal:4200'), {
      NODE_ENV: 'development',
      HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: true,
      HIVE_ROUTER_IAM_CA_CERT_PATH: undefined,
    })).toThrow(/use HIVE_ROUTER_IAM_CA_CERT_PATH/u);
  });

  it('pins the HiveMem certificate and rejects the legacy production bypass', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hive-router-memory-ca-'));
    const caPath = join(directory, 'hivemem-ca.crt');
    writeFileSync(caPath, 'test-hivemem-ca');
    expect(hiveMemTlsOptions(new URL('https://hive.example.test:18443'), {
      NODE_ENV: 'production',
      HIVE_STATUS_ALLOW_INSECURE_TLS: false,
      HIVEMEM_CA_CERT_PATH: caPath,
    })).toMatchObject({ rejectUnauthorized: true });
    expect(() => hiveMemTlsOptions(new URL('https://127.0.0.1:18443'), {
      NODE_ENV: 'production',
      HIVE_STATUS_ALLOW_INSECURE_TLS: true,
      HIVEMEM_CA_CERT_PATH: undefined,
    })).toThrow(/use HIVEMEM_CA_CERT_PATH/u);
  });

  it('rejects legacy bypasses on every development loopback address', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      const url = new URL(`https://${hostname}:4200`);
      expect(() => iamTlsOptions(url, {
        NODE_ENV: 'development', HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: true,
        HIVE_ROUTER_IAM_CA_CERT_PATH: undefined,
      })).toThrow(/use HIVE_ROUTER_IAM_CA_CERT_PATH/u);
      expect(() => hiveMemTlsOptions(url, {
        NODE_ENV: 'development', HIVE_STATUS_ALLOW_INSECURE_TLS: true,
        HIVEMEM_CA_CERT_PATH: undefined,
      })).toThrow(/use HIVEMEM_CA_CERT_PATH/u);
    }
  });
});
