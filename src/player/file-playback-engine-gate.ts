import { FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED } from './file-playback-production-release-latch.ts';

type FilePlaybackEngineMode = 'legacy' | 'v2';

function readBuildEnvironment(): {
  readonly dev: boolean;
  readonly prod: boolean;
  readonly mode: unknown;
  readonly v2ProductionFlag: boolean;
  readonly universalV1ProductionFlag: boolean;
} {
  try {
    const environment = import.meta.env as Record<string, unknown> | undefined;
    return {
      dev: environment?.DEV === true,
      prod: environment?.PROD === true,
      mode: environment?.MODE,
      v2ProductionFlag: environment?.VITE_MUSIXQUARE_FILE_ENGINE_V2 === '1',
      universalV1ProductionFlag: environment?.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1 === '1',
    };
  } catch {
    return {
      dev: false,
      prod: false,
      mode: undefined,
      v2ProductionFlag: false,
      universalV1ProductionFlag: false,
    };
  }
}

function hasExactDevelopmentOptIn(): boolean {
  try {
    const search = globalThis.location?.search;
    if (typeof search !== 'string') return false;

    const values = new URLSearchParams(search).getAll('fileEngineV2');
    return values.length === 1 && values[0] === '1';
  } catch {
    return false;
  }
}

function resolveFilePlaybackEngineMode(): FilePlaybackEngineMode {
  const environment = readBuildEnvironment();

  // Ambiguous build modes fail closed. Development gets a URL-scoped preview
  // switch. Production additionally requires the tracked source latch, so
  // stale remote builder flags cannot change the deployed engine. The one
  // exact candidate mode is the only latch-OFF exception and requires both
  // exact flags.
  if (environment.dev === environment.prod) return 'legacy';
  if (environment.dev) return hasExactDevelopmentOptIn() ? 'v2' : 'legacy';
  if (!environment.v2ProductionFlag) return 'legacy';

  const isolatedUniversalCandidate =
    environment.mode === 'e2e-universal' && environment.universalV1ProductionFlag;
  return FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED || isolatedUniversalCandidate
    ? 'v2'
    : 'legacy';
}

const FILE_PLAYBACK_ENGINE_MODE = resolveFilePlaybackEngineMode();

export function getFilePlaybackEngineMode(): FilePlaybackEngineMode {
  return FILE_PLAYBACK_ENGINE_MODE;
}

export function isFilePlaybackEngineV2Enabled(): boolean {
  return FILE_PLAYBACK_ENGINE_MODE === 'v2';
}
