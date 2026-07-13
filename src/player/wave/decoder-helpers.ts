import {
  decodeInterleavedLinearPcm,
  decodeLinearPcmScalar,
  expectedLinearPcmOutputFrames,
  linearPcmOutputFrameAtTarget,
  linearPcmSourceFrameByteOffset,
  maximumLinearPcmInputFramesPerRead,
  planLinearPcmInputRead,
  remainingLinearPcmSourceFrames,
  validateLinearPcmStreamDescriptor,
} from '../linear-pcm/decoder-helpers.js';
import {
  LinearPcmDecodeError,
  type DecodedLinearPcm,
  type LinearPcmSampleLayout,
} from '../linear-pcm/sample-format.js';
import type { LinearPcmInputReadPlan } from '../linear-pcm/stream-protocol.js';
import type { WavePcmMetadata } from './metadata.js';
import type { WaveStreamDescriptor } from './stream-protocol.js';

/** WAVE-facing sample layout over the shared linear-PCM core. */
export type WavePcmSampleLayout = LinearPcmSampleLayout;
/** WAVE-facing decoded block over the shared linear-PCM core. */
export type DecodedWavePcm = DecodedLinearPcm;
/** WAVE-facing bounded read plan over the shared linear-PCM core. */
export type WavePcmInputReadPlan = LinearPcmInputReadPlan;
/** Error constructor used by the WAVE worker facade. */
export { LinearPcmDecodeError as WavePcmDecodeError };

function validateWaveFormat(descriptor: WaveStreamDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('WAVE stream descriptor is missing');
  }
  if (descriptor.format !== 'wave-pcm') {
    throw new TypeError('WAVE stream descriptor format is invalid');
  }
}

/** Validate a worker-bound descriptor before any PCM or resampler allocation. */
export function validateWaveStreamDescriptor(descriptor: WaveStreamDescriptor): void {
  validateWaveFormat(descriptor);
  validateLinearPcmStreamDescriptor(descriptor);
}

/** Build the immutable worker descriptor from already verified WAVE metadata. */
export function createWaveStreamDescriptor(
  metadata: Readonly<WavePcmMetadata>,
  targetSourceFrame: number,
  outputSampleRate: number,
): Readonly<WaveStreamDescriptor> {
  if (!metadata || typeof metadata !== 'object' || metadata.format !== 'wave') {
    throw new TypeError('Verified WAVE PCM metadata is required');
  }
  const descriptor: WaveStreamDescriptor = Object.freeze({
    format: 'wave-pcm',
    sourceSampleRate: metadata.sourceSampleRate,
    outputSampleRate,
    channels: metadata.channels,
    encoding: metadata.encoding,
    containerBitsPerSample: metadata.containerBitsPerSample,
    validBitsPerSample: metadata.validBitsPerSample,
    blockAlign: metadata.blockAlign,
    dataOffset: metadata.dataOffset,
    dataBytes: metadata.dataBytes,
    logicalFileBytes: metadata.logicalFileBytes,
    totalSourceFrames: metadata.totalSourceFrames,
    targetSourceFrame,
  });
  validateWaveStreamDescriptor(descriptor);
  return descriptor;
}

/** O(1) frame-to-byte mapping for PCM/float WAVE data. The end frame is valid. */
export function waveSourceFrameByteOffset(
  descriptor: WaveStreamDescriptor,
  sourceFrame: number,
): number {
  validateWaveFormat(descriptor);
  return linearPcmSourceFrameByteOffset(descriptor, sourceFrame);
}

export function remainingWaveSourceFrames(descriptor: WaveStreamDescriptor): number {
  validateWaveFormat(descriptor);
  return remainingLinearPcmSourceFrames(descriptor);
}

/** Exact output frames remaining after the descriptor's source-frame target. */
export function expectedWaveOutputFrames(descriptor: WaveStreamDescriptor): number {
  validateWaveFormat(descriptor);
  return expectedLinearPcmOutputFrames(descriptor);
}

/** Exact output-timeline frame corresponding to the descriptor's seek target. */
export function waveOutputFrameAtTarget(descriptor: WaveStreamDescriptor): number {
  validateWaveFormat(descriptor);
  return linearPcmOutputFrameAtTarget(descriptor);
}

export function maximumWaveInputFramesPerRead(descriptor: WaveStreamDescriptor): number {
  validateWaveFormat(descriptor);
  return maximumLinearPcmInputFramesPerRead(descriptor);
}

/**
 * Plan one conservative input read. Its encoded body is <=64KiB and its
 * source-frame count is <= the PCM message ceiling; an upsampler may choose a
 * still smaller count before publishing output.
 */
export function planWavePcmInputRead(
  descriptor: WaveStreamDescriptor,
  sourceFrame: number,
  maximumFrames?: number,
): Readonly<WavePcmInputReadPlan> | null {
  validateWaveFormat(descriptor);
  return planLinearPcmInputRead(descriptor, sourceFrame, maximumFrames);
}

/** Decode one little-endian WAVE scalar and enforce extensible PCM padding. */
export function decodeWavePcmScalar(
  view: DataView,
  byteOffset: number,
  layout: WavePcmSampleLayout,
): number {
  return decodeLinearPcmScalar(view, byteOffset, layout);
}

/**
 * Deinterleave one bounded encoded read into worker-owned planar Float32 PCM.
 * Non-finite IEEE samples become silence; finite values above unity remain
 * untouched for the Web Audio graph's normal floating-point gain semantics.
 */
export function decodeWaveInterleavedPcm(
  bytes: Uint8Array,
  layout: WavePcmSampleLayout,
): Readonly<DecodedWavePcm> {
  return decodeInterleavedLinearPcm(bytes, layout);
}
