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
        // Audio engine — requires Tone.js AudioContext (not available in jsdom)
        'src/player/playback.ts',
        'src/audio/engine.ts',
        'src/audio/effects.ts',
        'src/audio/channel.ts',
        // WebRTC networking — requires PeerJS / RTCPeerConnection
        'src/network/peer.ts',
        'src/network/relay.ts',
        // Heavy DOM UI modules — deeply coupled to real browser rendering
        'src/ui/setup.ts',
        'src/ui/player-controls.ts',
        'src/ui/visualizer.ts',
        'src/ui/playlist-view.ts',
        'src/ui/chat.ts',
        // YouTube — requires IFrame API
        'src/youtube/player.ts',
        // Workers — run in dedicated Worker context, tested via mocked wrappers
        'src/workers/sync.worker.ts',
        'src/workers/transfer.worker.ts',
        // Storage — heavy OPFS / Worker interop
        'src/storage/transfer.ts',
        'src/storage/preload.ts',
        // Network sync — requires active PeerJS connections
        'src/network/sync.ts',
        // YouTube API — requires IFrame API / fetch
        'src/youtube/search.ts',
        'src/youtube/sync.ts',
        // Playlist — deeply coupled to Tone.js playback engine
        'src/player/playlist.ts',
        // Platform — module-scope constants from navigator (tested via resetModules)
        'src/core/platform.ts',
        // Settings — heavy DOM with complex UI interactions
        'src/ui/settings.ts',
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
