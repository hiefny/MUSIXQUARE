import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../vite.config.ts';
import { installProductionBuildProfileEvidence } from './production-build-profile-evidence-plugin.ts';
import {
  LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE,
  UNIVERSAL_BUILD_PROFILE_EVIDENCE,
} from './universal-bounded/build-profile-evidence.ts';
import { FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED } from '../src/player/file-playback-production-release-latch.ts';

const PRODUCTION_LATCH_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_PRODUCTION_LATCH_ISOLATION__';
const expectedProductionProfile = FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
  ? UNIVERSAL_BUILD_PROFILE_EVIDENCE
  : LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE;

/**
 * Production-mode release decision with both remote flags forced ON. Expected
 * profile evidence follows the tracked latch, so a future approved one-line
 * latch enable (or rollback) does not require editing this validation build.
 */
export default defineConfig(
  mergeConfig(baseConfig, {
    define: {
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_V2': JSON.stringify('1'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1': JSON.stringify('1'),
    },
    plugins: [
      installProductionBuildProfileEvidence({
        label: 'production-latch',
        bridgeMarker: PRODUCTION_LATCH_BRIDGE_MARKER,
        evidence: expectedProductionProfile,
      }),
    ],
    build: {
      outDir: resolve(__dirname, '../.vite/e2e-production-latched'),
      emptyOutDir: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4176,
      strictPort: true,
    },
  }),
);
