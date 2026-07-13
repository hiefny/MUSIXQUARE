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

export type FilePlaybackBoundedRoutePolicy =
  | Readonly<CurrentFilePlaybackBoundedRoutePolicy>
  | Readonly<UniversalV1FilePlaybackBoundedRoutePolicy>;

export const FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY: Readonly<CurrentFilePlaybackBoundedRoutePolicy> =
  Object.freeze({ mode: 'current' });

export const FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY: Readonly<UniversalV1FilePlaybackBoundedRoutePolicy> =
  Object.freeze({
    mode: 'universal-v1',
    aacBackendId: 'webcodecs',
    m4aBackendId: 'webcodecs',
  });

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
 * Normalize the optional product routing policy to one of two canonical values.
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
  throw new TypeError('File playback bounded route policy mode is not supported');
}
