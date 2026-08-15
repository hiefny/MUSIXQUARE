import { defineConfig } from 'vitest/config';

/**
 * Coverage ratchet for production Cloudflare Worker JavaScript. The broad and
 * critical TypeScript profiles intentionally cover only `src/`, so this profile
 * instruments the deployed Worker modules through their focused unit suites.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/core/__tests__/network-guard.setup.ts'],
    include: [
      'src/core/__tests__/{about-lifetime-room-count-worker,account-assertion,account-auth,account-auth-request-lifetime,account-auth-sqlite,account-nickname-policy,app-maintenance-admin,app-worker-cors,auxiliary-service-maintenance,display-name-policy,event-campaign-route,pro-bot-worker,service-maintenance,standard-room-account-assertion}.test.ts',
      'src/developer-api/__tests__/{developer-api-facade-worker,developer-api-worker}.test.ts',
      'src/network/transport/__tests__/{cloudflare-signaling,cloudflare-signaling-worker}.test.ts',
      'src/pro-room/__tests__/{pro-room-grants,pro-room-worker,service-control}.test.ts',
      'src/share/__tests__/remote-share-worker.test.ts',
    ],
    environment: 'node',
    globals: true,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: 'coverage/worker-runtime',
      include: ['cloudflare/**/*.js'],
      thresholds: {
        // Initial Node 24 baseline (2026-08-09): statements 82.31,
        // branches 78.11, functions 91.32, lines 87.08. Keep roughly one
        // percentage point of instrumentation margin while preventing a Worker
        // regression from being hidden behind the TypeScript-only profiles.
        statements: 81,
        branches: 77,
        functions: 90,
        lines: 86,
        'cloudflare/account-auth.js': {
          statements: 83,
          branches: 78,
          functions: 93,
          lines: 89,
        },
        'cloudflare/app-worker.js': {
          statements: 75,
          branches: 71,
          functions: 82,
          lines: 80,
        },
        'cloudflare/developer-api-facade-worker.js': {
          statements: 82,
          branches: 80,
          functions: 88,
          lines: 86,
        },
        'cloudflare/developer-api-worker.js': {
          statements: 86,
          branches: 83,
          functions: 89,
          lines: 89,
        },
        'cloudflare/pro-bot.js': {
          statements: 82,
          branches: 74,
          functions: 85,
          lines: 87,
        },
        'cloudflare/pro-room-grants.js': {
          statements: 75,
          branches: 71,
          functions: 90,
          lines: 79,
        },
        'cloudflare/pro-room-body.js': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'cloudflare/pro-room-worker.js': {
          statements: 83,
          branches: 78,
          functions: 94,
          lines: 88,
        },
        'cloudflare/remote-share-worker.js': {
          statements: 84,
          branches: 77,
          functions: 92,
          lines: 88,
        },
        'cloudflare/signaling-worker.js': {
          statements: 81,
          branches: 79,
          functions: 94,
          lines: 86,
        },
        // Post-extraction baselines (2026-08-15) keep the new ownership
        // boundaries from hiding behind their former parent files' averages.
        'cloudflare/service-control-object.js': {
          statements: 91,
          branches: 86,
          functions: 99,
          lines: 92,
        },
        'cloudflare/signaling-protocol.js': {
          statements: 92,
          branches: 91,
          functions: 99,
          lines: 99,
        },
      },
    },
  },
});
