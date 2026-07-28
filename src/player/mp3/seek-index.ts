export interface MpegLayer3SeekIndexPoint {
  /** Absolute decoder-domain sample at the start of this MPEG frame. */
  readonly rawSample: number;
  /** Absolute byte offset of the verified MPEG frame sync. */
  readonly byteOffset: number;
  /** Zero-based ordinal of this MPEG frame in the audio span. */
  readonly frameOrdinal: number;
  /** Exact main-data capacity reported by this verified frame header. */
  readonly mainDataCapacityBytes: number;
  /** Exact Layer III `main_data_begin` value reported by this frame. */
  readonly mainDataBeginBytes: number;
}

export interface MpegLayer3SeekBracket {
  readonly before: MpegLayer3SeekIndexPoint;
  /** Null means that no later verified frame boundary is currently indexed. */
  readonly after: MpegLayer3SeekIndexPoint | null;
}

export interface MpegLayer3VerifiedReservoirPrelude {
  readonly kind: 'verified-history';
  readonly target: MpegLayer3SeekIndexPoint;
  readonly minimumWarmupFrames: number;
  /** First decoded frame in the warmup span (or target when warmup is zero). */
  readonly warmupStart: MpegLayer3SeekIndexPoint;
  readonly warmupStartMainDataBeginBytes: number;
  /** Chronological verified descriptors, oldest first; target is excluded. */
  readonly previousFrames: readonly MpegLayer3SeekIndexPoint[];
  /** Capacity accumulated only from frames preceding `warmupStart`. */
  readonly reservoirCapacityBeforeWarmupBytes: number;
  /** True when the returned history reaches frame zero. */
  readonly reachedAudioOrigin: boolean;
}

export interface MpegLayer3ReservoirScanPrelude {
  readonly kind: 'scan-from-anchor';
  readonly targetRawSample: number;
  readonly targetFrameOrdinal: number;
  /** Exact frame boundary from which a scanner can walk to the target. */
  readonly anchor: MpegLayer3SeekIndexPoint;
  readonly minimumWarmupFrames: number;
  readonly warmupFrameLimit: number;
  readonly reservoirFrameLimit: number;
  /** Conservative bounded history window a sequential scanner must retain. */
  readonly historyFrameLimit: number;
}

export type MpegLayer3ReservoirPrelude =
  | MpegLayer3VerifiedReservoirPrelude
  | MpegLayer3ReservoirScanPrelude;

export interface MpegLayer3SeekIndexOptions {
  /** Complete encoded source size, including metadata outside the audio span. */
  readonly sourceSize: number;
  /** Absolute offset of frame ordinal zero. */
  readonly firstAudioFrameOffset: number;
  /** Exclusive end of the contiguous MPEG Layer III audio span. */
  readonly audioEndByteOffset: number;
  /** Decoder-domain samples, before encoder delay or end-padding trimming. */
  readonly totalRawSamples: number;
  /** Fixed by the MPEG version: 1,152 for MPEG-1 or 576 for MPEG-2/2.5. */
  readonly samplesPerFrame: 576 | 1_152;
  /** Exact capacity from the already verified frame-zero header. */
  readonly firstFrameMainDataCapacityBytes: number;
  /** Must be zero for a valid Layer III audio origin. */
  readonly firstFrameMainDataBeginBytes: number;
  readonly maxPoints?: number;
}

export const MP3_SEEK_INDEX_MAX_POINTS = 8_192;
export const MP3_SEEK_MAX_RESERVOIR_HISTORY_FRAMES = 511;
export const MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES = 511;
export const MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES =
  MP3_SEEK_MAX_RESERVOIR_HISTORY_FRAMES + MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES;

const DEFAULT_MAX_POINTS = MP3_SEEK_INDEX_MAX_POINTS;
const MINIMUM_MAX_POINTS = 1_024;
const DEFAULT_SYNTHESIS_WARMUP_FRAMES = 16;
const MAX_LAYER_3_FRAME_BYTES = 1_441;

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function immutablePoint(
  rawSample: number,
  byteOffset: number,
  frameOrdinal: number,
  mainDataCapacityBytes: number,
  mainDataBeginBytes: number,
): MpegLayer3SeekIndexPoint {
  return Object.freeze({
    rawSample,
    byteOffset,
    frameOrdinal,
    mainDataCapacityBytes,
    mainDataBeginBytes,
  });
}

function maximumMainDataBeginBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 1_152 ? 511 : 255;
}

