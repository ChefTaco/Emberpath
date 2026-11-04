import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectTlsCertificate } from '../../src/status/tls-certificate.js';

let tmpRoot: string | null = null;

function tempDir(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hive-router-cert-'));
  return tmpRoot;
}

function createCertificate(commonName: string, subjectAltNames: string[], days: number): string {
  const dir = tempDir();
  const certPath = join(dir, 'server.crt');
  const keyPath = join(dir, 'server.key');
  const configPath = join(dir, 'openssl.cnf');
  writeFileSync(configPath, `
[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt=no

[req_distinguished_name]
CN=${commonName}

[v3_req]
subjectAltName=${subjectAltNames.map((entry) => `DNS:${entry}`).join(',')}
`);

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    String(days),
    '-config',
    configPath,
  ], { stdio: 'ignore' });
  return certPath;
}

describe('status/tls-certificate', () => {
  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it('reports matching host, issuer, domains, and expiry window', () => {
    const certPath = createCertificate('hive.example.com', ['hive.example.com', 'hive'], 60);
    const status = inspectTlsCertificate({ certPath, publicUrl: 'https://hive.example.com' });

    expect(status.status).toBe('pass');
    expect(status.hostnameMatched).toBe(true);
    expect(status.domains).toContain('hive.example.com');
    expect(status.issuer).toContain('hive.example.com');
    expect(status.daysRemaining).toBeGreaterThan(30);
  });

  it('warns when the certificate is close to expiry', () => {
    const certPath = createCertificate('hive.example.com', ['hive.example.com'], 5);
    const status = inspectTlsCertificate({ certPath, publicUrl: 'https://hive.example.com' });

    expect(status.status).toBe('warn');
    expect(status.message).toContain('expires in');
  });

  it('fails when the certificate does not match the public host', () => {
    const certPath = createCertificate('wrong.example.com', ['wrong.example.com'], 60);
    const status = inspectTlsCertificate({ certPath, publicUrl: 'https://hive.example.com' });

    expect(status.status).toBe('fail');
    expect(status.hostnameMatched).toBe(false);
    expect(status.message).toContain('does not match');
  });
});
