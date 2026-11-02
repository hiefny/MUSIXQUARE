import { defineConfig } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_PREVIEW_COMMAND } from './e2e/config.ts';

/**
 * Audio output-recovery lab (structural plan C1): a host alone in a real
 * room plays a local file while the AudioContext clock is frozen, and the
 * specs read the recovery dialog, the native resume/suspend calls and their
 * event origins. Local evidence only, never a CI job:
 *
 *   MXQR_E2E_APP_PORT=5091 MXQR_E2E_PEER_PORT=9091 \
 *     npx playwright test --config=playwright.audio-lab.config.ts
 *
 * The default config never sees these files (its testDir is ./e2e with the
 * default *.test/*.spec match), and they sit outside e2e/lab/ because
 * playwright.lab.config.ts prepares a local signaling Worker, not the PeerJS
 * server these rooms use.
 *
 * Chromium only: local Playwright WebKit on Windows has no AudioContext
 * (checked 2026-11-02), so none of these scenes can run there.
 */
export default defineConfig({
  testDir: './e2e/audio-lab',
  testMatch: '**/*.lab.ts',
  outputDir: './test-results/audio-lab',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One PeerJS server, and the clock samples are real-time: run alone.
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_APP_ORIGIN,
    headless: true,
    locale: 'en-US',
    serviceWorkers: 'block',
    trace: 'off',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium-audio-lab', use: { browserName: 'chromium' } }],
  webServer: {
    // The specs read the E2E-only state hooks: always serve a fresh E2E build
    // of the working tree.
    command: `npm run build:e2e && ${E2E_PREVIEW_COMMAND}`,
    url: E2E_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
