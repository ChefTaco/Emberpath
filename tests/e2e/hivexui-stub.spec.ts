import { expect, test } from '@playwright/test';

// Servers started by tests/fixtures/stub-server.mjs.
const stub = 'http://127.0.0.1:19443';
const redirect = 'http://127.0.0.1:19444';
const hiveXuiUrl = 'https://hivexui.example.test/';

test('a retired UI path serves the HiveXUI stub when HIVEXUI_URL is unset', async ({ request }) => {
  for (const path of ['/', '/settings']) {
    const response = await request.get(stub + path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    const page = await response.text();
    expect(page).toContain('<title>Emberpath is managed in HiveXUI</title>');
    expect(page).toContain('<p>Open HiveXUI to manage Emberpath. Operators can set HIVEXUI_URL so this address redirects there.</p>');
  }
});

test('a retired UI path redirects to HIVEXUI_URL when it is set', async ({ request }) => {
  for (const path of ['/', '/settings']) {
    const response = await request.get(redirect + path, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe(hiveXuiUrl);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.text()).toContain(`<a href="${hiveXuiUrl}">Open HiveXUI</a>`);
  }
});

test('API paths keep their API answers in both modes', async ({ request }) => {
  for (const base of [stub, redirect]) {
    const unknown = await request.get(`${base}/api/not-a-route`, { maxRedirects: 0 });
    expect(unknown.status()).toBe(401);
    expect(unknown.headers()['content-type']).toMatch(/application\/json/u);
    const live = await request.get(`${base}/health/live`, { maxRedirects: 0 });
    expect(live.status()).toBe(200);
    expect((await live.json()).service).toBeTruthy();
  }
});
