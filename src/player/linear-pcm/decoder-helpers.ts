import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.js';
import {
  LinearPcmDecodeError,
  type DecodedLinearPcm,
  type LinearPcmEncoding,
  type LinearPcmSampleLayout,
} from './sample-format.js';
import {
  LINEAR_PCM_STREAM_MAX_CHANNELS,
  LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES,
  LINEAR_PCM_STREAM_MAX_READ_BYTES,
  LINEAR_PCM_STREAM_MAX_SAMPLE_RATE_HZ,
  type LinearPcmInputReadPlan,
  type LinearPcmStreamDescriptor,
} from './stream-protocol.js';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

interface EncodingLayout {
  readonly bits: 8 | 16 | 24 | 32 | 64;
  readonly bytes: 1 | 2 | 3 | 4 | 8;
  readonly float: boolean;
}

const ENCODING_LAYOUTS: Readonly<Record<LinearPcmEncoding, EncodingLayout>> = Object.freeze({
  'pcm-u8': Object.freeze({ bits: 8, bytes: 1, float: false }),
  'pcm-s8': Object.freeze({ bits: 8, bytes: 1, float: false }),
  'pcm-s16le': Object.freeze({ bits: 16, bytes: 2, float: false }),
  'pcm-s16be': Object.freeze({ bits: 16, bytes: 2, float: false }),
  'pcm-s24le': Object.freeze({ bits: 24, bytes: 3, float: false }),
  'pcm-s24be': Object.freeze({ bits: 24, bytes: 3, float: false }),
  'pcm-s32le': Object.freeze({ bits: 32, bytes: 4, float: false }),
  'pcm-s32be': Object.freeze({ bits: 32, bytes: 4, float: false }),
  float32le: Object.freeze({ bits: 32, bytes: 4, float: true }),
  float32be: Object.freeze({ bits: 32, bytes: 4, float: true }),
  float64le: Object.freeze({ bits: 64, bytes: 8, float: true }),
  float64be: Object.freeze({ bits: 64, bytes: 8, float: true }),
});

const ENCODINGS = new Set<LinearPcmEncoding>(Object.keys(ENCODING_LAYOUTS) as LinearPcmEncoding[]);

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
  if (typeof encoding !== 'string' || !ENCODINGS.has(encoding as LinearPcmEncoding)) {
    throw new RangeError('linear PCM encoding is unsupported');
  }
  return ENCODING_LAYOUTS[encoding as LinearPcmEncoding];
}

export function validateLinearPcmSampleLayout(layout: LinearPcmSampleLayout): void {
  if (!layout || typeof layout !== 'object') {
    throw new TypeError('linear PCM sample layout is missing');
  }
  requireSafeInteger(layout.channels, 'channels', 1, LINEAR_PCM_STREAM_MAX_CHANNELS);
  const encoding = encodingLayout(layout.encoding);
  if (layout.containerBitsPerSample !== encoding.bits) {
    throw new RangeError('containerBitsPerSample contradicts the linear PCM encoding');
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
    throw new RangeError('blockAlign contradicts the linear PCM sample layout');
  }
}

function safeBigIntNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

function dataEnd(descriptor: LinearPcmStreamDescriptor): number {
  return safeBigIntNumber(
    BigInt(descriptor.dataOffset) + BigInt(descriptor.dataBytes),
    'linear PCM data end',
  );
}

function sourceFrameByteOffsetUnchecked(
  descriptor: LinearPcmStreamDescriptor,
  sourceFrame: number,
): number {
  const offset = safeBigIntNumber(
    BigInt(descriptor.dataOffset) + BigInt(sourceFrame) * BigInt(descriptor.blockAlign),
    'linear PCM byte offset',
  );
  if (offset > dataEnd(descriptor)) {
    throw new RangeError('linear PCM byte offset exceeds the encoded sample data');
  }
  return offset;
}