function mainDataCapacityCanFitFrame(
  samplesPerFrame: 576 | 1_152,
  frameBytes: number,
  mainDataCapacityBytes: number,
): boolean {
  const structuralBytes = frameBytes - mainDataCapacityBytes;
  return samplesPerFrame === 1_152
    ? structuralBytes === 21 ||
        structuralBytes === 23 ||
        structuralBytes === 36 ||
        structuralBytes === 38
    : structuralBytes === 13 ||
        structuralBytes === 15 ||
        structuralBytes === 21 ||
        structuralBytes === 23;
}

function minimumFrameBytes(samplesPerFrame: 576 | 1_152): number {
  // The smallest supported Layer III frames are MPEG-2/2.5 8-kbit frames
  // (24 bytes) and MPEG-1 32-kbit frames (96 bytes), respectively.
  return samplesPerFrame === 576 ? 24 : 96;
}

function spanCanContainFrames(
  byteSpan: number,
  frameCount: number,
  minimumBytesPerFrame: number,
): boolean {
  if (!isNonNegativeSafeInteger(byteSpan) || !isNonNegativeSafeInteger(frameCount)) return false;

  const minimumSpan = frameCount * minimumBytesPerFrame;
  if (!Number.isSafeInteger(minimumSpan) || byteSpan < minimumSpan) return false;

  // Avoid an overflowing multiplication. Every byte span accepted by the
  // public boundary is already a safe integer, so an unsafe maximum product
  // is necessarily greater than it.
  const maximumSpanFits =
    frameCount <= Math.floor(Number.MAX_SAFE_INTEGER / MAX_LAYER_3_FRAME_BYTES);
  return !maximumSpanFits || byteSpan <= frameCount * MAX_LAYER_3_FRAME_BYTES;
}

/**
 * Exact, bounded index of caller-established MPEG Layer III frame boundaries.
 *
 * The index stores coordinates only, never encoded bytes or their authority.
 * Progressive compaction drops points without inventing interpolated ones,
 * keeps the immutable origin and terminal point, and preferentially preserves
 * a contiguous tail for bit-reservoir pre-roll.
 */
export class MpegLayer3SeekIndex {
  readonly origin: MpegLayer3SeekIndexPoint;

  private readonly firstAudioFrameOffset: number;
  private readonly audioEndByteOffset: number;
  private readonly totalRawSamples: number;
  private readonly totalFrames: number;
  private readonly samplesPerFrame: 576 | 1_152;
  private readonly minimumBytesPerFrame: number;
  private readonly maxPoints: number;
  private points: MpegLayer3SeekIndexPoint[];

  constructor(options: MpegLayer3SeekIndexOptions) {
    const {
      sourceSize,
      firstAudioFrameOffset,
      audioEndByteOffset,
      totalRawSamples,
      samplesPerFrame,
      firstFrameMainDataCapacityBytes,
      firstFrameMainDataBeginBytes,
      maxPoints = DEFAULT_MAX_POINTS,
    } = options;

    if (!Number.isSafeInteger(sourceSize) || sourceSize <= 0) {
      throw new RangeError('MP3 source size must be a positive safe integer');
    }
    if (
      !isNonNegativeSafeInteger(firstAudioFrameOffset) ||
      !isNonNegativeSafeInteger(audioEndByteOffset) ||
      firstAudioFrameOffset >= audioEndByteOffset ||
      audioEndByteOffset > sourceSize
    ) {
      throw new RangeError('MP3 audio span must be a non-empty range inside the source');
    }
    if (samplesPerFrame !== 576 && samplesPerFrame !== 1_152) {
      throw new RangeError('MP3 samplesPerFrame must be 576 or 1152');
    }
    if (
      !Number.isSafeInteger(totalRawSamples) ||
      totalRawSamples < samplesPerFrame ||
      totalRawSamples % samplesPerFrame !== 0
    ) {
      throw new RangeError('MP3 raw sample count must contain complete MPEG frames');
    }
    if (
      !Number.isSafeInteger(firstFrameMainDataCapacityBytes) ||
      firstFrameMainDataCapacityBytes <= 0 ||
      firstFrameMainDataCapacityBytes >= MAX_LAYER_3_FRAME_BYTES
    ) {
      throw new RangeError('MP3 first-frame main-data capacity must be a positive bounded integer');
    }
    if (firstFrameMainDataBeginBytes !== 0) {
      throw new RangeError('MP3 first-frame main_data_begin must be zero');
    }
    if (
      !Number.isSafeInteger(maxPoints) ||
      maxPoints < MINIMUM_MAX_POINTS ||
      maxPoints > MP3_SEEK_INDEX_MAX_POINTS
    ) {
      throw new RangeError(
        `MP3 seek index maxPoints must be between ${MINIMUM_MAX_POINTS} and ${MP3_SEEK_INDEX_MAX_POINTS}`,
      );
    }

    const totalFrames = totalRawSamples / samplesPerFrame;
    const audioSpan = audioEndByteOffset - firstAudioFrameOffset;
    const minimumBytes = minimumFrameBytes(samplesPerFrame);
    if (!spanCanContainFrames(audioSpan, totalFrames, minimumBytes)) {
      throw new RangeError('MP3 audio span is inconsistent with its raw frame count');
    }
    if (
      totalFrames === 1 &&
      !mainDataCapacityCanFitFrame(samplesPerFrame, audioSpan, firstFrameMainDataCapacityBytes)
    ) {
      throw new RangeError('MP3 first-frame main-data capacity does not match its frame span');
    }

    this.firstAudioFrameOffset = firstAudioFrameOffset;
    this.audioEndByteOffset = audioEndByteOffset;
    this.totalRawSamples = totalRawSamples;
    this.totalFrames = totalFrames;
    this.samplesPerFrame = samplesPerFrame;
    this.minimumBytesPerFrame = minimumBytes;
    this.maxPoints = maxPoints;
    this.origin = immutablePoint(
      0,
      firstAudioFrameOffset,
      0,
      firstFrameMainDataCapacityBytes,
      firstFrameMainDataBeginBytes,
    );
    this.points = [this.origin];
  }

