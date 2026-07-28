import { FLAC_STREAM_MAX_CHANNELS, type FlacStreamDescriptor } from './stream-protocol.js';
import { expectedLanczosOutputFrames } from './resampler-plan.js';

const FLAC_MAX_SAMPLE_RATE = 655_350;
const FLAC_MIN_BIT_DEPTH = 4;
const FLAC_MAX_BIT_DEPTH = 32;
const MAX_OUTPUT_SAMPLE_RATE = 1_000_000;
const FLAC_MAX_BLOCK_SIZE = 65_535;
const FLAC_MAX_FRAME_SIZE = 0xff_ffff;

function requireSafeInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

/**
 * Validate the metadata contract before any decoder or resampler allocation.
 *
 * STREAMINFO is parsed independently on the main thread. The worker still
 * validates every field because a DedicatedWorker message is an untrusted
 * runtime boundary, then compares the decoder's frame metadata to this
 * descriptor as it streams.
 */
export function validateFlacStreamDescriptor(descriptor: FlacStreamDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('FLAC stream descriptor is missing');
  }
  requireSafeInteger(descriptor.sourceSampleRate, 'sourceSampleRate', 1, FLAC_MAX_SAMPLE_RATE);
  requireSafeInteger(descriptor.outputSampleRate, 'outputSampleRate', 1, MAX_OUTPUT_SAMPLE_RATE);
  requireSafeInteger(descriptor.channels, 'channels', 1, FLAC_STREAM_MAX_CHANNELS);
  requireSafeInteger(descriptor.bitDepth, 'bitDepth', FLAC_MIN_BIT_DEPTH, FLAC_MAX_BIT_DEPTH);
  requireSafeInteger(
    descriptor.totalSourceSamples,
    'totalSourceSamples',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  requireSafeInteger(
    descriptor.firstAudioFrameOffset,
    'firstAudioFrameOffset',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  requireSafeInteger(
    descriptor.targetSourceSample,
    'targetSourceSample',
    0,
    descriptor.totalSourceSamples,
  );
  requireSafeInteger(
    descriptor.decodeAnchorByteOffset,
    'decodeAnchorByteOffset',
    descriptor.firstAudioFrameOffset,
    Number.MAX_SAFE_INTEGER,
  );
  requireSafeInteger(
    descriptor.decodeAnchorSourceSample,
    'decodeAnchorSourceSample',
    0,
    Math.min(descriptor.targetSourceSample, descriptor.totalSourceSamples - 1),
  );
  requireSafeInteger(descriptor.minBlockSize, 'minBlockSize', 16, FLAC_MAX_BLOCK_SIZE);
  requireSafeInteger(
    descriptor.maxBlockSize,
    'maxBlockSize',
    descriptor.minBlockSize,
    FLAC_MAX_BLOCK_SIZE,
  );
  requireSafeInteger(descriptor.minFrameSize, 'minFrameSize', 0, FLAC_MAX_FRAME_SIZE);
  requireSafeInteger(descriptor.maxFrameSize, 'maxFrameSize', 0, FLAC_MAX_FRAME_SIZE);
  if (
    descriptor.minFrameSize > 0 &&
    descriptor.maxFrameSize > 0 &&
    descriptor.maxFrameSize < descriptor.minFrameSize
  ) {
    throw new RangeError('maxFrameSize must not be smaller than minFrameSize');
  }
  if (
    (descriptor.decodeAnchorSourceSample === 0) !==
    (descriptor.decodeAnchorByteOffset === descriptor.firstAudioFrameOffset)
  ) {
    throw new RangeError(
      'only source-sample zero may use firstAudioFrameOffset as its decode anchor',
    );
  }

  // Do this calculation during validation so impossible output timelines fail
  // before WASM is initialized.
  expectedOutputFrames(descriptor);
}

/** Exact output contract for the direct or pinned Lanczos path. */
export function expectedOutputFrames(descriptor: FlacStreamDescriptor): number {
  if (descriptor.sourceSampleRate === descriptor.outputSampleRate) {
    return descriptor.totalSourceSamples - descriptor.targetSourceSample;
  }
  return expectedLanczosOutputFrames({
    inputSampleRate: descriptor.sourceSampleRate,
    outputSampleRate: descriptor.outputSampleRate,
    totalSourceFrames: descriptor.totalSourceSamples,
    startSourceFrame: descriptor.targetSourceSample,
  });
}

export interface DiscardedPcm {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
  readonly discarded: number;
  readonly remainingDiscard: number;
}

/**
 * Discard an exact number of decoded source-domain samples.
 *
 * The fallback seek path deliberately decodes from byte zero. Discarding is
 * performed before resampling, so `startSourceSample` names an exact FLAC PCM
 * sample even when the source and AudioContext rates differ. A verified seek
 * anchor may avoid decoding the prefix before this worker run.
 */
export function discardDecodedSourcePrefix(
  channels: readonly Float32Array[],
  frames: number,
  samplesToDiscard: number,
): DiscardedPcm {
  requireSafeInteger(frames, 'decoded frames', 0, Number.MAX_SAFE_INTEGER);
  requireSafeInteger(samplesToDiscard, 'samplesToDiscard', 0, Number.MAX_SAFE_INTEGER);
  if (channels.length < 1 || channels.length > FLAC_STREAM_MAX_CHANNELS) {
    throw new RangeError(
      `decoded channel count must be from 1 through ${FLAC_STREAM_MAX_CHANNELS}`,
    );
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== frames) {
      throw new RangeError('decoded channels must all match the decoded frame count');
    }
  }

  const discarded = Math.min(frames, samplesToDiscard);
  return {
    channels: channels.map((channel) => channel.subarray(discarded)),
    frames: frames - discarded,
    discarded,
    remainingDiscard: samplesToDiscard - discarded,
  };
}