function expectedOutputFramesUnchecked(descriptor: LinearPcmStreamDescriptor): number {
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

/** Validate bounded linear-PCM geometry before PCM or resampler allocation. */
export function validateLinearPcmStreamDescriptor(descriptor: LinearPcmStreamDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('linear PCM stream descriptor is missing');
  }
  requireSafeInteger(
    descriptor.sourceSampleRate,
    'sourceSampleRate',
    1,
    LINEAR_PCM_STREAM_MAX_SAMPLE_RATE_HZ,
  );
  requireSafeInteger(
    descriptor.outputSampleRate,
    'outputSampleRate',
    1,
    LINEAR_PCM_STREAM_MAX_SAMPLE_RATE_HZ,
  );
  validateLinearPcmSampleLayout(descriptor);
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
    throw new RangeError('dataBytes is not a whole number of linear PCM frames');
  }
  if (descriptor.dataBytes / descriptor.blockAlign !== descriptor.totalSourceFrames) {
    throw new RangeError('totalSourceFrames contradicts dataBytes and blockAlign');
  }
  if (dataEnd(descriptor) > descriptor.logicalFileBytes) {
    throw new RangeError('linear PCM data exceeds the logical encoded source');
  }
  sourceFrameByteOffsetUnchecked(descriptor, descriptor.targetSourceFrame);
  expectedOutputFramesUnchecked(descriptor);
}

/** O(1) frame-to-byte mapping. The end frame is valid. */
export function linearPcmSourceFrameByteOffset(
  descriptor: LinearPcmStreamDescriptor,
  sourceFrame: number,
): number {
  validateLinearPcmStreamDescriptor(descriptor);
  requireSafeInteger(sourceFrame, 'sourceFrame', 0, descriptor.totalSourceFrames);
  return sourceFrameByteOffsetUnchecked(descriptor, sourceFrame);
}

export function remainingLinearPcmSourceFrames(descriptor: LinearPcmStreamDescriptor): number {
  validateLinearPcmStreamDescriptor(descriptor);
  return descriptor.totalSourceFrames - descriptor.targetSourceFrame;
}

export function expectedLinearPcmOutputFrames(descriptor: LinearPcmStreamDescriptor): number {
  validateLinearPcmStreamDescriptor(descriptor);
  return expectedOutputFramesUnchecked(descriptor);
}

