/**
 * Immutable playback semantics carried by the application-session handshake.
 *
 * These are not capability offers and must never be negotiated or downgraded.
 * A build selects one value for its lifetime; peers must match it exactly
 * before either side creates queue or media-source authority.
 */
export const FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID =
  'file-playback;engine=legacy;route=current;decoder=legacy-audiobuffer-v1' as const;

export const FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID =
  'file-playback;session=v2;route=current;flac=wasm-0.2.10;linear-pcm=worker-v1;other=ordinary-blob-v1' as const;

export const FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID =
  'file-playback;session=v2;route=universal-v1;flac=wasm-0.2.10;linear-pcm=worker-v1;mp3=mpg123-1.0.3;adts-aac=webcodecs-v1;m4a-aac=webcodecs-v1;semrev=s1-ZT9dUfuuM7o2UcTNbVK4qBWT0GbS573VfYeIni9CjKA' as const;

const FILE_PLAYBACK_SEMANTIC_COHORT_MAX_LENGTH = 256;

const SEMANTIC_COHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+;=:-]*$/u;

/** Wire syntax validation only. Handshakes still require exact local equality. */
export function isFilePlaybackSemanticCohortId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_SEMANTIC_COHORT_MAX_LENGTH &&
    SEMANTIC_COHORT_ID_PATTERN.test(value)
  );
}
