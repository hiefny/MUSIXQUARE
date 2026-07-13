import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.js';
import type { WavePcmEncoding, WavePcmMetadata } from './metadata.js';
import {
  WAVE_STREAM_MAX_CHANNELS,
  WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES,
  WAVE_STREAM_MAX_READ_BYTES,
  type WaveStreamDescriptor,
} from './stream-protocol.js';

const MAX_SAMPLE_RATE_HZ = 1_000_000;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

interface EncodingLayout {
  readonly bits: 8 | 16 | 24 | 32 | 64;
  readonly bytes: 1 | 2 | 3 | 4 | 8;
  readonly float: boolean;
}

const ENCODING_LAYOUTS: Readonly<Record<WavePcmEncoding, EncodingLayout>> = Object.freeze({
  'pcm-u8': Object.freeze({ bits: 8, bytes: 1, float: false }),
  'pcm-s16le': Object.freeze({ bits: 16, bytes: 2, float: false }),
  'pcm-s24le': Object.freeze({ bits: 24, bytes: 3, float: false }),
  'pcm-s32le': Object.freeze({ bits: 32, bytes: 4, float: false }),
  float32le: Object.freeze({ bits: 32, bytes: 4, float: true }),
  float64le: Object.freeze({ bits: 64, bytes: 8, float: true }),
});

const ENCODINGS = new Set<WavePcmEncoding>(Object.keys(ENCODING_LAYOUTS) as WavePcmEncoding[]);

export interface WavePcmSampleLayout {
  readonly channels: number;
  readonly encoding: WavePcmEncoding;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  readonly blockAlign: number;
}

export interface DecodedWavePcm {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
}

export interface WavePcmInputReadPlan {
  readonly sourceFrame: number;
  readonly byteOffset: number;
  readonly frames: number;
  readonly bytes: number;
  readonly final: boolean;
}

export type WavePcmDecodeErrorCode = 'nonzero-unused-bits';

/** Encoded PCM bytes contradict an otherwise valid WAVE descriptor. */
export class WavePcmDecodeError extends Error {
  readonly code: WavePcmDecodeErrorCode;

  constructor(code: WavePcmDecodeErrorCode, message: string) {
    super(message);
    this.name = 'WavePcmDecodeError';
    this.code = code;
  }
}

function requireSafeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function encodingLayout(encoding: unknown): EncodingLayout {
  if (typeof encoding !== 'string' || !ENCODINGS.has(encoding as WavePcmEncoding)) {
    throw new RangeError('WAVE PCM encoding is unsupported');
  }
  return ENCODING_LAYOUTS[encoding as WavePcmEncoding];
}

function validateSampleLayout(layout: WavePcmSampleLayout): EncodingLayout {
  if (!layout || typeof layout !== 'object') {
    throw new TypeError('WAVE PCM sample layout is missing');
  }
  requireSafeInteger(layout.channels, 'channels', 1, WAVE_STREAM_MAX_CHANNELS);
  const encoding = encodingLayout(layout.encoding);
  if (layout.containerBitsPerSample !== encoding.bits) {
    throw new RangeError('containerBitsPerSample contradicts the WAVE PCM encoding');
  }
  requireSafeInteger(
    layout.validBitsPerSample,
    'validBitsPerSample',
    1,
    layout.containerBitsPerSample,
  );
  if (encoding.float && layout.validBitsPerSample !== layout.containerBitsPerSample) {
    throw new RangeError('IEEE float valid bits must equal its sample container size');
  }
  const expectedBlockAlign = layout.channels * encoding.bytes;
  requireSafeInteger(layout.blockAlign, 'blockAlign', 1);
  if (layout.blockAlign !== expectedBlockAlign) {
    throw new RangeError('blockAlign contradicts the WAVE PCM sample layout');
  }
  return encoding;
}

function safeBigIntNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

function dataEnd(descriptor: WaveStreamDescriptor): number {
  return safeBigIntNumber(
    BigInt(descriptor.dataOffset) + BigInt(descriptor.dataBytes),
    'WAVE PCM data end',
  );
}

function sourceFrameByteOffsetUnchecked(
  descriptor: WaveStreamDescriptor,
  sourceFrame: number,
): number {
  const offset = safeBigIntNumber(
    BigInt(descriptor.dataOffset) + BigInt(sourceFrame) * BigInt(descriptor.blockAlign),
    'WAVE PCM byte offset',
  );
  if (offset > dataEnd(descriptor)) {
    throw new RangeError('WAVE PCM byte offset exceeds the data chunk');
  }
  return offset;
}

