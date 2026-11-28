/**
 * A throwaway self-signed certificate for loopback HTTPS fakes (localhost and 127.0.0.1).
 * Emberpath sends Oathweave client secrets over HTTPS only, so fake Oathweave servers in tests
 * serve HTTPS and are trusted through HIVE_ROUTER_IAM_CA_CERT_PATH (or HIVEMEM_CA_CERT_PATH).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LoopbackTls {
  cert: Buffer;
  key: Buffer;
  /** The certificate file, to trust as the CA. */
  caPath: string;
  cleanup(): void;
}

export function loopbackTls(): LoopbackTls {
  const directory = mkdtempSync(join(tmpdir(), 'emberpath-loopback-tls-'));
  const certPath = join(directory, 'loopback.crt');
  const keyPath = join(directory, 'loopback.key');
  const config = join(directory, 'loopback.cnf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-config', config], { stdio: 'ignore' });
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    caPath: certPath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
