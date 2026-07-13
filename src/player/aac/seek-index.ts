export interface AdtsSeekIndexPoint {
  /** Zero-based ordinal of a scanner-verified ADTS access unit. */
  readonly frameOrdinal: number;
  /** Absolute byte offset of that access unit's verified ADTS sync word. */
  readonly byteOffset: number;
}

export interface AdtsSeekIndexOptions {
  readonly maxPoints?: number;
}

/** Default and absolute storage bound for retained ADTS seek points. */
export const ADTS_SEEK_INDEX_MAX_POINTS = 8_192;

const ADTS_SEEK_INDEX_MIN_POINTS = 2;
const COMPACTION_TARGET_NUMERATOR = 3;
const COMPACTION_TARGET_DENOMINATOR = 4;
const POINT_KEYS = Object.freeze(['frameOrdinal', 'byteOffset'] as const);
const POINT_KEY_SET: ReadonlySet<PropertyKey> = new Set(POINT_KEYS);
const OPTIONS_KEY_SET: ReadonlySet<PropertyKey> = new Set(['maxPoints']);

interface ExactDataSnapshot {
  readonly [key: string]: unknown;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read one exact data-only record without invoking application accessors.
 *
 * Proxy reflection traps may run, but they are contained to this snapshot
 * phase. Any trap failure, accessor, extra key, or missing key fails closed.
 */
function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  expectedKeySet: ReadonlySet<PropertyKey>,
): ExactDataSnapshot | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;

  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => !expectedKeySet.has(key))) {
      return null;
    }

    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function canonicalPoint(frameOrdinal: number, byteOffset: number): AdtsSeekIndexPoint {
  return Object.freeze({ frameOrdinal, byteOffset });
}

function snapshotPoint(value: unknown): AdtsSeekIndexPoint | null {
  const snapshot = snapshotExactDataRecord(value, POINT_KEYS, POINT_KEY_SET);
  if (
    !snapshot ||
    !isNonNegativeSafeInteger(snapshot.frameOrdinal) ||
    !isNonNegativeSafeInteger(snapshot.byteOffset)
  ) {
    return null;
  }
  return canonicalPoint(snapshot.frameOrdinal, snapshot.byteOffset);
}

function snapshotMaxPoints(value: unknown): number {
  if (value === undefined) return ADTS_SEEK_INDEX_MAX_POINTS;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('ADTS seek index options must be an exact data-only record');
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('ADTS seek index options could not be snapshotted', { cause: error });
  }

  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length > 1 || ownKeys.some((key) => !OPTIONS_KEY_SET.has(key))) {
    throw new TypeError('ADTS seek index options must contain only maxPoints');
  }

  const descriptor = descriptors.maxPoints;
  if (!descriptor) return ADTS_SEEK_INDEX_MAX_POINTS;
  if (!('value' in descriptor)) {
    throw new TypeError('ADTS seek index maxPoints must be a data property');
  }

  const maxPoints = descriptor.value;
  if (
    typeof maxPoints !== 'number' ||
    !Number.isSafeInteger(maxPoints) ||
    maxPoints < ADTS_SEEK_INDEX_MIN_POINTS ||
    maxPoints > ADTS_SEEK_INDEX_MAX_POINTS
  ) {
    throw new RangeError(
      `ADTS seek index maxPoints must be between ${ADTS_SEEK_INDEX_MIN_POINTS} and ${ADTS_SEEK_INDEX_MAX_POINTS}`,
    );
  }
  return maxPoints;
}

function nextSafeStride(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (current > Math.floor(Number.MAX_SAFE_INTEGER / 2)) return Number.MAX_SAFE_INTEGER;
  return current * 2;
}

/**
 * Bounded sparse index of scanner-verified ADTS access-unit boundaries.
 *
 * This index deliberately knows nothing about decoded samples, core/output
 * rates, channels, SBR, PS, priming, or seek pre-roll. It records only exact
 * encoded coordinates supplied by a sequential scanner. Points are append-only
 * and strictly monotonic in both coordinates.
 *
 * When full, the index increases a deterministic ordinal stride and discards
 * non-stride historical points. Frame zero and the latest verified point are
 * always retained. No encoded media bytes are retained.
 */
export class AdtsSeekIndex {
  readonly origin: AdtsSeekIndexPoint;

  readonly #maxPoints: number;
  #points: AdtsSeekIndexPoint[];
  #compactionStride = 1;

