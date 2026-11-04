import { expect, test, type Page } from '@playwright/test';

const allowedUsername = process.env['HIVE_ROUTER_E2E_USERNAME'] ?? 'admin';
const allowedPassword = process.env['HIVE_ROUTER_E2E_PASSWORD'] ?? 'playwright-secret';
const deniedUsername = process.env['HIVE_ROUTER_E2E_DENIED_USERNAME'] ?? 'intruder';

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  const response = page.waitForResponse((response) => response.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  if ((await response).ok()) await expect(page.getByRole('heading', { name: 'Hive Control Surface' })).toBeVisible();
}

test('shows disabled upgrade automation and rejects unauthenticated or cross-origin application', async ({ page }) => {
  expect((await page.request.post('/api/hive/upgrades/apply', { data: { planHash: 'a'.repeat(64) } })).status()).toBe(401);
  await page.goto('/');
  await signIn(page, allowedUsername, allowedPassword);
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hive updates' })).toBeVisible();
  await expect(page.getByText('Automatic update checks are disabled.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review upgrade' })).toHaveCount(0);
  const denied = await page.request.post('/api/hive/upgrades/apply', {
    headers: { origin: 'https://example.com' }, data: { planHash: 'a'.repeat(64) },
  });
  expect([401, 403]).toContain(denied.status());
});

test('upgrade review reauthenticates and submits only the confirmed plan hash', async ({ page }) => {
  const planHash = 'a'.repeat(64);
  let requests = 0;
  await page.route('**/api/hive/updates', (route) => route.fulfill({ json: { installed: '1.2.0', available: '1.2.1', enabled: true, canApply: true } }));
  await page.route('**/api/hive/upgrades/plan', (route) => ++requests === 1
    ? route.fulfill({ status: 403, json: { error: 'STEP_UP_REQUIRED' } })
    : route.fulfill({ json: { hash: planHash, packages: { '@hivemagnus/hive': { from: '1.2.0', to: '1.2.1' } }, target: { version: '1.2.1' }, changes: { newRequiredEnv: [], removedEnv: [], migrations: [] }, attention: [] } }));
  let submitted: unknown;
  await page.route('**/api/hive/upgrades/apply', (route) => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { state: 'running' } }); });
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Review upgrade', exact: true }).click();
  await page.getByLabel('Confirm your password').fill(allowedPassword);
  await page.getByRole('button', { name: 'Confirm authentication', exact: true }).click();
  await expect(page.getByText('Authentication refreshed. Review the upgrade again.')).toBeVisible();
  await page.getByRole('button', { name: 'Review upgrade', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm upgrade to 1.2.1', exact: true }).click();
  await expect(page.getByText('Upgrade started.', { exact: false })).toBeVisible();
  expect(submitted).toEqual({ planHash });
});

