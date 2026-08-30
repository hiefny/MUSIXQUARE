import { defineConfig } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_PRODUCTION_PREVIEW_COMMAND } from './e2e/config.ts';

/** Browser evidence for the exact production artifact emitted by build:checked. */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['release-smoke.test.ts', 'production-candidate-smoke.test.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_APP_ORIGIN,
    headless: true,
    serviceWorkers: 'allow',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium-candidate', use: { browserName: 'chromium' } }],
  webServer: {
    command: E2E_PRODUCTION_PREVIEW_COMMAND,
    url: E2E_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
