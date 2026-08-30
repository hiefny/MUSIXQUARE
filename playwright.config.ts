import { defineConfig } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_PREVIEW_COMMAND } from './e2e/config.ts';

export default defineConfig({
  testDir: './e2e',
  // The iPhone/WebKit smoke has its own device config and workflow job.
  // Collecting it here runs mobile-only assertions in desktop Chromium.
  testIgnore: ['webkit-mobile-smoke.test.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
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
