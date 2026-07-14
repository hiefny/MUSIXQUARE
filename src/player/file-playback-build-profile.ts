import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import {
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import {
  FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
} from './file-playback-semantic-cohort.ts';

type FilePlaybackBuildProfileId = 'legacy-current' | 'v2-current' | 'v2-universal-v1';

interface FilePlaybackBuildProfile {
  readonly id: FilePlaybackBuildProfileId;
  readonly engine: 'legacy' | 'v2';
  readonly boundedRouteMode: 'current' | 'universal-v1';
  /** Null preserves the product's established omitted-policy/current behavior. */
  readonly boundedRoutePolicy: Readonly<FilePlaybackBoundedRoutePolicy> | null;
  readonly semanticPlaybackCohortId: string;
}

const LEGACY_CURRENT_PROFILE: Readonly<FilePlaybackBuildProfile> = Object.freeze({
  id: 'legacy-current',
  engine: 'legacy',
  boundedRouteMode: 'current',
  boundedRoutePolicy: null,
  semanticPlaybackCohortId: FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID,
});

const V2_CURRENT_PROFILE: Readonly<FilePlaybackBuildProfile> = Object.freeze({
  id: 'v2-current',
  engine: 'v2',
  boundedRouteMode: 'current',
  boundedRoutePolicy: null,
  semanticPlaybackCohortId: FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
});

const V2_UNIVERSAL_V1_PROFILE: Readonly<FilePlaybackBuildProfile> = Object.freeze({
  id: 'v2-universal-v1',
  engine: 'v2',
  boundedRouteMode: 'universal-v1',
  boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  semanticPlaybackCohortId: FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
});

function universalV1BuildEnabled(): boolean {
  try {
    const environment = import.meta.env as Record<string, unknown> | undefined;
    return environment?.VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1 === '1';
  } catch {
    return false;
  }
}

function resolveFilePlaybackBuildProfile(): Readonly<FilePlaybackBuildProfile> {
  if (!isFilePlaybackEngineV2Enabled()) return LEGACY_CURRENT_PROFILE;
  return universalV1BuildEnabled() ? V2_UNIVERSAL_V1_PROFILE : V2_CURRENT_PROFILE;
}

// Selected exactly once per document/build. Runtime capability probes may
// reject a codec, but they may not mutate this semantic identity or fall back.
const FILE_PLAYBACK_BUILD_PROFILE = resolveFilePlaybackBuildProfile();

export function getFilePlaybackBuildProfile(): Readonly<FilePlaybackBuildProfile> {
  return FILE_PLAYBACK_BUILD_PROFILE;
}
