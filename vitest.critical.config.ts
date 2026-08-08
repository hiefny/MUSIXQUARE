import { defineConfig } from 'vitest/config';

/**
 * Coverage ratchet for high-risk runtime paths that the broad historical
 * report excluded. This profile complements the broad unit KPI and keeps the
 * real-time/request-lifetime modules instrumented as they evolve.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/core/__tests__/network-guard.setup.ts'],
    include: [
      'src/core/__tests__/capability-pow.test.ts',
      'src/core/__tests__/request-lifetime.test.ts',
      'src/network/__tests__/*system-audio-sfu.test.ts',
      'src/audio/__tests__/{context-recovery,system-capture,system-capture-stop}.test.ts',
      'src/pro-room/__tests__/{api,heartbeat-single-flight,media-transfer,playlist-state-manager,session-controller}.test.ts',
      'src/pro-room/__tests__/runtime-*.test.ts',
      'src/player/__tests__/{busy-guard,concurrency-invariants,local-output-rejoin,playback,playback-extended,playback-queue-identity,playback-replay-resync,playback-remote-wait,playlist,transport-position}.test.ts',
      'src/storage/__tests__/preload.test.ts',
      'src/network/transport/__tests__/{cloudflare-signaling,cloudflare-signaling-worker}.test.ts',
      'src/youtube/__tests__/{search,search-style}.test.ts',
      'src/account/__tests__/{api,session,login-return}.test.ts',
      'src/ui/__tests__/announcement.test.ts',
      'src/share/__tests__/r2-client.test.ts',
    ],
    environment: 'node',
    globals: true,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: 'coverage/critical-runtime',
      include: [
        'src/core/capability.ts',
        'src/core/request-lifetime.ts',
        'src/network/system-audio-sfu.ts',
        'src/network/pro-system-audio-sfu.ts',
        'src/audio/system-capture.ts',
        'src/pro-room/api.ts',
        'src/pro-room/media-transfer.ts',
        'src/pro-room/runtime.ts',
        'src/pro-room/playlist-state-manager.ts',
        'src/player/transport.ts',
        'src/player/local-output-rejoin.ts',
        'src/audio/context-recovery.ts',
        'src/storage/preload.ts',
        'src/network/transport/cloudflare-signaling.ts',
        'src/youtube/oembed.ts',
        'src/account/api.ts',
        'src/account/session.ts',
        'src/ui/announcement.ts',
        'src/share/r2-client.ts',
      ],
      exclude: ['src/**/__tests__/**'],
      thresholds: {
        // Initial measured baseline (2026-07-22): statements 69.62,
        // branches 61.33, functions 77.09, lines 74.21. Keep a small amount
        // of instrumentation variance while preventing silent regression.
        statements: 68,
        branches: 60,
        functions: 75,
        lines: 72,
        // Aggregate coverage can hide a regression in one hotspot behind an
        // improvement in another. These independent file floors sit roughly
        // one percentage point below the 2026-08-08 Node 24 baseline.
        'src/account/api.ts': {
          statements: 85,
          branches: 82,
          functions: 93,
          lines: 86,
        },
        'src/account/session.ts': {
          statements: 83,
          branches: 68,
          functions: 67,
          lines: 88,
        },
        'src/audio/context-recovery.ts': {
          statements: 84,
          branches: 78,
          functions: 91,
          lines: 92,
        },
        'src/audio/system-capture.ts': {
          statements: 74,
          branches: 73,
          functions: 53,
          lines: 79,
        },
        'src/core/capability.ts': {
          statements: 77,
          branches: 68,
          functions: 77,
          lines: 81,
        },
        'src/core/request-lifetime.ts': {
          statements: 86,
          branches: 74,
          functions: 86,
          lines: 92,
        },
        'src/network/pro-system-audio-sfu.ts': {
          statements: 73,
          branches: 54,
          functions: 80,
          lines: 79,
        },
        'src/network/system-audio-sfu.ts': {
          statements: 74,
          branches: 59,
          functions: 80,
          lines: 80,
        },
        'src/network/transport/cloudflare-signaling.ts': {
          statements: 69,
          branches: 68,
          functions: 70,
          lines: 75,
        },
        'src/player/local-output-rejoin.ts': {
          statements: 75,
          branches: 67,
          functions: 88,
          lines: 79,
        },
        'src/player/transport.ts': {
          statements: 57,
          branches: 51,
          functions: 77,
          lines: 60,
        },
        'src/pro-room/api.ts': {
          statements: 81,
          branches: 77,
          functions: 94,
          lines: 85,
        },
        'src/pro-room/media-transfer.ts': {
          statements: 83,
          branches: 79,
          functions: 86,
          lines: 85,
        },
        'src/pro-room/playlist-state-manager.ts': {
          statements: 87,
          branches: 80,
          functions: 97,
          lines: 89,
        },
        'src/pro-room/runtime.ts': {
          statements: 64,
          branches: 55,
          functions: 67,
          lines: 68,
        },
        'src/share/r2-client.ts': {
          statements: 64,
          branches: 56,
          functions: 65,
          lines: 71,
        },
        'src/storage/preload.ts': {
          statements: 67,
          branches: 57,
          functions: 84,
          lines: 70,
        },
        'src/ui/announcement.ts': {
          statements: 85,
          branches: 79,
          functions: 99,
          lines: 93,
        },
        'src/youtube/oembed.ts': {
          statements: 66,
          branches: 53,
          functions: 91,
          lines: 69,
        },
      },
    },
  },
});
