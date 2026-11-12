import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  webServer: {
    // Builds, then starts a stub-mode server (19443) and a redirect-mode server (19444).
    command: 'npm run build && node tests/fixtures/stub-server.mjs',
    url: 'http://127.0.0.1:19444/health/live',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
