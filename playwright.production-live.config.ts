import { defineConfig } from '@playwright/test';

/**
 * Production-only browser smokes. These tests intentionally have no local
 * webServer or E2E transport injection: they must traverse the deployed app
 * and its real signaling / Cloudflare delivery path.
 */
export default defineConfig({
  testDir: './e2e/production-live',
  timeout: 300_000,
  expect: { timeout: 60_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'https://musixquare.com',
    headless: true,
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
