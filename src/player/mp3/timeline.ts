/**
 * mpg123's raw Layer III output begins with this fixed synthesis delay when
 * decoder-side gapless trimming is disabled. The value is identical for
 * MPEG-1, MPEG-2, and MPEG-2.5 streams.
 */
export const MPG123_DECODER_DELAY_SAMPLES = 529;

export interface Mp3TrustedGaplessMetadata {
  readonly encoderDelaySamples: number;
  readonly endPaddingSamples: number;
}

export interface Mp3SampleTimelineOptions {
  readonly totalRawSamples: number;
  readonly samplesPerFrame: 576 | 1_152;
  /** CRC-proven encoder timing, or null when no timing may be trusted. */
  readonly gapless: Mp3TrustedGaplessMetadata | null;
}

/**
 * Exact relationship between the raw mpg123 output and the audible timeline.
 * All coordinates are PCM-frame counts (one sample per channel), not
 * individual channel samples. `rawEofSampleExclusive` is the first raw frame
 * that must not be published.
 */
export interface Mp3SampleTimeline {
  readonly totalRawSamples: number;
  readonly samplesPerFrame: 576 | 1_152;
  readonly headTrimSamples: number;
  readonly tailTrimSamples: number;
  readonly rawEofSampleExclusive: number;
  readonly totalMediaFrames: number;
}

export interface Mp3MediaFrameLocation {
  readonly mediaFrame: number;
  readonly rawSample: number;
  readonly audioFrameOrdinal: number;
  readonly sampleWithinAudioFrame: number;
}

