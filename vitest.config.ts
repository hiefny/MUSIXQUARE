import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 15000,
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/types/**',
        'src/vite-env.d.ts',
        // Bootstrap and service-worker registration are browser-only entry points.
        'src/app.ts',
        'src/sw-register.ts',
        // Capability tokens are covered through Worker/API tests and real fetch/browser flows.
        'src/core/capability.ts',
        // Audio engine and capture code require Web Audio / capture APIs.
        'src/audio/engine.ts',
        'src/audio/effects.ts',
        'src/audio/channel.ts',
        'src/audio/helpers.ts',
        'src/audio/context.ts',
        'src/audio/system-capture.ts',
        // Demo orchestration is browser/runtime-heavy; focused specs still run.
        'src/demo/mode.ts',
        'src/demo/tracks.ts',
        // WebRTC networking requires PeerJS / RTCPeerConnection / DataConnection.
        'src/network/peer.ts',
        'src/network/relay.ts',
        'src/network/host.ts',
        'src/network/guest.ts',
        'src/network/orchestrator.ts',
        'src/network/peer-state.ts',
        'src/network/protocol.ts',
        'src/network/shared-clock.ts',
        'src/network/sync.ts',
        'src/network/system-audio-host.ts',
        'src/network/system-audio-guest.ts',
        'src/network/system-audio-sfu.ts',
        'src/network/system-audio-debug.ts',
        'src/network/webrtc-audio-decoder-primer.ts',
        // Transport adapters depend on browser WebSocket/WebRTC and Cloudflare behavior.
        'src/network/transport/**',
        // Remote object storage depends on WebCrypto, fetch, and R2-style HTTP semantics.
        'src/share/**',
        // Storage is heavy DataConnection / RAM-store / bus event state.
        'src/storage/transfer.ts',
        'src/storage/transfer-send.ts',
        'src/storage/transfer-receive.ts',
        'src/storage/preload.ts',
        'src/storage/storage.ts',
        'src/storage/recovery.ts',
        // Player depends on AudioContext / AudioBufferSourceNode.
        'src/player/playback.ts',
        'src/player/playlist.ts',
        'src/player/decode.ts',
        'src/player/transport.ts',
        'src/player/video.ts',
        // YouTube requires IFrame API / iframe state.
        'src/youtube/player.ts',
        'src/youtube/iframe.ts',
        'src/youtube/handlers.ts',
        'src/youtube/sync.ts',
        'src/youtube/search.ts',
        'src/youtube/_state.ts',
        // Chat uses DOM rendering + DataConnection.
        'src/chat/commands.ts',
        'src/chat/protocol.ts',
        // Dedicated-worker globals are not instrumented by the Node coverage harness.
        'src/workers/sync.worker.ts',
        'src/workers/transfer.worker.ts',
        // Platform module-scope constants depend on navigator.
        'src/core/platform.ts',
        // Heavy DOM UI modules are coupled to browser rendering and interaction timing.
        'src/ui/setup.ts',
        'src/ui/setup-host.ts',
        'src/ui/setup-guest.ts',
        'src/ui/setup-shared.ts',
        'src/ui/player-controls.ts',
        'src/ui/visualizer.ts',
        'src/ui/playlist-view.ts',
        'src/ui/chat.ts',
        'src/ui/chat-render.ts',
        'src/ui/connect.ts',
        'src/ui/copy-email.ts',
        'src/ui/custom-scrollbar.ts',
        'src/ui/dialog.ts',
        'src/ui/dom.ts',
        'src/ui/large-room-warnings.ts',
        'src/ui/range-drag.ts',
        'src/ui/seekbar.ts',
        'src/ui/settings.ts',
        'src/ui/tabs.ts',
        'src/ui/theme-chrome.ts',
        // Test-only / dev infrastructure.
        'src/core/session-scope.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 45,
        statements: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