export function linearPcmOutputFrameAtTarget(descriptor: LinearPcmStreamDescriptor): number {
  validateLinearPcmStreamDescriptor(descriptor);
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

export function maximumLinearPcmInputFramesPerRead(descriptor: LinearPcmStreamDescriptor): number {
  validateLinearPcmStreamDescriptor(descriptor);
  return Math.floor(LINEAR_PCM_STREAM_MAX_READ_BYTES / descriptor.blockAlign);
}

/** Plan one input read under the encoded-byte and PCM-message ceilings. */
export function planLinearPcmInputRead(
  descriptor: LinearPcmStreamDescriptor,
  sourceFrame: number,
  maximumFrames = LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES,
): Readonly<LinearPcmInputReadPlan> | null {
  validateLinearPcmStreamDescriptor(descriptor);
  requireSafeInteger(
    sourceFrame,
    'sourceFrame',
    descriptor.targetSourceFrame,
    descriptor.totalSourceFrames,
  );
  requireSafeInteger(maximumFrames, 'maximumFrames', 1, LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES);
  if (sourceFrame === descriptor.totalSourceFrames) return null;
  const remaining = descriptor.totalSourceFrames - sourceFrame;
  const frames = Math.min(remaining, maximumFrames, maximumLinearPcmInputFramesPerRead(descriptor));
  const bytes = frames * descriptor.blockAlign;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > LINEAR_PCM_STREAM_MAX_READ_BYTES) {
    throw new RangeError('planned linear PCM read exceeds its encoded byte bound');
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
  if (!(view instanceof DataView)) {
    throw new TypeError('linear PCM scalar input must be a DataView');
  }
  requireSafeInteger(byteOffset, 'byteOffset', 0);
  if (byteOffset + sampleBytes > view.byteLength) {
    throw new RangeError('linear PCM scalar exceeds the supplied byte view');
  }
}

function requireZeroUnusedBits(unsigned: number, containerBits: number, validBits: number): void {
  const unusedBits = containerBits - validBits;
  if (unusedBits === 0) return;
  const divisor = 2 ** unusedBits;
  if (unsigned % divisor !== 0) {
    throw new LinearPcmDecodeError(
      'nonzero-unused-bits',
      'linear PCM has nonzero unused least-significant bits',
    );
  }
}

function decodeScalarUnchecked(
  view: DataView,
  byteOffset: number,
  encoding: LinearPcmEncoding,
  validBitsPerSample: number,
): number {
  switch (encoding) {
    case 'pcm-u8': {
      const unsigned = view.getUint8(byteOffset);
      requireZeroUnusedBits(unsigned, 8, validBitsPerSample);
      return (unsigned - 128) / 128;
    }
    case 'pcm-s8': {
      const unsigned = view.getUint8(byteOffset);
      requireZeroUnusedBits(unsigned, 8, validBitsPerSample);
      return view.getInt8(byteOffset) / 128;
    }
    case 'pcm-s16le': {
      const unsigned = view.getUint16(byteOffset, true);
      requireZeroUnusedBits(unsigned, 16, validBitsPerSample);
      return view.getInt16(byteOffset, true) / 32_768;
    }
    case 'pcm-s16be': {
      const unsigned = view.getUint16(byteOffset, false);
      requireZeroUnusedBits(unsigned, 16, validBitsPerSample);
      return view.getInt16(byteOffset, false) / 32_768;
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
    case 'pcm-s24be': {
      const unsigned =
        (view.getUint8(byteOffset) << 16) |
        (view.getUint8(byteOffset + 1) << 8) |
        view.getUint8(byteOffset + 2);
      requireZeroUnusedBits(unsigned, 24, validBitsPerSample);
      const signed = (unsigned & 0x80_0000) === 0 ? unsigned : unsigned - 0x1_000000;
      return signed / 8_388_608;
    }
    case 'pcm-s32le': {
      const unsigned = view.getUint32(byteOffset, true);
      requireZeroUnusedBits(unsigned, 32, validBitsPerSample);
      return view.getInt32(byteOffset, true) / 2_147_483_648;
    }
    case 'pcm-s32be': {
      const unsigned = view.getUint32(byteOffset, false);
      requireZeroUnusedBits(unsigned, 32, validBitsPerSample);
      return view.getInt32(byteOffset, false) / 2_147_483_648;
    }
    case 'float32le': {
      const value = view.getFloat32(byteOffset, true);
      return Number.isFinite(value) ? value : 0;
    }
    case 'float32be': {
      const value = view.getFloat32(byteOffset, false);
      return Number.isFinite(value) ? value : 0;
    }
    case 'float64le': {
      const value = view.getFloat64(byteOffset, true);
      return Number.isFinite(value) ? value : 0;
    }
    case 'float64be': {
      const value = view.getFloat64(byteOffset, false);
      return Number.isFinite(value) ? value : 0;
    }
  }
}

/** Decode one scalar and enforce left-aligned integer padding. */
export function decodeLinearPcmScalar(
  view: DataView,
  byteOffset: number,
  layout: LinearPcmSampleLayout,
): number {
  validateLinearPcmSampleLayout(layout);
  const encoding = encodingLayout(layout.encoding);
  validateScalarOffset(view, byteOffset, encoding.bytes);
  return decodeScalarUnchecked(view, byteOffset, layout.encoding, layout.validBitsPerSample);
}

/** Deinterleave one bounded encoded read into worker-owned planar Float32 PCM. */
export function decodeInterleavedLinearPcm(
  bytes: Uint8Array,
  layout: LinearPcmSampleLayout,
): Readonly<DecodedLinearPcm> {
  validateLinearPcmSampleLayout(layout);
  const encoding = encodingLayout(layout.encoding);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('linear PCM input must be a Uint8Array');
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > LINEAR_PCM_STREAM_MAX_READ_BYTES) {
    throw new RangeError(
      `linear PCM input must contain from 1 through ${LINEAR_PCM_STREAM_MAX_READ_BYTES} bytes`,
    );
  }
  if (bytes.byteLength % layout.blockAlign !== 0) {
    throw new RangeError('linear PCM input is not a whole number of interleaved frames');
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
