import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseEnv } from '../../src/config/env.js';
import { HIVEXUI_STUB_CSP, renderHiveXuiStub } from '../../src/admin/hivexui-stub.js';

const secret = 'a'.repeat(40);
const heading = '<h1>Emberpath is managed in HiveXUI</h1>';
const noLink = '<p>Open HiveXUI to manage Emberpath. Operators can set HIVEXUI_URL so this address redirects there.</p>';

async function adminApp(hiveXuiUrl?: string) {
  vi.resetModules();
  vi.stubEnv('HIVEXUI_URL', hiveXuiUrl ?? '');
  const { createAdminApp } = await import('../../src/admin/app.js');
  return createAdminApp();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('retired UI paths without HIVEXUI_URL', () => {
  it('serve the HiveXUI stub page', async () => {
    const app = await adminApp();
    for (const path of ['/', '/settings', '/providers/abc', '/assets/index.js']) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toBe(HIVEXUI_STUB_CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('location')).toBeNull();
      const page = await response.text();
      expect(page).toContain('<html lang="en">');
      expect(page).toContain('<title>Emberpath is managed in HiveXUI</title>');
      expect(page).toContain(heading);
      expect(page).toContain(noLink);
      expect(page).not.toMatch(/<a |<script|<link/u);
    }
  });

  it('answer HEAD like GET without a body', async () => {
    const app = await adminApp();
    const response = await app.request('/', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(HIVEXUI_STUB_CSP);
    expect(await response.text()).toBe('');
  });
});

describe('retired UI paths with HIVEXUI_URL', () => {
  it('redirect to exactly the configured URL', async () => {
    const app = await adminApp('https://hivexui.example.test/emberpath');
    for (const path of ['/', '/settings?tab=keys']) {
      const response = await app.request(path);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://hivexui.example.test/emberpath');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const page = await response.text();
      expect(page).toContain(heading);
      expect(page).toContain('<p><a href="https://hivexui.example.test/emberpath">Open HiveXUI</a> to manage Emberpath.</p>');
    }
    const head = await app.request('/', { method: 'HEAD' });
    expect(head.status).toBe(302);
    expect(head.headers.get('location')).toBe('https://hivexui.example.test/emberpath');
  });

  it('escapes the URL in the link', () => {
    expect(renderHiveXuiStub('Emberpath', 'https://example.com/?a=1&b="<x>\''))
      .toContain('href="https://example.com/?a=1&amp;b=&quot;&lt;x&gt;&#39;"');
  });
});

describe('HIVEXUI_URL validation', () => {
  it('stores the normalized URL and treats empty as unset', () => {
    expect(parseEnv({ HIVE_ROUTER_SECRET: secret, HIVEXUI_URL: 'https://example.com' }).HIVEXUI_URL).toBe('https://example.com/');
    expect(parseEnv({ HIVE_ROUTER_SECRET: secret, HIVEXUI_URL: '' }).HIVEXUI_URL).toBeUndefined();
    expect(parseEnv({ HIVE_ROUTER_SECRET: secret }).HIVEXUI_URL).toBeUndefined();
  });

  it.each(['ftp://x', 'not a url', '/relative', 'https://user:pw@example.com/', 'https://example.com/#ui', 'javascript:alert(1)'])(
    'rejects %s at startup without echoing it',
    (value) => {
      let error: unknown;
      try {
        parseEnv({ HIVE_ROUTER_SECRET: secret, HIVEXUI_URL: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('HIVEXUI_URL must be an absolute http(s) URL');
      expect(message).not.toContain(value);
    },
  );
});

describe('API routes are unaffected', () => {
  it.each([undefined, 'https://hivexui.example.test/'])('with HIVEXUI_URL=%s', async (url) => {
    const app = await adminApp(url);
    // Unknown API paths are behind the admin session check, as before: never the stub.
    const unknown = await app.request('/api/not-a-route');
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('location')).toBeNull();
    expect(await unknown.text()).not.toContain('HiveXUI');
    const protectedRoute = await app.request('/api/audit');
    expect(protectedRoute.status).toBe(401);
    expect(protectedRoute.headers.get('content-type')).toMatch(/application\/json/u);
    const live = await app.request('/health/live');
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toMatch(/application\/json/u);
  });
});
