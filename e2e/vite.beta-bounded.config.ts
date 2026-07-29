import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import baseConfig from '../vite.config.ts';

const APP_ENTRY_MODULE = '/src/app.ts';
const BETA_BOUNDED_OUT_DIR = resolve(__dirname, '../.vite/beta-bounded');
const BETA_BOUNDED_ARTIFACT_DEFINE = '__MXQR_LEGACY_BOUNDED_BETA_ARTIFACT__';
const BETA_BOUNDED_ARTIFACT_MARKER = '__MXQR_BETA_BOUNDED_GATE_TRUE_V2_FALSE__';
const BETA_GATE_IMPORT =
  "import { isLegacyBoundedFileEnabled as isBetaBoundedFileEnabled } from './player/legacy-bounded-file-gate.ts';";
const V2_GATE_IMPORT =
  "import { isFilePlaybackEngineV2Enabled as isExistingFilePlaybackV2Enabled } from './player/file-playback-engine-gate.ts';";
const BETA_GATE_INVARIANT = `const betaBoundedFileGateEnabled = isBetaBoundedFileEnabled();
const existingFilePlaybackV2Enabled = isExistingFilePlaybackV2Enabled();
if (!betaBoundedFileGateEnabled || existingFilePlaybackV2Enabled) {
  throw new Error('${BETA_BOUNDED_ARTIFACT_MARKER}');
}`;

/**
 * Installs a beta-artifact-only bootstrap invariant without adding a product
 * debug global or editing the production entry source. The marker remains in
 * the generated JavaScript as static evidence that the exact gate assertion
 * survived bundling.
 */
function installBetaBoundedGateInvariant(): Plugin {
  let transformedEntries = 0;

  return {
    name: 'install-beta-bounded-gate-invariant',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      if (config.mode !== 'beta-bounded') {
        throw new Error(
          `Beta bounded config requires exact beta-bounded mode, received ${config.mode}`,
        );
      }
      if (
        config.define?.[BETA_BOUNDED_ARTIFACT_DEFINE] !== 'true' ||
        config.define?.['import.meta.env.VITE_MUSIXQUARE_LEGACY_BOUNDED'] !== JSON.stringify('1') ||
        config.define?.['import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_V2'] !== JSON.stringify('0') ||
        config.define?.['import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1'] !==
          JSON.stringify('0')
      ) {
        throw new Error('Beta bounded config requires exact isolated file-engine flags');
      }
      if (
        resolve(config.root, config.build.outDir) !== BETA_BOUNDED_OUT_DIR ||
        config.build.emptyOutDir !== true
      ) {
        throw new Error('Beta bounded config requires its isolated output directory');
      }
    },
    transform(source, rawId) {
      const id = rawId.replace(/\\/g, '/').split('?', 1)[0];
      if (!id?.endsWith(APP_ENTRY_MODULE)) return null;

      transformedEntries += 1;
      return {
        code: `${BETA_GATE_IMPORT}\n${V2_GATE_IMPORT}\n${BETA_GATE_INVARIANT}\n${source}`,
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && transformedEntries !== 1) {
        throw new Error(
          `Beta bounded build transformed ${transformedEntries} app entries; expected exactly one`,
        );
      }
    },
    generateBundle(_options, bundle) {
      let markerOccurrences = 0;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        markerOccurrences += output.code.split(BETA_BOUNDED_ARTIFACT_MARKER).length - 1;
      }
      if (markerOccurrences !== 1) {
        throw new Error(
          `Beta bounded artifact contains ${markerOccurrences} gate markers; expected exactly one`,
        );
      }
    },
  };
}

export default defineConfig(
  mergeConfig(baseConfig, {
    define: {
      [BETA_BOUNDED_ARTIFACT_DEFINE]: 'true',
      'import.meta.env.VITE_MUSIXQUARE_LEGACY_BOUNDED': JSON.stringify('1'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_V2': JSON.stringify('0'),
      'import.meta.env.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1': JSON.stringify('0'),
    },
    plugins: [installBetaBoundedGateInvariant()],
    build: {
      outDir: BETA_BOUNDED_OUT_DIR,
      emptyOutDir: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4177,
      strictPort: true,
    },
  }),
);
