import { defineConfig } from 'vitest/config';

/**
 * Coverage ratchet for production Cloudflare Worker runtime modules. The broad and
 * critical TypeScript profiles intentionally cover only `src/`, so this profile
 * instruments the deployed Worker modules through their focused unit suites.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/core/__tests__/network-guard.setup.ts'],
    include: [
      'src/core/__tests__/{about-lifetime-room-count-worker,account-assertion,account-auth,account-auth-request-lifetime,account-auth-sqlite,account-nickname-policy,app-maintenance-admin,app-worker-cors,auxiliary-service-maintenance,designsystem-preview-indexing,display-name-policy,event-campaign-route,pro-bot-worker,service-maintenance,standard-room-account-assertion,standard-room-pin-membership}.test.ts',
      'src/core/__tests__/account-cookie-ordering.test.ts',
      'src/core/__tests__/screensaver-security.test.ts',
      'src/core/__tests__/announcement-expiry.test.ts',
      'src/core/__tests__/cloudflare-signaling-http-bridge.test.ts',
      'src/core/__tests__/signaling-diagnostics.test.ts',
      'src/core/__tests__/standard-signaling-bridge-diagnostics.test.ts',
      'src/core/__tests__/pro-room-proxy-diagnostics.test.ts',
      'src/core/__tests__/worker-shared-read-lifetime.test.ts',
      'src/core/__tests__/standard-room-burst.test.ts',
      'src/core/__tests__/pro-room-burst.test.ts',
      // C7-0 owner-boundary characterization (resource ownership RO-07..RO-09).
      'src/core/__tests__/owner-transfer-saga-convergence-sqlite.test.ts',
      'src/core/__tests__/pro-room-signaling-contract-workerd.test.ts',
      'src/pro-room/__tests__/pro-room-signaling-delivery.test.ts',
      'src/pro-room/__tests__/pro-room-duration-reads.test.ts',
      // C7-2b drift guard: one owner-transfer saga state list (RO-09).
      'src/core/__tests__/owner-transfer-saga-states.test.ts',
      'src/core/__tests__/translation-community.test.ts',
      'src/core/__tests__/translation-community-catalog.test.ts',
      'src/core/__tests__/translation-community-route.test.ts',
      'src/developer-api/__tests__/{developer-api-credential,developer-api-facade-worker,developer-api-worker}.test.ts',
      'src/network/transport/__tests__/{cloudflare-signaling,cloudflare-signaling-worker,signaling-liveness}.test.ts',
      'src/pro-room/__tests__/{pro-room-claims,pro-room-generation,pro-room-grants,pro-room-permissions,pro-room-playlists,pro-room-queue-mode,pro-room-worker,service-control,youtube-occurrence-manifest}.test.ts',
      'src/pro-room/__tests__/pro-youtube-duration.test.ts',
      'src/pro-room/__tests__/pro-room-diagnostics.test.ts',
      'src/pro-room/__tests__/pro-room-do-diagnostics.test.ts',
      'src/pro-room/__tests__/media-duration.test.ts',
      'src/pro-room/__tests__/mp4-duration.test.ts',
      'src/pro-room/__tests__/natural-completion-integration.test.ts',
      'src/share/__tests__/{remote-share-upload-assertion,remote-share-worker}.test.ts',
    ],
    environment: 'node',
    globals: true,
    // Keep initialization calls available to assertions; Vitest 5 clears them by default.
    clearMocks: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: 'coverage/worker-runtime',
      include: ['cloudflare/**/*.ts'],
      exclude: ['cloudflare/**/*.d.ts', 'cloudflare/**/*.contract.ts'],
      thresholds: {
        // Initial Node 24 baseline (2026-08-09): statements 82.31,
        // branches 78.11, functions 91.32, lines 87.08. Keep roughly one
        // percentage point of instrumentation margin while preventing a Worker
        // regression from being hidden behind the TypeScript-only profiles.
        statements: 81,
        branches: 77,
        functions: 90,
        lines: 86,
        'cloudflare/account-auth.ts': {
          statements: 83,
          branches: 78,
          functions: 93,
          lines: 89,
        },
        'cloudflare/app-worker.ts': {
          statements: 75,
          branches: 71,
          functions: 82,
          lines: 80,
        },
        'cloudflare/developer-api-facade-worker.ts': {
          statements: 82,
          branches: 80,
          functions: 88,
          lines: 86,
        },
        'cloudflare/developer-api-worker.ts': {
          statements: 86,
          branches: 83,
          functions: 89,
          lines: 89,
        },
        'cloudflare/pro-bot.ts': {
          statements: 82,
          branches: 74,
          functions: 85,
          lines: 87,
        },
        'cloudflare/pro-room-grants.ts': {
          statements: 75,
          branches: 71,
          functions: 90,
          lines: 79,
        },
        'cloudflare/pro-room-body.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'cloudflare/pro-room-worker.ts': {
          statements: 83,
          branches: 78,
          functions: 94,
          lines: 88,
        },
        'cloudflare/remote-share-worker.ts': {
          statements: 84,
          branches: 77,
          functions: 92,
          lines: 88,
        },
        'cloudflare/signaling-worker.ts': {
          statements: 81,
          branches: 79,
          functions: 94,
          lines: 86,
        },
        // Post-extraction baselines (2026-08-15) keep the new ownership
        // boundaries from hiding behind their former parent files' averages.
        'cloudflare/service-control-object.ts': {
          statements: 91,
          branches: 86,
          functions: 99,
          lines: 92,
        },
        'cloudflare/signaling-protocol.ts': {
          statements: 92,
          branches: 91,
          functions: 99,
          lines: 99,
        },
        // Pure Standard-room PIN membership and wrong-PIN limiter contract
        // (2026-10-11): validation, record normalizers and limiter arithmetic.
        'cloudflare/standard-room-pin-membership.ts': {
          statements: 97,
          branches: 95,
          functions: 99,
          lines: 98,
        },
      },
    },
  },
});