  snapshot(): readonly MpegLayer3SeekIndexPoint[] {
    return Object.freeze(
      this.points.map((point) =>
        immutablePoint(
          point.rawSample,
          point.byteOffset,
          point.frameOrdinal,
          point.mainDataCapacityBytes,
          point.mainDataBeginBytes,
        ),
      ),
    );
  }

  /**
   * Add an exact planning frame boundary established by the caller.
   *
   * Local callers use scanner-verified frames. Manifest callers may use sparse
   * anchors only after an outer live-admission owner authenticated the manifest;
   * this index validates geometry and never grants either authority itself.
   * False means that the candidate is invalid, conflicts with an existing
   * point, or cannot fit the fixed frame/sample/byte geometry.
   */
  addVerifiedFrame(
    rawSample: number,
    byteOffset: number,
    frameOrdinal: number,
    mainDataCapacityBytes: number,
    mainDataBeginBytes: number,
  ): boolean {
    if (
      !this.candidateCanDescribeSource(
        rawSample,
        byteOffset,
        frameOrdinal,
        mainDataCapacityBytes,
        mainDataBeginBytes,
      )
    ) {
      return false;
    }

    const insertion = this.lowerBoundFrameOrdinal(frameOrdinal);
    const exact = this.points[insertion];
    if (exact?.frameOrdinal === frameOrdinal) return false;

    const point = immutablePoint(
      rawSample,
      byteOffset,
      frameOrdinal,
      mainDataCapacityBytes,
      mainDataBeginBytes,
    );
    const previous = this.points[insertion - 1];
    const next = this.points[insertion];
    if (previous && !this.intervalIsPossible(previous, point)) return false;
    if (next && !this.intervalIsPossible(point, next)) return false;
    if (
      frameOrdinal === this.totalFrames - 1 &&
      !mainDataCapacityCanFitFrame(
        this.samplesPerFrame,
        this.audioEndByteOffset - byteOffset,
        mainDataCapacityBytes,
      )
    ) {
      return false;
    }

    this.points.splice(insertion, 0, point);
    this.compactIfNeeded();
    return true;
  }

  nearestBefore(targetRawSample: number): MpegLayer3SeekIndexPoint {
    this.assertTarget(targetRawSample, true);
    const insertion = this.upperBoundRawSample(targetRawSample);
    const point = this.points[Math.max(0, insertion - 1)];
    if (!point) throw new Error('MP3 seek index lost its origin point');
    return point;
  }

  bracket(targetRawSample: number): MpegLayer3SeekBracket {
    this.assertTarget(targetRawSample, true);
    const before = this.nearestBefore(targetRawSample);
    const beforeIndex = this.lowerBoundFrameOrdinal(before.frameOrdinal);
    const after = this.points[beforeIndex + 1] ?? null;
    return Object.freeze({ before, after });
  }

