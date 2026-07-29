import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'legacy-bounded-production-smoke.test.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // A production-candidate smoke must report its first observed result. The
  // setup helpers already have bounded connection retries for signaling.
  retries: 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:4178',
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
    command: 'npm run preview:e2e:legacy-bounded-production',
    port: 4178,
    reuseExistingServer: false,
  },
});
