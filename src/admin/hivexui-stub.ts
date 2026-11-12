/**
 * Emberpath has no browser UI of its own: HiveXUI is the UI for the Hive:Magnus
 * product line. Paths that used to load the retired bundled UI answer this stub,
 * or redirect to HIVEXUI_URL when it is configured.
 */
export const HIVEXUI_STUB_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PRODUCT = 'Emberpath';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderHiveXuiStub(product: string, url?: string): string {
  const sentence = url
    ? `<p><a href="${escapeHtml(url)}">Open HiveXUI</a> to manage ${product}.</p>`
    : `<p>Open HiveXUI to manage ${product}. Operators can set HIVEXUI_URL so this address redirects there.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${product} is managed in HiveXUI</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
<main>
<h1>${product} is managed in HiveXUI</h1>
${sentence}
</main>
</body>
</html>
`;
}

/** Response for a retired UI path: a 302 to HIVEXUI_URL when set, otherwise the stub page. */
export function hiveXuiStubResponse(url?: string): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': HIVEXUI_STUB_CSP,
    'x-content-type-options': 'nosniff',
  });
  if (url) {
    headers.set('location', url);
    return new Response(renderHiveXuiStub(PRODUCT, url), { status: 302, headers });
  }
  return new Response(renderHiveXuiStub(PRODUCT), { status: 200, headers });
}
