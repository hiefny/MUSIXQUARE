import { defineConfig, devices } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_PREVIEW_COMMAND } from './e2e/config.ts';

/**
 * Small real-WebKit lane for the mobile paths that Chromium + an iPhone user
 * agent cannot validate. Keep it targeted; the full serial suite remains the
 * manually requested Chromium stress run.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'webkit-mobile-smoke.test.ts',
    'custom-scrollbar-timeline.test.ts',
    'youtube-landscape-full-bleed.test.ts',
    'playlist-title-marquee.test.ts',
    'chat-copy-tap.test.ts',
    'maintenance-inline-logo.test.ts',
  ],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    ...devices['iPhone 13'],
    baseURL: E2E_APP_ORIGIN,
    headless: true,
    // The lane validates the real WebKit UI/runtime surface, not PWA update
    // orchestration. Blocking registrations prevents an update prompt from a
    // previous test context from covering the navigation under test.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'webkit-iphone',
      use: { browserName: 'webkit' },
    },
  ],
  webServer: {
    command: E2E_PREVIEW_COMMAND,
    url: E2E_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