test.describe('Hive unified console', () => {
  test('rejects an account outside the operator allowlist', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Control Plane Console' })).toBeVisible();
    await expect(page.getByLabel('Username')).toHaveValue('admin');

    await signIn(page, deniedUsername, allowedPassword);

    await expect(page.locator('.error-banner')).toContainText('Invalid credentials');
    await expect(page.getByRole('heading', { name: 'Control Plane Console' })).toBeVisible();
  });

  test('authenticates through OS auth and navigates the unified shell', async ({ page }) => {
    await page.goto('/');
    await signIn(page, allowedUsername, allowedPassword);

    // Lands on the Hive control surface with the Hive nav item active.
    await expect(page.getByRole('heading', { name: 'Hive Control Surface' })).toBeVisible();
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('button', { name: 'Hive', exact: true })).toHaveClass(/nav-item--active/);
    await expect(page.getByText(allowedUsername).first()).toBeVisible();

    // Router Operations pages.
    await nav.getByRole('button', { name: 'Routers', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Routers', level: 2 })).toBeVisible();

    await nav.getByRole('button', { name: 'Providers', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Providers', level: 2 })).toBeVisible();

    await nav.getByRole('button', { name: 'Routing', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Routing', level: 2 })).toBeVisible();

    await nav.getByRole('button', { name: 'Testing', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Testing', level: 2 })).toBeVisible();

    // IAM section renders through the Router-authenticated IAM proxy.
    await nav.getByRole('button', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users', level: 2 })).toBeVisible();
    await expect(page.getByText('Router session')).toBeVisible();

    // Memory section embeds the HiveMem dashboard.
    await nav.getByRole('button', { name: 'Memories', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Memories', level: 2 })).toBeVisible();

    // API Docs.
    await nav.getByRole('button', { name: 'API Docs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'API Docs', level: 1 })).toBeVisible();
  });
});


test('creates, searches, edits and deletes a private memory through the real API', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable fixture CRUD; live acceptance uses an explicitly scoped workspace.');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  await page.getByRole('navigation').getByRole('button', { name: 'Memories', exact: true }).click();
  await expect(page.getByLabel('Worker status')).toContainText('manual');
  await expect(page.getByLabel('Worker status')).toContainText('Heartbeat');
  await expect(page.getByText('Automatic processing is off.', { exact: false })).toBeVisible();
  const content = `browser-fixture-${Date.now()}`;
  await page.getByLabel('Create in workspace').fill('default');
  await page.getByLabel('Visibility').selectOption('private');
  await page.getByPlaceholder('What should Hive remember?').fill(content);
  const created = page.waitForResponse((response) => response.url().endsWith('/api/memory/memories') && response.request().method() === 'POST');
  const conflicts = page.waitForResponse((response) => response.url().endsWith('/api/memory/conflicts'));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await created; expect(response.status()).toBe(201);
  const conflictResponse = await conflicts;
  expect(conflictResponse.status()).toBe(200);
  expect(conflictResponse.request().postDataJSON()).toMatchObject({ content, workspace_id: 'default', scope: 'private' });
  const memory = await response.json();
  expect(memory).toMatchObject({ scope: 'private', workspace_id: 'default', source: 'user_feedback', agent_id: 'console-fixture' });
  await page.getByRole('textbox', { name: 'Content', exact: true }).fill(content + '-edited');
  const updated = page.waitForResponse((response) => response.url().endsWith(`/api/memory/memories/${memory.id}`) && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await updated).status()).toBe(200);
  await page.getByLabel('Search', { exact: true }).fill(content);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(content + '-edited', { exact: true }).first()).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/memory/memories/${memory.id}`) && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await deleted).ok()).toBeTruthy();
  const status = await page.evaluate(async (id) => (await fetch(`/api/memory/memories/${id}`)).status, memory.id);
  expect(status).toBe(404);
});

test('shows actor budget warnings, unknown cost, and the metadata-only privacy preset', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable key and usage fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  await page.getByRole('navigation').getByRole('button', { name: 'API Keys', exact: true }).click();
  await page.getByRole('button', { name: 'Issue Key' }).click();
  const name = `budget-fixture-${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Metadata').fill('{"quota":{"dailyRequests":10,"warnAtPercent":80}}');
  await page.getByRole('button', { name: 'Generate key' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  const keyId = await page.evaluate(async (keyName) => {
    const response = await fetch('/api/client-keys');
    const body = await response.json();
    return body.data.find((key: { name: string }) => key.name === keyName).id as string;
  }, name);
  await page.route(`**/api/client-keys/${keyId}/usage`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { clientApiKeyId: keyId, usage: { dayRequests: 8, dayTokens: 80 }, warnings: ['dailyRequests'], exceeded: [], daily: [{ day: '2026-09-07', requests: 8, tokens: 80, costUsd: null }] } }),
  }));
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('Usage and budgets')).toBeVisible();
  await expect(page.getByText('Null cost means price or usage is unknown')).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'dailyRequests' })).toContainText('null');
  await page.getByRole('button', { name: 'Use metadata-only traces' }).click();
  await expect(page.getByLabel('Metadata')).toHaveValue(/"tracePrivacy": "metadata-only"/);
});

test('updates IAM password policy through the PAM-authenticated proxy with recent operator context', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable IAM policy fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  await page.getByRole('navigation').getByRole('button', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Security', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Password Policy' })).toBeVisible();
  await page.getByLabel('Min length').fill('12');
  const request = page.waitForRequest((candidate) => candidate.url().endsWith('/api/iam/password-policy') && candidate.method() === 'PATCH');
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/api/iam/password-policy') && candidate.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save policy' }).click();
  expect((await request).postDataJSON()).toMatchObject({ minLength: 12 });
  expect((await response).status()).toBe(200);
  await expect(page.getByText('Password policy updated')).toBeVisible();
  await expect(page.getByLabel('Min length')).toHaveValue('12');
});

