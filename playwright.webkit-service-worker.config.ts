import { defineConfig, devices } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_CONTROLLED_PRODUCTION_PREVIEW_COMMAND } from './e2e/config.ts';

/** Real WebKit lifecycle smoke with Service Workers deliberately enabled. */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['production-candidate-smoke.test.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: {
    ...devices['iPhone 13'],
    baseURL: E2E_APP_ORIGIN,
    headless: true,
    serviceWorkers: 'allow',
  },
  projects: [{ name: 'webkit-service-worker', use: { browserName: 'webkit' } }],
  webServer: {
    command: E2E_CONTROLLED_PRODUCTION_PREVIEW_COMMAND,
    url: E2E_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
