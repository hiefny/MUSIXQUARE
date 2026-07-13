import { expectedLanczosOutputFrames } from './resampler-plan.ts';

const MAX_SAMPLE_RATE_HZ = 1_000_000;

/**
 * Codec-neutral audible PCM timeline owned by the bounded renderer.
 *
 * A decoder adapter translates container/codec coordinates into this media
 * domain. Encoder delay, padding, preroll, packet tables, and byte offsets
 * must therefore remain outside this contract.
 */
export interface StreamingMediaTimeline {
  readonly mediaSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly totalMediaFrames: number;
  readonly totalOutputFrames: number;
  readonly durationSeconds: number;
}

function requirePositiveSafeInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
}

function outputFramesFrom(
  mediaSampleRateHz: number,
  outputSampleRateHz: number,
  totalMediaFrames: number,
  startMediaFrame: number,
): number {
  if (mediaSampleRateHz === outputSampleRateHz) return totalMediaFrames - startMediaFrame;
  return expectedLanczosOutputFrames({
    inputSampleRate: mediaSampleRateHz,
    outputSampleRate: outputSampleRateHz,
    totalSourceFrames: totalMediaFrames,
    startSourceFrame: startMediaFrame,
  });
}

export function createStreamingMediaTimeline(options: {
  readonly mediaSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly totalMediaFrames: number;
}): StreamingMediaTimeline {
  requirePositiveSafeInteger(options.mediaSampleRateHz, 'mediaSampleRateHz', MAX_SAMPLE_RATE_HZ);
  requirePositiveSafeInteger(options.outputSampleRateHz, 'outputSampleRateHz', MAX_SAMPLE_RATE_HZ);
  requirePositiveSafeInteger(options.totalMediaFrames, 'totalMediaFrames', Number.MAX_SAFE_INTEGER);
  const totalOutputFrames = outputFramesFrom(
    options.mediaSampleRateHz,
    options.outputSampleRateHz,
    options.totalMediaFrames,
    0,
  );
  if (totalOutputFrames <= 0) {
    throw new RangeError('Streaming media timeline has no renderable output frames');
  }

  return Object.freeze({
    mediaSampleRateHz: options.mediaSampleRateHz,
    outputSampleRateHz: options.outputSampleRateHz,
    totalMediaFrames: options.totalMediaFrames,
    totalOutputFrames,
    durationSeconds: options.totalMediaFrames / options.mediaSampleRateHz,
  });
}

export function mediaFrameAtPosition(
  timeline: StreamingMediaTimeline,
  positionSeconds: number,
): number {
  if (!Number.isFinite(positionSeconds)) {
    throw new RangeError('positionSeconds must be finite');
  }
  const mediaFrame = Math.round(positionSeconds * timeline.mediaSampleRateHz);
  if (!Number.isSafeInteger(mediaFrame)) {
    throw new RangeError('positionSeconds exceeds the media-frame range');
  }
  return Math.min(timeline.totalMediaFrames, Math.max(0, mediaFrame));
}

export function outputFrameAtMediaFrame(
  timeline: StreamingMediaTimeline,
  mediaFrame: number,
): number {
  if (
    !Number.isSafeInteger(mediaFrame) ||
    mediaFrame < 0 ||
    mediaFrame > timeline.totalMediaFrames
  ) {
    throw new RangeError('mediaFrame is outside the streaming media timeline');
  }
  const remainingOutputFrames = outputFramesFrom(
    timeline.mediaSampleRateHz,
    timeline.outputSampleRateHz,
    timeline.totalMediaFrames,
    mediaFrame,
  );
  return timeline.totalOutputFrames - remainingOutputFrames;
}

export function outputFrameAtPosition(
  timeline: StreamingMediaTimeline,
  positionSeconds: number,
): number {
  return outputFrameAtMediaFrame(timeline, mediaFrameAtPosition(timeline, positionSeconds));
}
