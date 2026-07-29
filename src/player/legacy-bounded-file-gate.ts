import { LEGACY_BOUNDED_FILE_BETA_RELEASE_ENABLED } from './legacy-bounded-file-beta-latch.ts';
import { LEGACY_BOUNDED_FILE_PRODUCTION_RELEASE_ENABLED } from './legacy-bounded-file-production-latch.ts';

function readBuildEnvironment(): {
  readonly dev: boolean;
  readonly prod: boolean;
  readonly mode: unknown;
  readonly boundedFlag: boolean;
  readonly betaArtifact: boolean;
  readonly productionArtifact: boolean;
} {
  try {
    const environment = import.meta.env as Record<string, unknown> | undefined;
    return {
      dev: environment?.DEV === true,
      prod: environment?.PROD === true,
      mode: environment?.MODE,
      boundedFlag: environment?.VITE_MUSIXQUARE_LEGACY_BOUNDED === '1',
      betaArtifact:
        typeof __MXQR_LEGACY_BOUNDED_BETA_ARTIFACT__ !== 'undefined' &&
        __MXQR_LEGACY_BOUNDED_BETA_ARTIFACT__ === true,
      productionArtifact:
        typeof __MXQR_LEGACY_BOUNDED_PRODUCTION_ARTIFACT__ !== 'undefined' &&
        __MXQR_LEGACY_BOUNDED_PRODUCTION_ARTIFACT__ === true,
    };
  } catch {
    return {
      dev: false,
      prod: false,
      mode: undefined,
      boundedFlag: false,
      betaArtifact: false,
      productionArtifact: false,
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
  // URL-scoped preview switch. Built artifacts ignore URL state. Beta keeps
  // its isolated artifact and latch, while normal production requires its own
  // artifact identity and independently tracked release latch.
  if (environment.dev === environment.prod) return false;
  if (environment.dev) return hasExactDevelopmentOptIn();

  if (environment.mode === 'beta-bounded') {
    return (
      environment.boundedFlag &&
      environment.betaArtifact &&
      !environment.productionArtifact &&
      LEGACY_BOUNDED_FILE_BETA_RELEASE_ENABLED
    );
  }

  return (
    environment.mode === 'production' &&
    environment.boundedFlag &&
    environment.productionArtifact &&
    !environment.betaArtifact &&
    LEGACY_BOUNDED_FILE_PRODUCTION_RELEASE_ENABLED
  );
}

const LEGACY_BOUNDED_FILE_ENABLED = resolveLegacyBoundedFileEnabled();

/**
 * Returns the immutable bootstrap decision for the redesigned bounded V1
 * renderer in development, its isolated beta artifact, or normal production.
 */
export function isLegacyBoundedFileEnabled(): boolean {
  return LEGACY_BOUNDED_FILE_ENABLED;
}
