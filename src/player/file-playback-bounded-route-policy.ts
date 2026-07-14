export interface CurrentFilePlaybackBoundedRoutePolicy {
  readonly mode: 'current';
}

export interface UniversalV1FilePlaybackBoundedRoutePolicy {
  readonly mode: 'universal-v1';
  /** Raw ADTS AAC is admitted only into the native WebCodecs cohort. */
  readonly aacBackendId: 'webcodecs';
  /** The only M4A cohort admitted by this opt-in checkpoint. */
  readonly m4aBackendId: 'webcodecs';
}

/**
 * Independently gated codecs layered on top of the always-bounded native
 * FLAC and linear-PCM routes. A `current` gate preserves the pre-universal
 * behavior for that exact format: ordinary Blob decode locally and no
 * generic encoded-source route.
 */
export interface FormatGatedV1FilePlaybackBoundedRoutePolicy {
  readonly mode: 'format-gated-v1';
  readonly mp3: 'current' | 'bounded-stream';
  readonly m4aAacLc: 'current' | 'webcodecs';
  readonly rawAdtsAac: 'current' | 'webcodecs';
}

export type FilePlaybackBoundedRoutePolicy =
  | Readonly<CurrentFilePlaybackBoundedRoutePolicy>
  | Readonly<UniversalV1FilePlaybackBoundedRoutePolicy>
  | Readonly<FormatGatedV1FilePlaybackBoundedRoutePolicy>;

/** Codec identities currently carried by the authenticated peer manifest lane. */
export type FilePlaybackPeerRangeManifestCodec = 'adts-aac-lc' | 'mp3-no-frame-count';

export const FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY: Readonly<CurrentFilePlaybackBoundedRoutePolicy> =
  Object.freeze({ mode: 'current' });

export const FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY: Readonly<UniversalV1FilePlaybackBoundedRoutePolicy> =
  Object.freeze({
    mode: 'universal-v1',
    aacBackendId: 'webcodecs',
    m4aBackendId: 'webcodecs',
  });

const FORMAT_GATED_V1_KEYS = Object.freeze(['mode', 'mp3', 'm4aAacLc', 'rawAdtsAac'] as const);

const MP3_GATES = Object.freeze(['current', 'bounded-stream'] as const);
const M4A_AAC_LC_GATES = Object.freeze(['current', 'webcodecs'] as const);
const RAW_ADTS_AAC_GATES = Object.freeze(['current', 'webcodecs'] as const);

const FORMAT_GATED_V1_POLICIES: readonly Readonly<FormatGatedV1FilePlaybackBoundedRoutePolicy>[] =
  Object.freeze(
    MP3_GATES.flatMap((mp3) =>
      M4A_AAC_LC_GATES.flatMap((m4aAacLc) =>
        RAW_ADTS_AAC_GATES.map((rawAdtsAac) =>
          Object.freeze({ mode: 'format-gated-v1' as const, mp3, m4aAacLc, rawAdtsAac }),
        ),
      ),
    ),
  );

function canonicalFormatGatedV1Policy(
  mp3: FormatGatedV1FilePlaybackBoundedRoutePolicy['mp3'],
  m4aAacLc: FormatGatedV1FilePlaybackBoundedRoutePolicy['m4aAacLc'],
  rawAdtsAac: FormatGatedV1FilePlaybackBoundedRoutePolicy['rawAdtsAac'],
): Readonly<FormatGatedV1FilePlaybackBoundedRoutePolicy> {
  const policy = FORMAT_GATED_V1_POLICIES.find(
    (candidate) =>
      candidate.mp3 === mp3 &&
      candidate.m4aAacLc === m4aAacLc &&
      candidate.rawAdtsAac === rawAdtsAac,
  );
  if (!policy) throw new TypeError('Format-gated-v1 policy combination is not supported');
  return policy;
}

/**
 * Candidate release cohort: bounded MP3 and M4A AAC-LC, with raw ADTS AAC
 * deliberately left on today's route until the long-remote-file manifest
 * sidecar can remove its mandatory full-file admission scan.
 *
 * This constant is intentionally not installed in the product singleton.
 */