test('late Memory detail responses and failures preserve a newer selection and edit', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable delayed-response fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  const suffix = Date.now();
  const memories = await page.evaluate(async (suffix) => {
    const output = [];
    for (const name of ['older', 'newer']) {
      const response = await fetch('/api/memory/memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `delayed-${name}-${suffix}`, type: 'semantic', scope: 'private', source: 'user_feedback', workspace_id: 'default' }) });
      if (!response.ok) throw new Error('Fixture memory creation failed');
      output.push(await response.json());
    }
    return output;
  }, suffix);
  await page.getByRole('navigation').getByRole('button', { name: 'Memories', exact: true }).click();
  for (const status of [200, 503]) {
    let release!: () => void; let observed!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { observed = resolve; });
    const path = `**/api/memory/memories/${memories[0].id}`;
    await page.route(path, async (route) => {
      const response = await route.fetch(); observed(); await held;
      await route.fulfill(status === 200 ? { response } : { status, contentType: 'application/json', body: JSON.stringify({ error: 'Obsolete detail failure' }) });
    });
    try {
      await page.getByRole('button', { name: new RegExp(memories[0].content) }).click(); await requested;
      await expect(page.getByRole('textbox', { name: 'Content', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: new RegExp(memories[1].content) }).click();
      const content = page.getByRole('textbox', { name: 'Content', exact: true });
      await expect(content).toHaveValue(memories[1].content);
      await content.fill('unsaved edit survives old response');
      const returned = page.waitForResponse((response) => response.url().endsWith(`/api/memory/memories/${memories[0].id}`));
      release(); await (await returned).finished();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(content).toHaveValue('unsaved edit survives old response');
      await expect(page.getByText('Obsolete detail failure', { exact: false })).toHaveCount(0);
    } finally { release(); await page.unroute(path); }
  }
});


