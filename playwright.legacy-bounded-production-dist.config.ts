import { defineConfig } from '@playwright/test';

/**
 * No-build smoke for the immutable production candidate. CI runs this only
 * after build:checked, and the web server intentionally previews the normal
 * dist/ directory without invoking another Vite build.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'legacy-bounded-production-smoke.test.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:4179',
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
    command: 'npm run preview:e2e:legacy-bounded-production:dist',
    port: 4179,
    reuseExistingServer: false,
  },
});