  /**
   * Plan exact verified history for the target frame's Layer III reservoir.
   *
   * The synthesis warmup span is selected first. Only then is history extended
   * to satisfy the warmup-start frame's exact `main_data_begin`, so the first
   * synthesis-warmup frame sent to the decoder is reservoir-complete.
   */
  reservoirPrelude(
    targetRawSample: number,
    minimumWarmupFrames = DEFAULT_SYNTHESIS_WARMUP_FRAMES,
  ): MpegLayer3ReservoirPrelude {
    this.assertTarget(targetRawSample, false);
    if (
      !Number.isSafeInteger(minimumWarmupFrames) ||
      minimumWarmupFrames < 0 ||
      minimumWarmupFrames > MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES
    ) {
      throw new RangeError(
        `MP3 synthesis warmup must be between 0 and ${MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES} frames`,
      );
    }
    if (targetRawSample % this.samplesPerFrame !== 0) {
      throw new RangeError('MP3 reservoir target must be an exact raw frame boundary');
    }

    const targetFrameOrdinal = targetRawSample / this.samplesPerFrame;
    const targetIndex = this.lowerBoundFrameOrdinal(targetFrameOrdinal);
    const target = this.points[targetIndex];

    if (target?.frameOrdinal === targetFrameOrdinal) {
      const previousFrames: MpegLayer3SeekIndexPoint[] = [];
      const warmupFrameCount = Math.min(minimumWarmupFrames, targetFrameOrdinal);
      let reachedAudioOrigin = targetFrameOrdinal === 0;
      let expectedOrdinal = targetFrameOrdinal - 1;
      let pointIndex = targetIndex - 1;

      while (!reachedAudioOrigin && previousFrames.length < warmupFrameCount) {
        const point = this.points[pointIndex];
        if (!point || point.frameOrdinal !== expectedOrdinal) break;
        previousFrames.push(point);
        reachedAudioOrigin = point.frameOrdinal === 0;
        pointIndex -= 1;
        expectedOrdinal -= 1;
      }

      if (reachedAudioOrigin || previousFrames.length === warmupFrameCount) {
        const warmupStart = previousFrames.at(-1) ?? target;
        const warmupStartMainDataBeginBytes = warmupStart.mainDataBeginBytes;
        let reservoirCapacityBeforeWarmupBytes = 0;

        while (
          !reachedAudioOrigin &&
          reservoirCapacityBeforeWarmupBytes < warmupStartMainDataBeginBytes
        ) {
          const point = this.points[pointIndex];
          if (!point || point.frameOrdinal !== expectedOrdinal) break;
          previousFrames.push(point);
          reservoirCapacityBeforeWarmupBytes += point.mainDataCapacityBytes;
          if (!Number.isSafeInteger(reservoirCapacityBeforeWarmupBytes)) {
            throw new Error('MP3 reservoir capacity exceeded the safe-integer range');
          }
          reachedAudioOrigin = point.frameOrdinal === 0;
          pointIndex -= 1;
          expectedOrdinal -= 1;
        }

        if (reservoirCapacityBeforeWarmupBytes >= warmupStartMainDataBeginBytes) {
          previousFrames.reverse();
          return Object.freeze({
            kind: 'verified-history',
            target,
            minimumWarmupFrames,
            warmupStart,
            warmupStartMainDataBeginBytes,
            previousFrames: Object.freeze(previousFrames),
            reservoirCapacityBeforeWarmupBytes,
            reachedAudioOrigin,
          });
        }
        if (reachedAudioOrigin) {
          throw new RangeError(
            'MP3 warmup-start main_data_begin exceeds all available preceding main-data capacity',
          );
        }
      }
    }

    // A missing warmup-start descriptor may use the generation's maximum
    // reservoir. Keep its one-byte-per-frame worst case separate from the
    // synthesis warmup itself, then clamp both at the audio origin.
    const warmupFrameLimit = Math.min(targetFrameOrdinal, minimumWarmupFrames);
    const reservoirFrameLimit = Math.min(
      targetFrameOrdinal - warmupFrameLimit,
      maximumMainDataBeginBytes(this.samplesPerFrame),
    );
    const historyFrameLimit = warmupFrameLimit + reservoirFrameLimit;
    const desiredStartOrdinal = targetFrameOrdinal - historyFrameLimit;
    const desiredStartRawSample = desiredStartOrdinal * this.samplesPerFrame;
    const anchor = this.nearestBefore(desiredStartRawSample);
    return Object.freeze({
      kind: 'scan-from-anchor',
      targetRawSample,
      targetFrameOrdinal,
      anchor,
      minimumWarmupFrames,
      warmupFrameLimit,
      reservoirFrameLimit,
      historyFrameLimit,
    });
  }