  constructor(origin: AdtsSeekIndexPoint, options?: AdtsSeekIndexOptions);
  constructor(origin: unknown, options?: unknown) {
    const canonicalOrigin = snapshotPoint(origin);
    if (!canonicalOrigin || canonicalOrigin.frameOrdinal !== 0) {
      throw new RangeError('ADTS seek index origin must be exact frame ordinal zero');
    }

    this.#maxPoints = snapshotMaxPoints(options);
    this.origin = canonicalOrigin;
    this.#points = [canonicalOrigin];
  }

  get size(): number {
    return this.#points.length;
  }

  get maxPoints(): number {
    return this.#maxPoints;
  }

  /** Current deterministic historical-retention stride. */
  get compactionStride(): number {
    return this.#compactionStride;
  }

  /** Most recently appended scanner-verified access unit. */
  get latestVerified(): AdtsSeekIndexPoint {
    const latest = this.#points.at(-1);
    if (!latest) throw new Error('ADTS seek index lost its origin point');
    return latest;
  }

  /**
   * Append one scanner-verified access-unit boundary.
   *
   * Malformed, duplicate, rewound, and coordinate-conflicting inputs are
   * rejected without mutating the index.
   */
  appendVerified(point: AdtsSeekIndexPoint): boolean;
  appendVerified(point: unknown): boolean {
    // Canonicalize before consulting mutable index state. A re-entrant Proxy
    // can append during reflection, but the outer operation will then compare
    // against that newer tail and cannot roll the index backward.
    const candidate = snapshotPoint(point);
    if (!candidate) return false;

    const latest = this.latestVerified;
    if (
      candidate.frameOrdinal <= latest.frameOrdinal ||
      candidate.byteOffset <= latest.byteOffset
    ) {
      return false;
    }

    this.#points.push(candidate);
    this.#compactIfNeeded();
    return true;
  }

  /** Exact retained point at or before the requested access-unit ordinal. */
  floorAnchor(frameOrdinal: number): AdtsSeekIndexPoint {
    if (!isNonNegativeSafeInteger(frameOrdinal)) {
      throw new RangeError('ADTS floor anchor ordinal must be a non-negative safe integer');
    }

    let low = 0;
    let high = this.#points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const point = this.#points[middle];
      if (point && point.frameOrdinal <= frameOrdinal) low = middle + 1;
      else high = middle;
    }

    const anchor = this.#points[Math.max(0, low - 1)];
    if (!anchor) throw new Error('ADTS seek index lost its origin point');
    return anchor;
  }

  /** Detached, exact-shape, deeply immutable coordinate snapshot. */
  snapshot(): readonly AdtsSeekIndexPoint[] {
    return Object.freeze(
      this.#points.map((point) => canonicalPoint(point.frameOrdinal, point.byteOffset)),
    );
  }

  #compactIfNeeded(): void {
    while (this.#points.length > this.#maxPoints) {
      // Keep headroom so a saturated historical grid cannot make every new
      // append rescan maxPoints entries. Re-apply the current stride first:
      // freshly appended tail points may be enough to discard without making
      // the long-term historical grid coarser.
      const targetSize = Math.max(
        ADTS_SEEK_INDEX_MIN_POINTS,
        Math.floor((this.#maxPoints * COMPACTION_TARGET_NUMERATOR) / COMPACTION_TARGET_DENOMINATOR),
      );
      let stride = this.#compactionStride;
      let compacted = this.#retainedAtStride(stride);

      while (compacted.length > targetSize) {
        const nextStride = nextSafeStride(stride);
        if (nextStride === stride) {
          // With origin zero, strictly increasing safe ordinals, and the
          // latest point protected separately, MAX_SAFE_INTEGER can retain at
          // most those two points. Reaching this branch would mean an internal
          // invariant was broken; never spin indefinitely.
          throw new Error('ADTS seek index could not compact within its configured bound');
        }
        stride = nextStride;
        compacted = this.#retainedAtStride(stride);
      }

      this.#compactionStride = stride;
      this.#points = compacted;
    }
  }

  #retainedAtStride(stride: number): AdtsSeekIndexPoint[] {
    const latest = this.latestVerified;
    const retained: AdtsSeekIndexPoint[] = [this.origin];

    for (let index = 1; index < this.#points.length - 1; index += 1) {
      const point = this.#points[index];
      if (point && point.frameOrdinal % stride === 0) retained.push(point);
    }
    if (latest !== this.origin) retained.push(latest);
    return retained;
  }
}
