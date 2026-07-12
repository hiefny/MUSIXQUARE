import type { FlacMetadata } from './metadata.ts';

export interface FlacFrameIndexPoint {
  /** Absolute source-rate PCM sample at this frame boundary. */
  readonly sourceSample: number;
  /** Absolute byte offset of the corresponding native FLAC frame. */
  readonly byteOffset: number;
}

export interface FlacSeekBracket {
  readonly before: FlacFrameIndexPoint;
  /** The terminal point may be EOF rather than a decodable frame. */
  readonly after: FlacFrameIndexPoint;
}

export interface FlacProbeWindow {
  readonly offset: number;
  readonly length: number;
  readonly estimatedFrameOffset: number;
}

const DEFAULT_MAX_POINTS = 8_192;
const DEFAULT_MIN_SPACING_SECONDS = 1;

function validSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function immutablePoint(sourceSample: number, byteOffset: number): FlacFrameIndexPoint {
  return Object.freeze({ sourceSample, byteOffset });
}

/**
 * Bounded, source-domain index for native FLAC frame seek.
 *
 * SEEKTABLE points seed the index. Files without SEEKTABLE progressively add
 * verified frame boundaries while decoding or probing. The index stores no
 * media body and can be discarded with the source handle.
 */
export class FlacSeekIndex {
  private readonly firstAudioFrameOffset: number;
  private readonly sourceSize: number;
  private readonly totalSourceSamples: number;
  private readonly minimumSpacingSamples: number;
  private readonly maxPoints: number;
  private points: FlacFrameIndexPoint[];

  constructor(
    metadata: FlacMetadata,
    sourceSize: number,
    options: { maxPoints?: number; minimumSpacingSeconds?: number } = {},
  ) {
    if (!validSafeInteger(sourceSize) || sourceSize <= metadata.firstAudioFrameOffset) {
      throw new RangeError('FLAC source size must extend beyond the metadata span');
    }
    const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
    if (!Number.isSafeInteger(maxPoints) || maxPoints < 16) {
      throw new RangeError('FLAC seek index maxPoints must be at least 16');
    }
    const minimumSpacingSeconds = options.minimumSpacingSeconds ?? DEFAULT_MIN_SPACING_SECONDS;
    if (!Number.isFinite(minimumSpacingSeconds) || minimumSpacingSeconds < 0) {
      throw new RangeError('FLAC seek index spacing must be finite and non-negative');
    }

    this.firstAudioFrameOffset = metadata.firstAudioFrameOffset;
    this.sourceSize = sourceSize;
    this.totalSourceSamples = metadata.streamInfo.totalSamples;
    this.minimumSpacingSamples = Math.floor(metadata.streamInfo.sampleRate * minimumSpacingSeconds);
    this.maxPoints = maxPoints;
    this.points = [immutablePoint(0, metadata.firstAudioFrameOffset)];

    for (const point of metadata.seekPoints) {
      this.insertVerified(point.sample, metadata.firstAudioFrameOffset + point.streamOffset, true);
    }
  }

  snapshot(): readonly FlacFrameIndexPoint[] {
    return Object.freeze(
      this.points.map((point) => immutablePoint(point.sourceSample, point.byteOffset)),
    );
  }

  addVerifiedFrame(sourceSample: number, byteOffset: number): boolean {
    return this.insertVerified(sourceSample, byteOffset, false);
  }

  nearestBefore(targetSourceSample: number): FlacFrameIndexPoint {
    this.assertTarget(targetSourceSample);
    let low = 0;
    let high = this.points.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const point = this.points[middle];
      if (!point || point.sourceSample > targetSourceSample) high = middle - 1;
      else low = middle + 1;
    }
    const point = this.points[Math.max(0, high)] ?? this.points[0];
    if (!point) throw new Error('FLAC seek index lost its origin point');
    return point;
  }

  bracket(targetSourceSample: number): FlacSeekBracket {
    this.assertTarget(targetSourceSample);
    const before = this.nearestBefore(targetSourceSample);
    const beforeIndex = this.points.indexOf(before);
    const indexedAfter = this.points[beforeIndex + 1];
    const after = indexedAfter ?? immutablePoint(this.totalSourceSamples, this.sourceSize);
    return Object.freeze({ before, after });
  }

  estimateByteOffset(targetSourceSample: number): number {
    const { before, after } = this.bracket(targetSourceSample);
    if (after.sourceSample <= before.sourceSample || after.byteOffset <= before.byteOffset) {
      return before.byteOffset;
    }
    const fraction =
      (targetSourceSample - before.sourceSample) / (after.sourceSample - before.sourceSample);
    const estimate = Math.floor(
      before.byteOffset + fraction * (after.byteOffset - before.byteOffset),
    );
    return Math.max(
      this.firstAudioFrameOffset,
      Math.min(this.sourceSize - 1, Math.max(before.byteOffset, estimate)),
    );
  }

  probeWindow(targetSourceSample: number, requestedBytes: number): FlacProbeWindow {
    this.assertTarget(targetSourceSample);
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
      throw new RangeError('FLAC probe window must be a positive safe integer');
    }
    const estimatedFrameOffset = this.estimateByteOffset(targetSourceSample);
    const maxLength = this.sourceSize - this.firstAudioFrameOffset;
    const length = Math.min(requestedBytes, maxLength);
    const half = Math.floor(length / 2);
    const offset = Math.max(
      this.firstAudioFrameOffset,
      Math.min(this.sourceSize - length, estimatedFrameOffset - half),
    );
    return Object.freeze({ offset, length, estimatedFrameOffset });
  }

  private insertVerified(sourceSample: number, byteOffset: number, force: boolean): boolean {
    if (
      !validSafeInteger(sourceSample) ||
      sourceSample >= this.totalSourceSamples ||
      !validSafeInteger(byteOffset) ||
      byteOffset < this.firstAudioFrameOffset ||
      byteOffset >= this.sourceSize
    ) {
      return false;
    }

    let insertion = 0;
    while (insertion < this.points.length && this.points[insertion]!.sourceSample < sourceSample) {
      insertion += 1;
    }
    const exact = this.points[insertion];
    if (exact?.sourceSample === sourceSample) {
      if (exact.byteOffset !== byteOffset) return false;
      return false;
    }

    const previous = this.points[insertion - 1];
    const next = this.points[insertion];
    if (previous && previous.byteOffset >= byteOffset) return false;
    if (next && next.byteOffset <= byteOffset) return false;
    if (
      !force &&
      this.minimumSpacingSamples > 0 &&
      ((previous && sourceSample - previous.sourceSample < this.minimumSpacingSamples) ||
        (next && next.sourceSample - sourceSample < this.minimumSpacingSamples))
    ) {
      return false;
    }

    this.points.splice(insertion, 0, immutablePoint(sourceSample, byteOffset));
    this.compactIfNeeded();
    return true;
  }

  private compactIfNeeded(): void {
    while (this.points.length > this.maxPoints) {
      const compacted = this.points.filter(
        (_point, index) => index === 0 || index === this.points.length - 1 || index % 2 === 0,
      );
      if (compacted.length === this.points.length) break;
      this.points = compacted;
    }
  }

  private assertTarget(targetSourceSample: number): void {
    if (!validSafeInteger(targetSourceSample) || targetSourceSample > this.totalSourceSamples) {
      throw new RangeError('FLAC seek target is outside the source sample range');
    }
  }
}