  private candidateCanDescribeSource(
    rawSample: number,
    byteOffset: number,
    frameOrdinal: number,
    mainDataCapacityBytes: number,
    mainDataBeginBytes: number,
  ): boolean {
    if (
      !isNonNegativeSafeInteger(rawSample) ||
      !isNonNegativeSafeInteger(byteOffset) ||
      !isNonNegativeSafeInteger(frameOrdinal) ||
      !Number.isSafeInteger(mainDataCapacityBytes) ||
      mainDataCapacityBytes <= 0 ||
      mainDataCapacityBytes >= MAX_LAYER_3_FRAME_BYTES ||
      !Number.isSafeInteger(mainDataBeginBytes) ||
      mainDataBeginBytes < 0 ||
      mainDataBeginBytes > maximumMainDataBeginBytes(this.samplesPerFrame) ||
      frameOrdinal >= this.totalFrames ||
      rawSample >= this.totalRawSamples ||
      rawSample !== frameOrdinal * this.samplesPerFrame ||
      byteOffset < this.firstAudioFrameOffset ||
      byteOffset >= this.audioEndByteOffset
    ) {
      return false;
    }

    const bytesBefore = byteOffset - this.firstAudioFrameOffset;
    if (!spanCanContainFrames(bytesBefore, frameOrdinal, this.minimumBytesPerFrame)) return false;

    const framesThroughEnd = this.totalFrames - frameOrdinal;
    const bytesThroughEnd = this.audioEndByteOffset - byteOffset;
    return spanCanContainFrames(bytesThroughEnd, framesThroughEnd, this.minimumBytesPerFrame);
  }

  private intervalIsPossible(
    earlier: MpegLayer3SeekIndexPoint,
    later: MpegLayer3SeekIndexPoint,
  ): boolean {
    const frameDelta = later.frameOrdinal - earlier.frameOrdinal;
    const byteDelta = later.byteOffset - earlier.byteOffset;
    if (
      !(
        frameDelta > 0 &&
        later.rawSample - earlier.rawSample === frameDelta * this.samplesPerFrame &&
        spanCanContainFrames(byteDelta, frameDelta, this.minimumBytesPerFrame)
      )
    ) {
      return false;
    }
    return (
      frameDelta !== 1 ||
      mainDataCapacityCanFitFrame(this.samplesPerFrame, byteDelta, earlier.mainDataCapacityBytes)
    );
  }

  private compactIfNeeded(): void {
    while (this.points.length > this.maxPoints) {
      const terminalIndex = this.points.length - 1;
      let protectedTailStart = terminalIndex;
      let protectedPredecessors = 0;
      while (
        protectedTailStart > 0 &&
        protectedPredecessors < MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES
      ) {
        const current = this.points[protectedTailStart];
        const previous = this.points[protectedTailStart - 1];
        if (!current || !previous || previous.frameOrdinal + 1 !== current.frameOrdinal) break;
        protectedTailStart -= 1;
        protectedPredecessors += 1;
      }

      const compacted: MpegLayer3SeekIndexPoint[] = [this.origin];
      for (let index = 2; index < protectedTailStart; index += 2) {
        const point = this.points[index];
        if (point) compacted.push(point);
      }
      for (let index = protectedTailStart; index < this.points.length; index += 1) {
        const point = this.points[index];
        if (point && point !== this.origin) compacted.push(point);
      }

      if (compacted.length >= this.points.length) {
        throw new Error('MP3 seek index could not compact within its configured bound');
      }
      this.points = compacted;
    }
  }

  private lowerBoundFrameOrdinal(frameOrdinal: number): number {
    let low = 0;
    let high = this.points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const point = this.points[middle];
      if (point && point.frameOrdinal < frameOrdinal) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private upperBoundRawSample(rawSample: number): number {
    let low = 0;
    let high = this.points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const point = this.points[middle];
      if (point && point.rawSample <= rawSample) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private assertTarget(targetRawSample: number, allowAudioEnd: boolean): void {
    const upperBound = allowAudioEnd ? this.totalRawSamples : this.totalRawSamples - 1;
    if (!isNonNegativeSafeInteger(targetRawSample) || targetRawSample > upperBound) {
      throw new RangeError('MP3 seek target is outside the raw sample range');
    }
  }
}
