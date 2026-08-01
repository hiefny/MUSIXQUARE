import { defineConfig } from 'vitest/config';

/**
 * Coverage ratchet for high-risk runtime paths that the broad historical
 * report excluded. This profile complements the broad unit KPI and keeps the
 * real-time/request-lifetime modules instrumented as they evolve.
 */
export default defineConfig({
  test: {
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
      },
    },
  },
});
