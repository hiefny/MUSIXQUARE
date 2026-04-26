import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: true,
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
        // Bootstrap & service-worker registration — browser-only entry points
        'src/app.ts',
        'src/sw-register.ts',
        // Audio engine / nodes — requires Web Audio AudioContext (not available in jsdom)
        'src/audio/engine.ts',
        'src/audio/effects.ts',
        'src/audio/channel.ts',
        'src/audio/helpers.ts',
        'src/audio/context.ts',
        'src/audio/beat-detector.ts',
        'src/audio/system-capture.ts',
        // WebRTC networking — requires PeerJS / RTCPeerConnection / DataConnection
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
        // Storage — heavy OPFS / Worker interop / DataConnection state
        'src/storage/transfer.ts',
        'src/storage/transfer-send.ts',
        'src/storage/transfer-receive.ts',
        'src/storage/preload.ts',
        'src/storage/opfs.ts',
        'src/storage/recovery.ts',
        // Player — depends on AudioContext / AudioBufferSourceNode
        'src/player/playback.ts',
        'src/player/playlist.ts',
        'src/player/decode.ts',
        'src/player/transport.ts',
        'src/player/video.ts',
        // YouTube — requires IFrame API / iframe state
        'src/youtube/player.ts',
        'src/youtube/iframe.ts',
        'src/youtube/handlers.ts',
        'src/youtube/sync.ts',
        'src/youtube/search.ts',
        'src/youtube/_state.ts',
        // Chat — DOM rendering + DataConnection
        'src/chat/commands.ts',
        'src/chat/protocol.ts',
        // Workers — run in dedicated Worker context, tested via mocked wrappers
        'src/workers/sync.worker.ts',
        'src/workers/transfer.worker.ts',
        // Platform — module-scope constants from navigator (tested via resetModules)
        'src/core/platform.ts',
        // Heavy DOM UI modules — deeply coupled to real browser rendering
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
        'src/ui/party-mode.ts',
        'src/ui/seekbar.ts',
        'src/ui/settings.ts',
        // Test-only / dev infrastructure
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
