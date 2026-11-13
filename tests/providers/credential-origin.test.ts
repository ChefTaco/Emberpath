import { describe, expect, it } from 'vitest';
import { providerRedactedValue, providerSchema, providerWriteErrorCodes } from '../../src/contracts/model-admin.js';
import { isCredentialHeader, providerOrigin, ProviderWriteRefusal, redactBaseUrl, redactDefaultHeaders, redactDefaultHeadersJson,
  resolveProviderCredentialWrite, type StoredProviderCredentials } from '../../src/providers/credential-origin.js';

const stored: StoredProviderCredentials = { slug: 'fixture', kind: 'OPENAI_GENERIC', baseUrl: 'https://provider.example.com/v1',
  encryptedAuthSecret: 'ciphertext', defaultHeadersJson: '{"X-Api-Token":"obviously-fake-header-credential","version":"1"}' };
const write = { baseUrl: stored.baseUrl, secret: 'keep', authDisabled: false, defaultHeaders: undefined, unresolvedStandIn: 'refuse' } as const;

describe('credential headers', () => {
  it('treats every header as a credential unless it is known to be harmless', () => {
    for (const name of ['authorization', 'X-Api-Key', 'cookie', 'x-custom', 'openai-organization']) expect(isCredentialHeader(name)).toBe(true);
    for (const name of ['Anthropic-Version', 'HTTP-Referer', 'x-title', ' version ']) expect(isCredentialHeader(name)).toBe(false);
  });

  it('redacts by name and leaves archive text without credentials byte for byte', () => {
    expect(redactDefaultHeaders({ 'x-api-key': 'obviously-fake', version: '1' })).toEqual({ headers: { 'x-api-key': providerRedactedValue, version: '1' }, redacted: ['x-api-key'] });
    expect(redactDefaultHeadersJson('{ "version": "1" }')).toBe('{ "version": "1" }');
    expect(redactDefaultHeadersJson('{ "x-api-key": "obviously-fake" }')).toBe(`{"x-api-key":"${providerRedactedValue}"}`);
    // Text that is not a header object cannot be redacted by name, so none of it is exported.
    for (const text of ['obviously-fake pasted text', '["obviously-fake"]', '"obviously-fake"']) expect(redactDefaultHeadersJson(text)).toBeNull();
    expect(redactDefaultHeadersJson(null)).toBeNull();
  });
});

describe('base URLs', () => {
  it('compares scheme, host and port and ignores the path', () => {
    expect(providerOrigin('https://Provider.example.com:443/v1')).toBe('https://provider.example.com');
    expect(providerOrigin('https://provider.example.com:8443/v1')).toBe('https://provider.example.com:8443');
    expect(providerOrigin('historical-address')).toBeNull();
    expect(providerOrigin('file:///etc/hosts')).toBeNull();
  });

  it('hides stored user info and rejects it on write', () => {
    expect(redactBaseUrl('https://operator:obviously-fake@provider.example.com/v1?x=1')).toBe('https://provider.example.com/v1?x=1');
    expect(redactBaseUrl('https://provider.example.com/v1')).toBe('https://provider.example.com/v1');
    expect(redactBaseUrl('historical-address')).toBe('historical-address');
    const base = { slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC' };
    for (const baseUrl of ['https://operator:obviously-fake@provider.example.com/v1', 'https://operator@provider.example.com', 'http://:obviously-fake@127.0.0.1:8080'])
      expect(providerSchema.safeParse({ ...base, baseUrl }).success).toBe(false);
    for (const baseUrl of ['https://provider.example.com/v1', 'http://127.0.0.1:8080', 'https://provider.example.com/path@segment'])
      expect(providerSchema.safeParse({ ...base, baseUrl }).success).toBe(true);
  });
});

describe('resolveProviderCredentialWrite', () => {
  const refusal = (run: () => unknown): ProviderWriteRefusal => {
    try { run(); } catch (error) { if (error instanceof ProviderWriteRefusal) return error; throw error; }
    throw new Error('expected a refusal');
  };

  it('keeps everything on the same origin, including default ports and letter case', () => {
    for (const baseUrl of ['https://provider.example.com/other', 'https://PROVIDER.example.com:443/v1'])
      expect(resolveProviderCredentialWrite(stored, { ...write, baseUrl })).toMatchObject({ originChanged: false, clearSecret: false });
    expect(resolveProviderCredentialWrite(stored, { ...write, defaultHeaders: { 'x-api-token': providerRedactedValue } }).defaultHeaders)
      .toEqual({ 'x-api-token': 'obviously-fake-header-credential' });
  });

  it('treats a stored address that is not a URL as a change unless it is sent back unchanged', () => {
    const historical = { ...stored, baseUrl: 'historical-address', defaultHeadersJson: null };
    expect(refusal(() => resolveProviderCredentialWrite(historical, { ...write, baseUrl: 'https://provider.example.com' })).code).toBe(providerWriteErrorCodes.originChangeRequiresSecret);
    expect(resolveProviderCredentialWrite(historical, { ...write, baseUrl: 'historical-address' }).originChanged).toBe(false);
  });

  it('has nothing to protect on a provider without stored credentials', () => {
    const open = { ...stored, encryptedAuthSecret: null, defaultHeadersJson: '{"version":"1"}' };
    expect(resolveProviderCredentialWrite(open, { ...write, baseUrl: 'https://other.example.net' })).toMatchObject({ originChanged: true, clearSecret: false });
    expect(resolveProviderCredentialWrite(open, { ...write, baseUrl: 'https://other.example.net', defaultHeaders: { Version: providerRedactedValue } }).defaultHeaders).toEqual({ Version: '1' });
  });

  it('names what is missing without quoting any stored value', () => {
    const error = refusal(() => resolveProviderCredentialWrite(stored, { ...write, baseUrl: 'https://other.example.net/v1?key=obviously-fake-query' }));
    expect(error).toMatchObject({ status: 422, code: providerWriteErrorCodes.originChangeRequiresSecret });
    expect(error.message).toContain('https://other.example.net)');
    expect(error.message).toContain('the auth secret'); expect(error.message).toContain('"X-Api-Token"');
    expect(error.message).not.toMatch(/obviously-fake|ciphertext/);
  });

  it('never resolves the stand-in to itself', () => {
    const masked = { ...stored, defaultHeadersJson: `{"x-api-token":"${providerRedactedValue}"}` };
    expect(refusal(() => resolveProviderCredentialWrite(masked, { ...write, defaultHeaders: { 'x-api-token': providerRedactedValue } })).code).toBe(providerWriteErrorCodes.redactedValueNotStored);
    expect(resolveProviderCredentialWrite(masked, { ...write, defaultHeaders: { 'x-api-token': providerRedactedValue }, unresolvedStandIn: 'omit' }))
      .toMatchObject({ defaultHeaders: {}, omittedHeaders: ['x-api-token'] });
  });
});