function expectedOutputFramesUnchecked(descriptor: WaveStreamDescriptor): number {
  if (descriptor.sourceSampleRate === descriptor.outputSampleRate) {
    return descriptor.totalSourceFrames - descriptor.targetSourceFrame;
  }
  return expectedLanczosOutputFrames({
    inputSampleRate: descriptor.sourceSampleRate,
    outputSampleRate: descriptor.outputSampleRate,
    totalSourceFrames: descriptor.totalSourceFrames,
    startSourceFrame: descriptor.targetSourceFrame,
  });
}

/** Validate a worker-bound descriptor before any PCM or resampler allocation. */
export function validateWaveStreamDescriptor(descriptor: WaveStreamDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('WAVE stream descriptor is missing');
  }
  if (descriptor.format !== 'wave-pcm') {
    throw new TypeError('WAVE stream descriptor format is invalid');
  }
  requireSafeInteger(descriptor.sourceSampleRate, 'sourceSampleRate', 1, MAX_SAMPLE_RATE_HZ);
  requireSafeInteger(descriptor.outputSampleRate, 'outputSampleRate', 1, MAX_SAMPLE_RATE_HZ);
  validateSampleLayout(descriptor);
  requireSafeInteger(descriptor.dataOffset, 'dataOffset', 0);
  requireSafeInteger(descriptor.dataBytes, 'dataBytes', 1);
  requireSafeInteger(descriptor.logicalFileBytes, 'logicalFileBytes', 1);
  requireSafeInteger(descriptor.totalSourceFrames, 'totalSourceFrames', 1);
  requireSafeInteger(
    descriptor.targetSourceFrame,
    'targetSourceFrame',
    0,
    descriptor.totalSourceFrames,
  );
  if (descriptor.dataBytes % descriptor.blockAlign !== 0) {
    throw new RangeError('dataBytes is not a whole number of WAVE PCM frames');
  }
  if (descriptor.dataBytes / descriptor.blockAlign !== descriptor.totalSourceFrames) {
    throw new RangeError('totalSourceFrames contradicts dataBytes and blockAlign');
  }
  if (dataEnd(descriptor) > descriptor.logicalFileBytes) {
    throw new RangeError('WAVE PCM data exceeds the logical encoded source');
  }
  sourceFrameByteOffsetUnchecked(descriptor, descriptor.targetSourceFrame);
  expectedOutputFramesUnchecked(descriptor);
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
  validateWaveStreamDescriptor(descriptor);
  requireSafeInteger(sourceFrame, 'sourceFrame', 0, descriptor.totalSourceFrames);
  return sourceFrameByteOffsetUnchecked(descriptor, sourceFrame);
}

export function remainingWaveSourceFrames(descriptor: WaveStreamDescriptor): number {
  validateWaveStreamDescriptor(descriptor);
  return descriptor.totalSourceFrames - descriptor.targetSourceFrame;
}

/** Exact output frames remaining after the descriptor's source-frame target. */
export function expectedWaveOutputFrames(descriptor: WaveStreamDescriptor): number {
  validateWaveStreamDescriptor(descriptor);
  return expectedOutputFramesUnchecked(descriptor);
}

/** Exact output-timeline frame corresponding to the descriptor's seek target. */
export function waveOutputFrameAtTarget(descriptor: WaveStreamDescriptor): number {
  validateWaveStreamDescriptor(descriptor);
  const total =
    descriptor.sourceSampleRate === descriptor.outputSampleRate
      ? descriptor.totalSourceFrames
      : expectedLanczosOutputFrames({
          inputSampleRate: descriptor.sourceSampleRate,
          outputSampleRate: descriptor.outputSampleRate,
          totalSourceFrames: descriptor.totalSourceFrames,
          startSourceFrame: 0,
        });
  return total - expectedOutputFramesUnchecked(descriptor);
}

export function maximumWaveInputFramesPerRead(descriptor: WaveStreamDescriptor): number {
  validateWaveStreamDescriptor(descriptor);
  return Math.floor(WAVE_STREAM_MAX_READ_BYTES / descriptor.blockAlign);
}

/**
 * Plan one conservative input read. Its encoded body is <=64KiB and its
 * source-frame count is <= the PCM message ceiling; an upsampler may choose a
 * still smaller count before publishing output.
 */