export const FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY: Readonly<FormatGatedV1FilePlaybackBoundedRoutePolicy> =
  canonicalFormatGatedV1Policy('bounded-stream', 'webcodecs', 'current');

const CURRENT_KEYS = Object.freeze(['mode'] as const);
const UNIVERSAL_V1_KEYS = Object.freeze(['mode', 'aacBackendId', 'm4aBackendId'] as const);

type PolicyRecord = Readonly<Record<string, unknown>>;

function snapshotExactDataRecord(value: unknown): PolicyRecord {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('File playback bounded route policy must be an exact plain record');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('File playback bounded route policy must be an exact plain record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new TypeError('File playback bounded route policy cannot contain symbol fields');
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(
          'File playback bounded route policy fields must be own enumerable data',
        );
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('File playback bounded route policy could not be inspected', {
      cause: error,
    });
  }
}

function hasExactKeys(record: PolicyRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

/**
 * Normalize the optional product routing policy to a canonical frozen value.
 * Undefined deliberately preserves today's routing; every explicit value must
 * be an exact data-only record before its discriminant is interpreted.
 */
export function snapshotFilePlaybackBoundedRoutePolicy(
  value: unknown = undefined,
): Readonly<FilePlaybackBoundedRoutePolicy> {
  if (value === undefined) return FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY;

  const record = snapshotExactDataRecord(value);
  if (record.mode === 'current') {
    if (!hasExactKeys(record, CURRENT_KEYS)) {
      throw new TypeError('Current file playback bounded route policy has unexpected fields');
    }
    return FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY;
  }
  if (record.mode === 'universal-v1') {
    if (!hasExactKeys(record, UNIVERSAL_V1_KEYS)) {
      throw new TypeError('Universal-v1 file playback bounded route policy has invalid fields');
    }
    if (record.aacBackendId !== 'webcodecs') {
      throw new TypeError('Universal-v1 raw AAC backend must be exactly webcodecs');
    }
    if (record.m4aBackendId !== 'webcodecs') {
      throw new TypeError('Universal-v1 M4A backend must be exactly webcodecs');
    }
    return FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY;
  }
  if (record.mode === 'format-gated-v1') {
    if (!hasExactKeys(record, FORMAT_GATED_V1_KEYS)) {
      throw new TypeError('Format-gated-v1 file playback bounded route policy has invalid fields');
    }
    if (record.mp3 !== 'current' && record.mp3 !== 'bounded-stream') {
      throw new TypeError('Format-gated-v1 MP3 route is not supported');
    }
    if (record.m4aAacLc !== 'current' && record.m4aAacLc !== 'webcodecs') {
      throw new TypeError('Format-gated-v1 M4A AAC-LC route is not supported');
    }
    if (record.rawAdtsAac !== 'current' && record.rawAdtsAac !== 'webcodecs') {
      throw new TypeError('Format-gated-v1 raw ADTS AAC route is not supported');
    }
    return canonicalFormatGatedV1Policy(record.mp3, record.m4aAacLc, record.rawAdtsAac);
  }
  throw new TypeError('File playback bounded route policy mode is not supported');
}

/**
 * Keep host offer selection and guest decoder admission on one fail-closed
 * policy decision. The manifest transport is not an independent codec gate:
 * it may carry only a codec already enabled by the canonical bounded route.
 */
export function isFilePlaybackPeerRangeManifestCodecEnabled(
  policyValue: unknown,
  codec: unknown,
): codec is FilePlaybackPeerRangeManifestCodec {
  if (codec !== 'adts-aac-lc' && codec !== 'mp3-no-frame-count') return false;
  const policy = snapshotFilePlaybackBoundedRoutePolicy(policyValue);
  if (policy.mode === 'current') return false;
  if (policy.mode === 'universal-v1') return true;
  return codec === 'adts-aac-lc'
    ? policy.rawAdtsAac === 'webcodecs'
    : policy.mp3 === 'bounded-stream';
}
