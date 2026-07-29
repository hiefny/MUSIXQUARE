import { LEGACY_BOUNDED_FILE_BETA_RELEASE_ENABLED } from './legacy-bounded-file-beta-latch.ts';

function readBuildEnvironment(): {
  readonly dev: boolean;
  readonly prod: boolean;
  readonly mode: unknown;
  readonly betaBoundedFlag: boolean;
  readonly betaArtifact: boolean;
} {
  try {
    const environment = import.meta.env as Record<string, unknown> | undefined;
    return {
      dev: environment?.DEV === true,
      prod: environment?.PROD === true,
      mode: environment?.MODE,
      betaBoundedFlag: environment?.VITE_MUSIXQUARE_LEGACY_BOUNDED === '1',
      betaArtifact:
        typeof __MXQR_LEGACY_BOUNDED_BETA_ARTIFACT__ !== 'undefined' &&
        __MXQR_LEGACY_BOUNDED_BETA_ARTIFACT__ === true,
    };
  } catch {
    return {
      dev: false,
      prod: false,
      mode: undefined,
      betaBoundedFlag: false,
      betaArtifact: false,
    };
  }
}

function hasExactDevelopmentOptIn(): boolean {
  try {
    const search = globalThis.location?.search;
    if (typeof search !== 'string') return false;

    const parameters = new URLSearchParams(search);
    const values = parameters.getAll('legacyBounded');
    const conflictingV2Values = parameters.getAll('fileEngineV2');
    return values.length === 1 && values[0] === '1' && conflictingV2Values.length === 0;
  } catch {
    return false;
  }
}

function resolveLegacyBoundedFileEnabled(): boolean {
  const environment = readBuildEnvironment();

  // Unavailable or contradictory Vite modes fail closed. Development has one
  // URL-scoped preview switch. Built artifacts ignore URL state and require
  // all three independent beta release conditions.
  if (environment.dev === environment.prod) return false;
  if (environment.dev) return hasExactDevelopmentOptIn();

  return (
    environment.mode === 'beta-bounded' &&
    environment.betaBoundedFlag &&
    environment.betaArtifact &&
    LEGACY_BOUNDED_FILE_BETA_RELEASE_ENABLED
  );
}

const LEGACY_BOUNDED_FILE_ENABLED = resolveLegacyBoundedFileEnabled();

/**
 * Returns the immutable bootstrap decision for the beta bounded file renderer.
 */
export function isLegacyBoundedFileEnabled(): boolean {
  return LEGACY_BOUNDED_FILE_ENABLED;
}