test('resumes partial enrollment, restricts workspace and contains old credentials', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Isolated fault-injection fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  const actorId = 'partial-' + Date.now();
  const body = { agentId: actorId, displayName: 'Repeated display name', iamClientId: 'fixture-client', workspaceId: actorId, scopes: ['memories:read', 'memories:write', 'workspaces:read'], expiresHours: 1 };
  const enroll = () => page.evaluate(async (body) => { const response = await fetch('/api/hive/actors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }, body);
  const first = await enroll(); expect(first.status).toBe(207);
  const second = await enroll(); expect(second.status).toBe(201);
  expect(second.body.identifiers.iamServiceAccountId).toBe(first.body.identifiers.iamServiceAccountId);
  expect(second.body.identifiers.routerClientKeyId).toBe(first.body.identifiers.routerClientKeyId);
  const endpoint = second.body.configuration.memoryUrl;
  const write = (workspace_id: string) => fetch(endpoint + '/v1/memories', { method: 'POST', headers: { authorization: 'Bearer ' + second.body.secrets.memoryToken, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'scoped fixture', type: 'semantic', scope: 'private', workspace_id }) });
  expect((await write(actorId)).status).toBe(201); expect((await write('default')).status).toBe(403);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit')).json()));
  for (const secret of Object.values(second.body.secrets)) if (typeof secret === 'string') expect(audit).not.toContain(secret);
  const disabled = await page.evaluate(async (id) => (await fetch('/api/hive/actors/' + id + '/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, actorId);
  expect(disabled).toBe(200); expect((await write(actorId)).status).toBe(403);
});

test('selection preview and version rollback never invoke a provider', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable routing configuration only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  const result = await page.evaluate(async () => {
    const json = async (url: string, body?: unknown) => { const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, value: await r.json() }; };
    const before = await json('/api/routing/revisions');
    const preview = await json('/api/testing/preview', { cases: [{ modelAlias: 'standard', prompt: 'redacted fixture' }], objective: { ...before.value.config.objective, goal: 'cheapest' } });
    const apply = await json('/api/routing/revisions', { baseRevision: before.value.revision, patch: { objective: { ...before.value.config.objective, goal: 'cheapest' } } });
    const rollback = await json('/api/routing/revisions/' + before.value.revision + '/rollback', { baseRevision: apply.value.revision });
    return { before, preview, apply, rollback };
  });
  expect(result.preview.status).toBe(200); expect(result.preview.value.inferenceCalls).toBe(0);
  expect(result.apply.status).toBe(200); expect(result.rollback.status).toBe(200);
  expect(result.rollback.value.revision).toBe(result.before.value.revision);
});

test('completes virtual passkey ceremonies and rejects replay, expiry and Redis loss', async ({ page, context }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable passkey fixture only');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  try {
    await page.goto('http://localhost:19443'); await signIn(page, allowedUsername, allowedPassword);
    const result = await page.evaluate(async () => {
      const api = async (path: string, body: unknown = {}) => { const response = await fetch('/api/iam/webauthn/fixture-' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() }; };
      const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const options = (await api('register/options')).value;
      // A second tab/ceremony must not overwrite the first challenge.
      await api('register/options');
      const credential = await navigator.credentials.create({ publicKey: { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) }, excludeCredentials: [] } }) as PublicKeyCredential;
      const attestation = credential.response as AuthenticatorAttestationResponse;
      const registrationBody = { id: credential.id, rawId: encode(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults(), response: { clientDataJSON: encode(attestation.clientDataJSON), attestationObject: encode(attestation.attestationObject), transports: attestation.getTransports() } };
      const registered = await api('register/verify', registrationBody);
      const replay = await api('register/verify', registrationBody);
      const login = (await api('login/options')).value;
      await api('login/options');
      const assertion = await navigator.credentials.get({ publicKey: { ...login, challenge: decode(login.challenge), allowCredentials: login.allowCredentials.map((entry: { id: string }) => ({ ...entry, id: decode(entry.id) })) } }) as PublicKeyCredential;
      const response = assertion.response as AuthenticatorAssertionResponse;
      const authenticated = await api('login/verify', { id: assertion.id, rawId: encode(assertion.rawId), type: assertion.type, clientExtensionResults: assertion.getClientExtensionResults(), response: { clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null } });
      const storeFailure = await api('store/verify');
      return { registered, replay, authenticated, storeFailure };
    });
    expect(result.registered.value.verified).toBe(true); expect(result.replay.status).toBe(400); expect(result.authenticated.value.verified).toBe(true);
    expect(result.storeFailure.value).toMatchObject({ expiryRejected: true, outageRejected: true });
    expect(result.storeFailure.value.ttl).toBeGreaterThan(295);
    expect(result.storeFailure.value.outageMilliseconds).toBeLessThan(6500);
  } finally { await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); await cdp.detach(); }
});

