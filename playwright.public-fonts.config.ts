import { defineConfig } from '@playwright/test';
import { E2E_APP_ORIGIN, E2E_PRODUCTION_PREVIEW_COMMAND } from './e2e/config.ts';

/**
 * The faces the pages outside the app draw with (owner decision 2026-11-02:
 * every public page on the app's font system): face-per-specimen,
 * face-per-node and measurement specs. Local evidence only, never a CI job:
 *
 *   MXQR_E2E_APP_PORT=5491 MXQR_E2E_PEER_PORT=5492 \
 *     npx playwright test --config=playwright.public-fonts.config.ts
 *
 * The default config never sees these files: its testDir is ./e2e with the
 * default *.test/*.spec match, and these specs are e2e/public-fonts/*.lab.ts.
 * It serves a fresh production build of the working tree, the files that
 * deploy; set MXQR_PUBLIC_FONTS_PREBUILT=1 to serve the dist/ already built.
 */
const BUILD = process.env.MXQR_PUBLIC_FONTS_PREBUILT === '1' ? '' : 'npm run build && ';

export default defineConfig({
  testDir: './e2e/public-fonts',
  testMatch: '**/*.lab.ts',
  outputDir: './test-results/public-fonts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: {
    baseURL: E2E_APP_ORIGIN,
    headless: true,
    locale: 'en-US',
    serviceWorkers: 'block',
    trace: 'off',
  },
  projects: [{ name: 'chromium-public-fonts', use: { browserName: 'chromium' } }],
  webServer: {
    command: `${BUILD}${E2E_PRODUCTION_PREVIEW_COMMAND}`,
    url: E2E_APP_ORIGIN,
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
