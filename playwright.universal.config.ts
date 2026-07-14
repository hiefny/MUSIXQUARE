import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/universal-bounded',
  testMatch: '**/*.test.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    headless: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium-universal-bounded',
      testMatch: '**/*.core.test.ts',
      use: { browserName: 'chromium' },
    },
    {
      name: 'chrome-universal-aac',
      testMatch: '**/*.aac.test.ts',
      use: { browserName: 'chromium', channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'npm run preview:e2e:universal',
    port: 4174,
    reuseExistingServer: false,
  },
});
