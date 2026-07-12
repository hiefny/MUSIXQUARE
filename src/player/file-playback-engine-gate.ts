type FilePlaybackEngineMode = 'legacy' | 'v2';

function readBuildEnvironment(): {
  readonly dev: boolean;
  readonly prod: boolean;
  readonly v2ProductionFlag: boolean;
} {
  try {
    const environment = import.meta.env as Record<string, unknown> | undefined;
    return {
      dev: environment?.DEV === true,
      prod: environment?.PROD === true,
      v2ProductionFlag: environment?.VITE_MUSIXQUARE_FILE_ENGINE_V2 === '1',
    };
  } catch {
    return { dev: false, prod: false, v2ProductionFlag: false };
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
  // switch; production gets only the build-time flag so links cannot change
  // the engine selected for a deployed application.
  if (environment.dev === environment.prod) return 'legacy';
  if (environment.dev) return hasExactDevelopmentOptIn() ? 'v2' : 'legacy';
  return environment.v2ProductionFlag ? 'v2' : 'legacy';
}

const FILE_PLAYBACK_ENGINE_MODE = resolveFilePlaybackEngineMode();

export function getFilePlaybackEngineMode(): FilePlaybackEngineMode {
  return FILE_PLAYBACK_ENGINE_MODE;
}

export function isFilePlaybackEngineV2Enabled(): boolean {
  return FILE_PLAYBACK_ENGINE_MODE === 'v2';
}
