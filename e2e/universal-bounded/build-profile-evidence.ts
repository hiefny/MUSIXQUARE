import {
  FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
} from '../../src/player/file-playback-semantic-cohort.ts';

interface FilePlaybackBuildProfileEvidence {
  readonly profileId: 'legacy-current' | 'v2-current' | 'v2-universal-v1';
  readonly engine: 'legacy' | 'v2';
  readonly policyMode: 'current' | 'universal-v1';
  readonly hasBoundedRoutePolicy: boolean;
  readonly semanticPlaybackCohortId: string;
  readonly artifactMarker: string;
}

function evidence(
  profileId: FilePlaybackBuildProfileEvidence['profileId'],
  engine: FilePlaybackBuildProfileEvidence['engine'],
  policyMode: FilePlaybackBuildProfileEvidence['policyMode'],
  hasBoundedRoutePolicy: boolean,
  semanticPlaybackCohortId: string,
): Readonly<FilePlaybackBuildProfileEvidence> {
  return Object.freeze({
    profileId,
    engine,
    policyMode,
    hasBoundedRoutePolicy,
    semanticPlaybackCohortId,
    artifactMarker: `musixquare:e2e-build-profile:${profileId}:${semanticPlaybackCohortId}`,
  });
}

export const UNIVERSAL_BUILD_PROFILE_EVIDENCE = evidence(
  'v2-universal-v1',
  'v2',
  'universal-v1',
  true,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
);

export const V2_CURRENT_BUILD_PROFILE_EVIDENCE = evidence(
  'v2-current',
  'v2',
  'current',
  false,
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
);

export const LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE = evidence(
  'legacy-current',
  'legacy',
  'current',
  false,
  FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID,
);
