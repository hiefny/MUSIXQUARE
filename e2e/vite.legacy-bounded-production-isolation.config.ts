import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../vite.config.ts';

/**
 * Exact normal-production bounded V1 candidate. The base Vite plugin verifies
 * the tracked bounded latch, injects the production artifact identity, and
 * refuses this build unless both retired V2 flags and its source latch are
 * OFF.
 */
export default defineConfig(
  mergeConfig(baseConfig, {
    define: {
      'import.meta.env.VITE_MUSIXQUARE_LEGACY_BOUNDED': JSON.stringify('1'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_V2': JSON.stringify('0'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1': JSON.stringify('0'),
    },
    build: {
      outDir: resolve(__dirname, '../.vite/e2e-legacy-bounded-production'),
      emptyOutDir: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4178,
      strictPort: true,
    },
  }),
);
