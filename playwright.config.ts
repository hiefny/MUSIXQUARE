import { defineConfig } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_PREVIEW_COMMAND } from './e2e/config.ts';

export default defineConfig({
  testDir: './e2e',
  // The iPhone/WebKit smoke and production-live probes have their own configs
  // and workflow jobs. Keep them out of the default local Chromium suite.
  testIgnore: [
    'webkit-mobile-smoke.test.ts',
    'production-candidate-smoke.test.ts',
    '**/production-live/**/*.test.ts',
  ],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1, // Sequential — shared PeerJS signaling server
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_APP_ORIGIN,
    headless: true,
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: E2E_PREVIEW_COMMAND,
    url: E2E_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