export function planWavePcmInputRead(
  descriptor: WaveStreamDescriptor,
  sourceFrame: number,
  maximumFrames = WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES,
): Readonly<WavePcmInputReadPlan> | null {
  validateWaveStreamDescriptor(descriptor);
  requireSafeInteger(
    sourceFrame,
    'sourceFrame',
    descriptor.targetSourceFrame,
    descriptor.totalSourceFrames,
  );
  requireSafeInteger(maximumFrames, 'maximumFrames', 1, WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES);
  if (sourceFrame === descriptor.totalSourceFrames) return null;
  const remaining = descriptor.totalSourceFrames - sourceFrame;
  const frames = Math.min(remaining, maximumFrames, maximumWaveInputFramesPerRead(descriptor));
  const bytes = frames * descriptor.blockAlign;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > WAVE_STREAM_MAX_READ_BYTES) {
    throw new RangeError('planned WAVE PCM read exceeds its encoded byte bound');
  }
  return Object.freeze({
    sourceFrame,
    byteOffset: sourceFrameByteOffsetUnchecked(descriptor, sourceFrame),
    frames,
    bytes,
    final: sourceFrame + frames === descriptor.totalSourceFrames,
  });
}

function validateScalarOffset(view: DataView, byteOffset: number, sampleBytes: number): void {
  if (!(view instanceof DataView)) throw new TypeError('WAVE PCM scalar input must be a DataView');
  requireSafeInteger(byteOffset, 'byteOffset', 0);
  if (byteOffset + sampleBytes > view.byteLength) {
    throw new RangeError('WAVE PCM scalar exceeds the supplied byte view');
  }
}

function requireZeroUnusedBits(unsigned: number, containerBits: number, validBits: number): void {
  const unusedBits = containerBits - validBits;
  if (unusedBits === 0) return;
  const divisor = 2 ** unusedBits;
  if (unsigned % divisor !== 0) {
    throw new WavePcmDecodeError(
      'nonzero-unused-bits',
      'WAVE_FORMAT_EXTENSIBLE PCM has nonzero unused least-significant bits',
    );
  }
}

function decodeScalarUnchecked(
  view: DataView,
  byteOffset: number,
  encoding: WavePcmEncoding,
  validBitsPerSample: number,
): number {
  switch (encoding) {
    case 'pcm-u8': {
      const unsigned = view.getUint8(byteOffset);
      requireZeroUnusedBits(unsigned, 8, validBitsPerSample);
      return (unsigned - 128) / 128;
    }
    case 'pcm-s16le': {
      const unsigned = view.getUint16(byteOffset, true);
      requireZeroUnusedBits(unsigned, 16, validBitsPerSample);
      return view.getInt16(byteOffset, true) / 32_768;
    }
    case 'pcm-s24le': {
      const unsigned =
        view.getUint8(byteOffset) |
        (view.getUint8(byteOffset + 1) << 8) |
        (view.getUint8(byteOffset + 2) << 16);
      requireZeroUnusedBits(unsigned, 24, validBitsPerSample);
      const signed = (unsigned & 0x80_0000) === 0 ? unsigned : unsigned - 0x1_000000;
      return signed / 8_388_608;
    }
    case 'pcm-s32le': {
      const unsigned = view.getUint32(byteOffset, true);
      requireZeroUnusedBits(unsigned, 32, validBitsPerSample);
      return view.getInt32(byteOffset, true) / 2_147_483_648;
    }
    case 'float32le': {
      const value = view.getFloat32(byteOffset, true);
      return Number.isFinite(value) ? value : 0;
    }
    case 'float64le': {
      const value = view.getFloat64(byteOffset, true);
      return Number.isFinite(value) ? value : 0;
    }
  }
}

/** Decode one little-endian WAVE scalar and enforce extensible PCM padding. */
export function decodeWavePcmScalar(
  view: DataView,
  byteOffset: number,
  layout: WavePcmSampleLayout,
): number {
  const encoding = validateSampleLayout(layout);
  validateScalarOffset(view, byteOffset, encoding.bytes);
  return decodeScalarUnchecked(view, byteOffset, layout.encoding, layout.validBitsPerSample);
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
  const encoding = validateSampleLayout(layout);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('WAVE PCM input must be a Uint8Array');
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > WAVE_STREAM_MAX_READ_BYTES) {
    throw new RangeError(
      `WAVE PCM input must contain from 1 through ${WAVE_STREAM_MAX_READ_BYTES} bytes`,
    );
  }
  if (bytes.byteLength % layout.blockAlign !== 0) {
    throw new RangeError('WAVE PCM input is not a whole number of interleaved frames');
  }
  const frames = bytes.byteLength / layout.blockAlign;
  const channels = Array.from({ length: layout.channels }, () => new Float32Array(frames));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * layout.blockAlign;
    for (let channel = 0; channel < layout.channels; channel += 1) {
      channels[channel]![frame] = decodeScalarUnchecked(
        view,
        frameOffset + channel * encoding.bytes,
        layout.encoding,
        layout.validBitsPerSample,
      );
    }
  }
  return Object.freeze({ channels: Object.freeze(channels), frames });
}