export interface Mp3DecodeGenerationPlan extends Mp3MediaFrameLocation {
  readonly preludeAudioFrameOrdinal: number;
  readonly preludeRawSample: number;
  readonly discardSamples: number;
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function requireSamplesPerFrame(value: number): asserts value is 576 | 1_152 {
  if (value !== 576 && value !== 1_152) {
    throw new RangeError('samplesPerFrame must be 576 or 1,152');
  }
}

function requireMp3SampleTimeline(value: Mp3SampleTimeline): void {
  if (!value || typeof value !== 'object') {
    throw new TypeError('MP3 sample timeline must be an object');
  }
  requireNonNegativeSafeInteger(value.totalRawSamples, 'timeline totalRawSamples');
  requireSamplesPerFrame(value.samplesPerFrame);
  requireNonNegativeSafeInteger(value.headTrimSamples, 'timeline headTrimSamples');
  requireNonNegativeSafeInteger(value.tailTrimSamples, 'timeline tailTrimSamples');
  requireNonNegativeSafeInteger(value.rawEofSampleExclusive, 'timeline rawEofSampleExclusive');
  requireNonNegativeSafeInteger(value.totalMediaFrames, 'timeline totalMediaFrames');
  if (
    value.totalRawSamples === 0 ||
    value.totalRawSamples % value.samplesPerFrame !== 0 ||
    value.rawEofSampleExclusive !== value.totalRawSamples - value.tailTrimSamples ||
    value.totalMediaFrames !== value.rawEofSampleExclusive - value.headTrimSamples ||
    value.totalMediaFrames <= 0
  ) {
    throw new RangeError('MP3 sample timeline geometry is inconsistent');
  }
}

/**
 * Normalize trusted encoder timing onto raw mpg123 output coordinates.
 *
 * Without CRC-proven timing, no samples are trimmed. With trusted timing,
 * mpg123's synthesis delay moves to the head. Only encoder padding beyond that
 * delay remains at the tail; padding smaller than the delay must not be
 * subtracted a second time.
 */
export function createMp3SampleTimeline(options: Mp3SampleTimelineOptions): Mp3SampleTimeline {
  if (!options || typeof options !== 'object') {
    throw new TypeError('MP3 sample timeline options must be an object');
  }
  const { totalRawSamples, samplesPerFrame, gapless } = options;
  requireNonNegativeSafeInteger(totalRawSamples, 'totalRawSamples');
  requireSamplesPerFrame(samplesPerFrame);
  if (totalRawSamples === 0 || totalRawSamples % samplesPerFrame !== 0) {
    throw new RangeError('totalRawSamples must be a positive whole number of MP3 audio frames');
  }

  let headTrimSamples = 0;
  let tailTrimSamples = 0;
  if (gapless !== null) {
    if (!gapless || typeof gapless !== 'object') {
      throw new TypeError('gapless must be trusted timing metadata or null');
    }
    requireNonNegativeSafeInteger(gapless.encoderDelaySamples, 'encoderDelaySamples');
    requireNonNegativeSafeInteger(gapless.endPaddingSamples, 'endPaddingSamples');
    headTrimSamples = safeAdd(
      gapless.encoderDelaySamples,
      MPG123_DECODER_DELAY_SAMPLES,
      'MP3 head trim',
    );
    tailTrimSamples = Math.max(gapless.endPaddingSamples - MPG123_DECODER_DELAY_SAMPLES, 0);
  }

  const rawEofSampleExclusive = totalRawSamples - tailTrimSamples;
  const totalMediaFrames = rawEofSampleExclusive - headTrimSamples;
  if (!Number.isSafeInteger(totalMediaFrames) || totalMediaFrames <= 0) {
    throw new RangeError('MP3 gapless trim leaves no audible media frames');
  }

  return Object.freeze({
    totalRawSamples,
    samplesPerFrame,
    headTrimSamples,
    tailTrimSamples,
    rawEofSampleExclusive,
    totalMediaFrames,
  });
}

/**
 * Map an audible frame, including the exclusive EOF, onto raw MP3 output.
 * When an untrimmed EOF is also an encoded-frame boundary, its ordinal is the
 * audio frame count: a terminal cursor, not an encoded frame to decode.
 */
export function locateMp3MediaFrame(
  timeline: Mp3SampleTimeline,
  mediaFrame: number,
): Mp3MediaFrameLocation {
  requireMp3SampleTimeline(timeline);
  requireNonNegativeSafeInteger(mediaFrame, 'mediaFrame');
  if (mediaFrame > timeline.totalMediaFrames) {
    throw new RangeError('mediaFrame is outside the MP3 media timeline');
  }
  const rawSample = safeAdd(timeline.headTrimSamples, mediaFrame, 'MP3 raw sample');
  if (rawSample > timeline.rawEofSampleExclusive) {
    throw new RangeError('mediaFrame maps beyond the MP3 raw EOF');
  }
  const audioFrameOrdinal = Math.floor(rawSample / timeline.samplesPerFrame);
  const sampleWithinAudioFrame = rawSample % timeline.samplesPerFrame;
  return Object.freeze({ mediaFrame, rawSample, audioFrameOrdinal, sampleWithinAudioFrame });
}

/**
 * Plan the exact prefix to discard when a non-EOF generation starts at a
 * reservoir and synthesis-safe prelude frame. The exclusive EOF is a terminal
 * cursor and must be completed without starting a decoder generation.
 */
export function planMp3DecodeGeneration(
  timeline: Mp3SampleTimeline,
  mediaFrame: number,
  preludeAudioFrameOrdinal: number,
): Mp3DecodeGenerationPlan {
  const target = locateMp3MediaFrame(timeline, mediaFrame);
  if (mediaFrame === timeline.totalMediaFrames) {
    throw new RangeError('MP3 exclusive EOF cannot start a decode generation');
  }
  requireNonNegativeSafeInteger(preludeAudioFrameOrdinal, 'preludeAudioFrameOrdinal');
  if (preludeAudioFrameOrdinal > target.audioFrameOrdinal) {
    throw new RangeError('MP3 decode prelude cannot begin after its target audio frame');
  }
  const preludeRawSample = safeMultiply(
    preludeAudioFrameOrdinal,
    timeline.samplesPerFrame,
    'MP3 prelude raw sample',
  );
  const discardSamples = target.rawSample - preludeRawSample;
  if (!Number.isSafeInteger(discardSamples) || discardSamples < 0) {
    throw new RangeError('MP3 generation discard is outside the safe-integer range');
  }
  return Object.freeze({
    ...target,
    preludeAudioFrameOrdinal,
    preludeRawSample,
    discardSamples,
  });
}
