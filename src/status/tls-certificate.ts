import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

export type CertificateHealthStatus = 'pass' | 'warn' | 'fail';

export interface TlsCertificateStatus {
  configured: boolean;
  status: CertificateHealthStatus;
  message: string;
  certPath?: string;
  expectedHost?: string;
  hostnameMatched?: boolean;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  domains: string[];
}

const WARNING_DAYS = 30;

function parseSubjectAltNames(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/,\s*/)
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/^DNS:/, '').replace(/^IP Address:/, ''))
    .filter(Boolean);
}

function expectedHostFromUrl(publicUrl: string): string | undefined {
  try {
    const host = new URL(publicUrl).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

export function inspectTlsCertificate(input: { certPath?: string; publicUrl: string; now?: Date }): TlsCertificateStatus {
  const expectedHost = expectedHostFromUrl(input.publicUrl);
  if (!input.certPath) {
    return {
      configured: false,
      status: 'warn',
      message: 'TLS certificate path is not configured.',
      domains: [],
      ...(expectedHost ? { expectedHost } : {}),
    };
  }

  const base = {
    configured: true,
    certPath: input.certPath,
    domains: [] as string[],
    ...(expectedHost ? { expectedHost } : {}),
  };

  if (!existsSync(input.certPath)) {
    return {
      ...base,
      status: 'fail',
      message: `TLS certificate was not found at ${input.certPath}.`,
    };
  }

  try {
    const certificate = new X509Certificate(readFileSync(input.certPath));
    const now = input.now ?? new Date();
    const validToDate = new Date(certificate.validTo);
    const daysRemaining = Math.ceil((validToDate.getTime() - now.getTime()) / 86_400_000);
    const hostnameMatched = expectedHost ? Boolean(certificate.checkHost(expectedHost)) : undefined;
    const domains = parseSubjectAltNames(certificate.subjectAltName);

    let status: CertificateHealthStatus = 'pass';
    let message = `${daysRemaining} days remaining.`;
    if (daysRemaining <= 0) {
      status = 'fail';
      message = 'TLS certificate has expired.';
    } else if (daysRemaining <= WARNING_DAYS) {
      status = 'warn';
      message = `TLS certificate expires in ${daysRemaining} days.`;
    }

    if (hostnameMatched === false) {
      status = 'fail';
      message = `TLS certificate does not match ${expectedHost}.`;
    }

    return {
      ...base,
      status,
      message,
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: validToDate.toISOString(),
      daysRemaining,
      domains,
      ...(typeof hostnameMatched === 'boolean' ? { hostnameMatched } : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: 'fail',
      message: error instanceof Error ? error.message : 'TLS certificate could not be parsed.',
    };
  }
}
