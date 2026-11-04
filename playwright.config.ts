import { defineConfig, devices } from '@playwright/test';

const port = 19443;
const apiPort = 15020;
const externalBaseUrl = process.env['HIVE_ROUTER_E2E_BASE_URL'];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: externalBaseUrl ?? `http://127.0.0.1:${port}`,
    ignoreHTTPSErrors: false,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'npm run build && node tests/fixtures/console-stack.mjs',
        url: `http://127.0.0.1:${port}/health`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