test('restores actor links and keeps keyboard focus within a narrow-screen drawer', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable console fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  await page.goto('/?page=actors');
  const actor = page.locator('tbody').getByRole('button', { name: 'Navigation fixture', exact: true });
  await expect(actor).toBeVisible();
  await page.route('**/api/providers', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture provider inventory outage' }) }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).last().click();
  await expect(page.getByText(/console sections failed to refresh/).first()).toBeVisible();
  await expect(actor).toBeVisible();
  const name = await actor.innerText();
  await actor.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get('actor')).toBeTruthy();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(actor).toBeFocused();
  await page.keyboard.press('Enter');
  const link = page.url();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(link); await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390.01);
  await page.screenshot({ path: 'test-results/actor-mobile.png', fullPage: false, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).searchParams.has('actor')).toBe(false);
});

test('resumes partial rotation without rotating successful steps and disables only the bound actor', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable lifecycle failure fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  const actorId = 'rotation-' + Date.now(); const peerId = 'independent-' + Date.now();
  const call = (path: string, body: unknown) => page.evaluate(async ({ path, body }) => {
    const response = await fetch('/api/hive/actors' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
  const enroll = (agentId: string) => call('', { agentId, displayName: 'Same lifecycle display label', iamClientId: 'fixture-client', workspaceId: agentId, scopes: ['memories:read', 'memories:write'], expiresHours: 1 });
  const initial = await enroll(actorId); const peer = await enroll(peerId);
  expect(initial.status).toBe(201); expect(peer.status).toBe(201);
  const operationId = crypto.randomUUID();
  const first = await call('/' + actorId + '/rotate', { operationId });
  expect(first.status).toBe(207);
  const second = await call('/' + actorId + '/rotate', { operationId });
  expect(second.status).toBe(200);
  expect(second.body.secrets.iamApiKey).toBe(first.body.secrets.iamApiKey);
  expect(second.body.secrets.routerApiKey).toBe(first.body.secrets.routerApiKey);
  expect(second.body.steps.find((step: { service: string }) => step.service === 'memory').attempts).toBe(2);
  const replay = await call('/' + actorId + '/rotate', { operationId });
  expect(replay.body.secrets).toEqual(second.body.secrets);
  const memoryStatus = (token: string) => fetch(initial.body.configuration.memoryUrl + '/v1/auth/me', { headers: { authorization: 'Bearer ' + token } }).then((response) => response.status);
  expect(await memoryStatus(initial.body.secrets.memoryToken)).toBe(403);
  expect(await memoryStatus(second.body.secrets.memoryToken)).toBe(200);
  const routerStatus = (token: string) => fetch(initial.body.configuration.routerUrl + '/v1/models', { headers: { authorization: 'Bearer ' + token } }).then((response) => response.status);
  expect(await routerStatus(initial.body.secrets.routerApiKey)).toBe(401);
  expect(await routerStatus(second.body.secrets.routerApiKey)).toBe(200);
  const audit = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/audit')).json()));
  for (const secret of Object.values(second.body.secrets)) if (typeof secret === 'string') expect(audit).not.toContain(secret);
  const disabled = await call('/' + actorId + '/disable', { operationId: crypto.randomUUID(), identifiers: peer.body.identifiers });
  expect(disabled.status).toBe(200);
  expect(await memoryStatus(second.body.secrets.memoryToken)).toBe(403);
  expect(await routerStatus(second.body.secrets.routerApiKey)).toBe(401);
  expect(await memoryStatus(peer.body.secrets.memoryToken)).toBe(200);
  expect(await routerStatus(peer.body.secrets.routerApiKey)).toBe(200);
  const accounts = await page.evaluate(async () => (await fetch('/api/iam/service-accounts')).json()).then((result) => result.serviceAccounts);
  expect(accounts.find((account: { id: string }) => account.id === initial.body.identifiers.iamServiceAccountId)).toMatchObject({ active: false, rotationCount: 1 });
  expect(accounts.find((account: { id: string }) => account.id === peer.body.identifiers.iamServiceAccountId)).toMatchObject({ active: true, rotationCount: 0 });
  expect((await call('/' + actorId + '/rotate', { operationId })).status).toBe(409);
});

test('recovers an IAM commit whose response was lost and contains partial enrollment explicitly', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable enrollment failure fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  const actorId = 'lost-iam-' + Date.now();
  const result = await page.evaluate(async (agentId) => {
    const post = async (path: string, body: unknown) => { const response = await fetch('/api/hive/actors' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    const payload = { agentId, displayName: 'Lost IAM receipt', iamClientId: 'fixture-client', scopes: ['memories:read'], expiresHours: 1 };
    const first = await post('', payload); const second = await post('', payload);
    const partialId = 'partial-stop-' + Date.now();
    const partialPayload = { ...payload, agentId: partialId };
    const partial = await post('', partialPayload);
    const contained = await post('/' + partialId + '/disable', {});
    const resume = await post('', partialPayload);
    const accounts = await (await fetch('/api/iam/service-accounts')).json();
    return { first, second, partial, contained, resume, accounts };
  }, actorId);
  expect(result.first.status).toBe(207); expect(result.second.status).toBe(201);
  const accounts = result.accounts.serviceAccounts.filter((account: { name: string }) => account.name === 'hive-actor-' + actorId);
  expect(accounts).toHaveLength(1); expect(accounts[0].rotationCount).toBe(1);
  expect(result.partial.status).toBe(207); expect(result.contained.status).toBe(200); expect(result.resume.status).toBe(409);
});

test('rolls back Router key creation with its failed receipt and recovers a lost Memory response', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable database fault fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  const result = await page.evaluate(async () => {
    const post = async (agentId: string) => { const response = await fetch('/api/hive/actors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, displayName: 'Checkpoint fixture', iamClientId: 'fixture-client', scopes: ['memories:read'], expiresHours: 1 }) }); return { status: response.status, body: await response.json() }; };
    const routerId = 'router-crash-' + Date.now();
    const first = await post(routerId);
    const before = await (await fetch('/api/client-keys')).json();
    // This fixture-only IAM detail read restores the disposable SQLite writer.
    await fetch('/api/iam/service-accounts/' + first.body.identifiers.iamServiceAccountId);
    const second = await post(routerId);
    const after = await (await fetch('/api/client-keys')).json();
    const memoryId = 'lost-memory-' + Date.now();
    const memory = await post(memoryId); const retry = await post(memoryId);
    const { agents } = await (await fetch('/api/memory/dashboard-data')).json();
    return { routerId, first, second, before, after, memoryId, memory, retry, agents };
  });
  expect(result.first.status).toBe(207); expect(result.first.body.identifiers.routerClientKeyId).toBeNull();
  expect(result.before.data.filter((key: { id: string }) => key.id === 'actor-key-' + result.routerId)).toHaveLength(0);
  expect(result.second.status).toBe(201);
  expect(result.after.data.filter((key: { id: string }) => key.id === 'actor-key-' + result.routerId)).toHaveLength(1);
  expect(result.memory.status).toBe(201); expect(result.retry.body.identifiers).toEqual(result.memory.body.identifiers);
  expect(result.agents.filter((agent: { agent_id: string }) => agent.agent_id === result.memoryId)).toHaveLength(1);
});

test('renders partial enrollment honestly and offers explicit containment', async ({ page }) => {
  test.skip(Boolean(process.env.HIVE_ROUTER_E2E_BASE_URL), 'Disposable UI compensation fixture only');
  await page.goto('/'); await signIn(page, allowedUsername, allowedPassword);
  await page.goto('/?page=actors');
  await page.getByLabel('Agent ID', { exact: true }).fill('partial-ui-' + Date.now());
  await page.getByLabel('Display name', { exact: true }).fill('Partial UI fixture');
  const pending = page.waitForResponse((response) => response.url().endsWith('/api/hive/actors') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create actor', exact: true }).click();
  expect((await pending).status()).toBe(207);
  await expect(page.getByText('Actor partially created', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'I have saved these credentials', exact: true })).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Contain partial actor', exact: true }).click();
  await expect(page.getByText('Partial actor contained', { exact: true })).toBeVisible();
});
