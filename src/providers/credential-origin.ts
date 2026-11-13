// A stored provider credential belongs to the server it was entered for. This module decides
// what counts as a credential, what a read may show of it, and when a write may keep it.
import { providerRedactedValue, providerWriteErrorCodes, type ProviderWriteErrorCode } from '../contracts/model-admin.js';
import { safeJsonParse } from '../utils/json.js';

/**
 * Default headers whose values are shown on read and kept across a change of origin. Every
 * other header is treated as a credential: a header name cannot prove that its value is
 * harmless, so the list names the ones known to be.
 */
const NON_CREDENTIAL_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'http-referer',
  'openai-beta',
  'referer',
  'user-agent',
  'version',
  'x-openrouter-title',
  'x-title',
]);

export function isCredentialHeader(name: string): boolean {
  return !NON_CREDENTIAL_HEADERS.has(name.trim().toLowerCase());
}

/** A refused provider write. Nothing was stored. */
export class ProviderWriteRefusal extends Error {
  override name = 'ProviderWriteRefusal';
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: ProviderWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Scheme, host and port, or null when the stored text is not a URL. */
export function providerOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The base URL as a read may show it. A stored `user:password@` (accepted by older releases,
 * never usable) is left out.
 */
export function redactBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (!url.username && !url.password) return baseUrl;
  url.username = '';
  url.password = '';
  return url.toString();
}

/** Stored header JSON as the adapters send it; null when the text is not a header object. */
export function parseStoredHeaders(defaultHeadersJson: string | null | undefined): Record<string, string> | null {
  const parsed = safeJsonParse<unknown>(defaultHeadersJson, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') headers[name] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') headers[name] = String(value);
  }
  return headers;
}

/** Default headers for a read: credential values replaced by the stand-in, and their names. */
export function redactDefaultHeaders(headers: Record<string, string>): { headers: Record<string, string>; redacted: string[] } {
  const redacted: string[] = [];
  const shown: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isCredentialHeader(name)) {
      shown[name] = providerRedactedValue;
      redacted.push(name);
    } else {
      shown[name] = value;
    }
  }
  return { headers: shown, redacted };
}

/**
 * Stored header JSON for an archive. Text without credential headers is returned byte for
 * byte; text that is not a header object is withheld, because it cannot be redacted by name.
 */
export function redactDefaultHeadersJson(defaultHeadersJson: string | null): string | null {
  if (defaultHeadersJson === null) return null;
  const stored = parseStoredHeaders(defaultHeadersJson);
  if (!stored) return null;
  const { headers, redacted } = redactDefaultHeaders(stored);
  return redacted.length === 0 ? defaultHeadersJson : JSON.stringify(headers);
}

export interface StoredProviderCredentials {
  slug: string;
  kind: string;
  baseUrl: string;
  encryptedAuthSecret: string | null;
  defaultHeadersJson: string | null;
}

export interface ProviderCredentialWrite {
  baseUrl: string;
  /** How the request treats the stored secret: replaced, explicitly discarded, or left alone. */
  secret: 'replace' | 'clear' | 'keep';
  /** True when the request no longer wants a credential sent (auth mode NONE). */
  authDisabled: boolean;
  /** The request's default headers; undefined leaves the stored headers alone. */
  defaultHeaders: Record<string, string> | undefined;
  /**
   * What to do with the stand-in where no stored value exists: refuse (an edit must not invent
   * a header) or leave the header out (an archive imported into another installation).
   */
  unresolvedStandIn: 'refuse' | 'omit';
}

export interface ResolvedProviderCredentialWrite {
  originChanged: boolean;
  /** The stored secret must be removed with this write. */
  clearSecret: boolean;
  /** Headers to store, with every stand-in replaced by its stored value. */
  defaultHeaders: Record<string, string> | undefined;
  /** Stand-in headers left out because nothing was stored for them. */
  omittedHeaders: string[];
}

function storedHeaderLookup(stored: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(stored).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * Check a write against the stored record. A change of origin (scheme, host or port) must not
 * carry a stored credential along: the secret has to be supplied again or discarded, and
 * credential headers have to be supplied again or left out. A path change on the same origin
 * keeps everything, because the same server already receives the credential.
 */
export function resolveProviderCredentialWrite(stored: StoredProviderCredentials | null, write: ProviderCredentialWrite): ResolvedProviderCredentialWrite {
  const storedHeaders = stored ? parseStoredHeaders(stored.defaultHeadersJson) ?? {} : {};
  const lookup = storedHeaderLookup(storedHeaders);
  const storedOrigin = stored ? providerOrigin(stored.baseUrl) : null;
  // A stored address that is not a URL has no origin to stay on: any new address is a change.
  const originChanged = stored !== null && (storedOrigin === null ? stored.baseUrl !== write.baseUrl : storedOrigin !== providerOrigin(write.baseUrl));

  const kept: string[] = [];
  const omittedHeaders: string[] = [];
  let defaultHeaders: Record<string, string> | undefined;
  if (write.defaultHeaders) {
    defaultHeaders = {};
    for (const [name, value] of Object.entries(write.defaultHeaders)) {
      if (value !== providerRedactedValue) {
        defaultHeaders[name] = value;
        continue;
      }
      const storedValue = lookup.get(name.toLowerCase());
      if (storedValue === undefined || storedValue === providerRedactedValue) {
        if (write.unresolvedStandIn === 'omit') {
          omittedHeaders.push(name);
          continue;
        }
        throw new ProviderWriteRefusal(400, providerWriteErrorCodes.redactedValueNotStored,
          `Default header "${name}" was sent as "${providerRedactedValue}", which stands for a stored value, but this provider has no stored value for it. Enter the real value or remove the header. Nothing was changed.`);
      }
      defaultHeaders[name] = storedValue;
      if (isCredentialHeader(name)) kept.push(name);
    }
  } else {
    kept.push(...Object.keys(storedHeaders).filter(isCredentialHeader));
  }

  const hasStoredSecret = Boolean(stored?.encryptedAuthSecret);
  let clearSecret = write.secret === 'clear';
  if (originChanged && stored) {
    const missing: string[] = [];
    if (hasStoredSecret && write.secret === 'keep') {
      // Auth mode NONE with a new origin can only mean the credential is not wanted there.
      if (write.authDisabled) clearSecret = true;
      else missing.push('the auth secret');
    }
    for (const name of kept) missing.push(`default header "${name}"`);
    if (missing.length > 0) {
      const target = providerOrigin(write.baseUrl) ?? 'the new address';
      const intro = `The base URL of provider "${stored.slug}" now points to a different server (${target}) than the one its stored credentials were entered for, so they are not sent there automatically.`;
      if (stored.kind === 'CODEX' && hasStoredSecret && write.secret === 'keep' && !write.authDisabled) {
        throw new ProviderWriteRefusal(422, providerWriteErrorCodes.originChangeRequiresReauthorization,
          `${intro} This provider is authorized through OpenAI sign-in: authorize Codex again (which restores its official address) or delete the provider. Nothing was changed.`);
      }
      throw new ProviderWriteRefusal(422, providerWriteErrorCodes.originChangeRequiresSecret,
        `${intro} Supply again in the same request: ${missing.join(', ')}. To move without a credential, set the auth mode to NONE and remove the header. Nothing was changed.`);
    }
  }
  return { originChanged, clearSecret, defaultHeaders, omittedHeaders };
}
