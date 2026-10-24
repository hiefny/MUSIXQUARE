import { defineConfig } from '@playwright/test';
import { LAB_APP_ORIGIN, LAB_PREVIEW_COMMAND } from './e2e/lab/lab-env.ts';

/**
 * Cloudflare two-context lab (structure-improvement C5-0). Host and guest pages
 * negotiate real Standard-room WebRTC through a local signaling Worker, and CDP
 * cuts the guest page's P2P path. Local evidence only, never a CI job:
 *
 *   npx playwright test --config=playwright.lab.config.ts
 *
 * The default config never sees these files: its testDir is ./e2e with the
 * default *.test/*.spec match, and the lab specs are e2e/lab/*.lab.ts.
 */
export default defineConfig({
  testDir: './e2e/lab',
  testMatch: '**/*.lab.ts',
  outputDir: './test-results/lab',
  // A scenario spans one outage plus a full track transfer at 1 MB/s.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1, // One shared local signaling Worker and real-time network timers.
  globalSetup: './e2e/lab/lab-global-setup.ts',
  use: {
    baseURL: LAB_APP_ORIGIN,
    headless: true,
    locale: 'en-US',
    serviceWorkers: 'block',
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium-lab', use: { browserName: 'chromium' } }],
  webServer: {
    command: LAB_PREVIEW_COMMAND,
    url: LAB_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
