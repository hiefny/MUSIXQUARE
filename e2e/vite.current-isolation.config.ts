import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../vite.config.ts';
import { installProductionBuildProfileEvidence } from './production-build-profile-evidence-plugin.ts';
import {
  LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE,
  V2_CURRENT_BUILD_PROFILE_EVIDENCE,
} from './universal-bounded/build-profile-evidence.ts';
import { FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED } from '../src/player/file-playback-production-release-latch.ts';

const CURRENT_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_CURRENT_ISOLATION__';
const expectedCurrentControlProfile = FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
  ? V2_CURRENT_BUILD_PROFILE_EVIDENCE
  : LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE;

/**
 * Production-mode current-route control. The universal flag is explicitly
 * OFF, so the artifact is legacy/current with the latch OFF and V2/current
 * only after the same tracked latch turns ON.
 */
export default defineConfig(
  mergeConfig(baseConfig, {
    define: {
      'import.meta.env.VITE_MUSIXQUARE_LEGACY_BOUNDED': JSON.stringify('0'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_V2': JSON.stringify('1'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1': JSON.stringify('0'),
    },
    plugins: [
      installProductionBuildProfileEvidence({
        label: 'production-current',
        bridgeMarker: CURRENT_BRIDGE_MARKER,
        evidence: expectedCurrentControlProfile,
      }),
    ],
    build: {
      outDir: resolve(__dirname, '../.vite/e2e-current'),
      emptyOutDir: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true,
    },
  }),
);
