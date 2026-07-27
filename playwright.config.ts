import { defineConfig } from '@playwright/test';

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
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:4173',
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
    command: 'npm run preview',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
