import { defineConfig } from '@playwright/test';

/**
 * Fast PR gate. Unlike the full compatibility suite, this configuration keeps
 * the browser's same-origin policy enabled and exercises both browser engines.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'smoke.test.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-secure',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    {
      name: 'webkit-secure',
      use: { browserName: 'webkit' },
    },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
