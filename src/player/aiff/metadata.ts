import type { LinearPcmEncoding, LinearPcmMetadata } from '../linear-pcm/sample-format.js';
import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';

export const AIFF_MAX_CHANNELS = 8;
export const AIFF_MAX_SAMPLE_RATE_HZ = 1_000_000;
export const AIFF_MAX_CHUNKS = 1_024;
/**
 * Maximum bytes returned by any single metadata read. Odd chunk padding is
 * verified independently with an exact one-byte read.
 */
export const AIFF_MAX_METADATA_READ_BYTES = 278;

const FORM_CHUNK = 'FORM';
const AIFF_FORM = 'AIFF';
const AIFC_FORM = 'AIFC';
const COMM_CHUNK = 'COMM';
const FVER_CHUNK = 'FVER';
const SSND_CHUNK = 'SSND';
const AIFC_VERSION_1 = 0xa280_5140;
const EXTENDED_EXPONENT_BIAS = 16_383;
const EXTENDED_INTEGER_BIT = 1n << 63n;

export type AiffContainer = 'aiff' | 'aifc';

/** AIFF-facing names for layouts consumed by the bounded linear-PCM path. */
export type AiffPcmEncoding = Extract<
  LinearPcmEncoding,
  | 'pcm-s8'
  | 'pcm-s16be'
  | 'pcm-s24be'
  | 'pcm-s32be'
  | 'pcm-s16le'
  | 'pcm-s24le'
  | 'pcm-s32le'
  | 'float32be'
  | 'float64be'
>;

export type AiffCompressionType = 'NONE' | 'twos' | 'sowt' | 'fl32' | 'fl64';

export interface AiffPcmMetadata extends LinearPcmMetadata {
  readonly format: 'aiff';
  readonly container: AiffContainer;
  readonly encoding: AiffPcmEncoding;
  readonly compressionType: AiffCompressionType;
  /** AIFC's validated Pascal compression name; null for classic AIFF. */
  readonly compressionName: string | null;
  readonly sourceSampleRate: number;
  readonly channels: number;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  readonly blockAlign: number;
  readonly byteRate: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly totalSourceFrames: number;
  readonly durationSeconds: number;
  readonly logicalFileBytes: number;
  readonly ssndOffset: number;
  readonly ssndBlockSize: number;
}

/** The FORM source is structurally readable but is not AIFF or AIFC. */
export class UnsupportedAiffContainerError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAiffContainerError';
  }
}

/** The AIFF-family source uses a sample representation outside the bounded PCM engine. */
export class UnsupportedAiffCodecError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAiffCodecError';
  }
}

interface CommonFields {
  readonly channels: number;
  readonly totalSourceFrames: number;
  readonly sampleSize: number;
  readonly sourceSampleRate: number;
  readonly compressionType: string;
  readonly compressionName: string | null;
}

interface LocatedSoundData {
  readonly bodyOffset: number;
  readonly chunkBytes: number;
  readonly offset: number;
  readonly blockSize: number;
}

interface SampleLayout {
  readonly encoding: AiffPcmEncoding;
  readonly compressionType: AiffCompressionType;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
}

function fourCc(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function readChunkId(bytes: Uint8Array): string {
  let trailingSpaceStarted = false;
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[index] ?? 0;
    if (value < 0x20 || value > 0x7e) {
      throw new EncodedSourceIntegrityError('AIFF chunk ID must contain printable ASCII');
    }
    if (value === 0x20) {
      trailingSpaceStarted = true;
    } else if (trailingSpaceStarted) {
      throw new EncodedSourceIntegrityError(
        'AIFF chunk ID spaces may only appear as trailing characters',
      );
    }
  }
  return fourCc(bytes);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new EncodedSourceIntegrityError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new EncodedSourceIntegrityError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function paddedChunkEnd(bodyOffset: number, bodyBytes: number, label: string): number {
  const bodyEnd = safeAdd(bodyOffset, bodyBytes, `${label} end`);
  return safeAdd(bodyEnd, bodyBytes % 2, `${label} padded end`);
}

async function readExact(
  source: EncodedAudioSource,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  validateExactRead(source.size, offset, length);
  throwIfAborted(signal);
  const bytes = await source.readAt(offset, length, signal);
  throwIfAborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new EncodedSourceIntegrityError(
      `AIFF metadata read returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
    );
  }
  return bytes;
}

/** Decode a canonical positive, finite, integer IEEE 754 80-bit extended value. */
function readExtendedSampleRate(bytes: Uint8Array): number {
  if (bytes.byteLength !== 10) {
    throw new EncodedSourceIntegrityError('AIFF sample rate must occupy exactly 10 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signAndExponent = view.getUint16(0, false);
  const negative = (signAndExponent & 0x8000) !== 0;
  const exponent = signAndExponent & 0x7fff;
  const significand = view.getBigUint64(2, false);
  if (negative) {
    throw new EncodedSourceIntegrityError('AIFF sample rate must be positive');
  }
  if (exponent === 0 || exponent === 0x7fff || (significand & EXTENDED_INTEGER_BIT) === 0n) {
    throw new EncodedSourceIntegrityError(
      'AIFF sample rate must be a canonical finite normalized value',
    );
  }

  const binaryShift = exponent - EXTENDED_EXPONENT_BIAS - 63;
  let integerValue: bigint;
  if (binaryShift >= 0) {
    integerValue = significand << BigInt(binaryShift);
  } else {
    const divisorShift = -binaryShift;
    if (divisorShift > 63) {
      throw new EncodedSourceIntegrityError('AIFF sample rate must be an integer');
    }
    const remainderMask = (1n << BigInt(divisorShift)) - 1n;
    if ((significand & remainderMask) !== 0n) {
      throw new EncodedSourceIntegrityError('AIFF sample rate must be an integer');
    }
    integerValue = significand >> BigInt(divisorShift);
  }

  if (integerValue < 1n || integerValue > BigInt(AIFF_MAX_SAMPLE_RATE_HZ)) {
    throw new EncodedSourceIntegrityError(
      `AIFF sample rate must be from 1 through ${AIFF_MAX_SAMPLE_RATE_HZ} Hz`,
    );
  }
  return Number(integerValue);
}

function parseCommonPrefix(
  bytes: Uint8Array,
): Omit<CommonFields, 'compressionType' | 'compressionName'> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(0, false);
  const totalSourceFrames = view.getUint32(2, false);
  const sampleSize = view.getUint16(6, false);
  if (channels < 1 || channels > AIFF_MAX_CHANNELS) {
    throw new EncodedSourceIntegrityError(
      `AIFF channel count must be from 1 through ${AIFF_MAX_CHANNELS}`,
    );
  }
  if (totalSourceFrames < 1) {
    throw new EncodedSourceIntegrityError('AIFF must contain at least one sample frame');
  }
  return {
    channels,
    totalSourceFrames,
    sampleSize,
    sourceSampleRate: readExtendedSampleRate(bytes.subarray(8, 18)),
  };
}

async function readCommon(
  source: EncodedAudioSource,
  container: AiffContainer,
  bodyOffset: number,
  chunkBytes: number,
  signal: AbortSignal,
): Promise<CommonFields> {
  if (container === 'aiff') {
    if (chunkBytes !== 18) {
      throw new EncodedSourceIntegrityError('AIFF COMM chunk must be exactly 18 bytes');
    }
    const bytes = await readExact(source, bodyOffset, 18, signal);
    return Object.freeze({
      ...parseCommonPrefix(bytes),
      compressionType: 'NONE',
      compressionName: null,
    });
  }

  if (chunkBytes < 24) {
    throw new EncodedSourceIntegrityError('AIFC COMM chunk has a truncated compression name');
  }
  const prefix = await readExact(source, bodyOffset, 23, signal);
  const nameBytes = prefix[22] ?? 0;
  const rawPascalBytes = safeAdd(1, nameBytes, 'AIFC compression name');
  const paddedPascalBytes = safeAdd(
    rawPascalBytes,
    rawPascalBytes % 2,
    'AIFC compression name padding',
  );
  const expectedBytes = safeAdd(22, paddedPascalBytes, 'AIFC COMM size');
  if (expectedBytes > AIFF_MAX_METADATA_READ_BYTES) {
    throw new EncodedSourceIntegrityError('AIFC COMM metadata exceeds the bounded read ceiling');
  }
  if (chunkBytes !== expectedBytes) {
    throw new EncodedSourceIntegrityError(
      'AIFC COMM chunk size does not exactly match its Pascal compression name',
    );
  }
  const bytes = await readExact(source, bodyOffset, expectedBytes, signal);
  if (rawPascalBytes % 2 !== 0 && bytes[23 + nameBytes] !== 0) {
    throw new EncodedSourceIntegrityError('AIFC compression-name padding byte must be zero');
  }
  const compressionName = String.fromCharCode(...bytes.subarray(23, 23 + nameBytes));
  return Object.freeze({
    ...parseCommonPrefix(bytes.subarray(0, 18)),
    compressionType: fourCc(bytes, 18),
    compressionName,
  });
}

function pcmEncoding(
  sampleSize: number,
  endian: 'big' | 'little',
): Pick<SampleLayout, 'encoding' | 'containerBitsPerSample'> {
  if (sampleSize < 1 || sampleSize > 32) {
    throw new UnsupportedAiffCodecError(
      `AIFF integer PCM uses an unsupported ${sampleSize}-bit sample container`,
    );
  }
  if (sampleSize <= 8) {
    return { encoding: 'pcm-s8', containerBitsPerSample: 8 };
  }
  if (sampleSize <= 16) {
    return {
      encoding: endian === 'big' ? 'pcm-s16be' : 'pcm-s16le',
      containerBitsPerSample: 16,
    };
  }
  if (sampleSize <= 24) {
    return {
      encoding: endian === 'big' ? 'pcm-s24be' : 'pcm-s24le',
      containerBitsPerSample: 24,
    };
  }
  return {
    encoding: endian === 'big' ? 'pcm-s32be' : 'pcm-s32le',
    containerBitsPerSample: 32,
  };
}

function sampleLayout(common: CommonFields): SampleLayout {
  const compressionType = common.compressionType;
  if (compressionType === 'NONE' || compressionType === 'twos') {
    return { compressionType, ...pcmEncoding(common.sampleSize, 'big') };
  }
  if (compressionType === 'sowt') {
    return { compressionType, ...pcmEncoding(common.sampleSize, 'little') };
  }
  if (compressionType === 'fl32') {
    if (common.sampleSize !== 32) {
      throw new UnsupportedAiffCodecError('AIFC fl32 must use a 32-bit sample container');
    }
    return { compressionType, encoding: 'float32be', containerBitsPerSample: 32 };
  }
  if (compressionType === 'fl64') {
    if (common.sampleSize !== 64) {
      throw new UnsupportedAiffCodecError('AIFC fl64 must use a 64-bit sample container');
    }
    return { compressionType, encoding: 'float64be', containerBitsPerSample: 64 };
  }
  throw new UnsupportedAiffCodecError(
    `AIFC compression ${JSON.stringify(compressionType)} is not supported`,
  );
}

/**
 * Parse uncompressed AIFF/AIFC metadata with bounded, abort-aware random reads.
 * Sample payload and SSND offset bytes are never materialized.
 */
export async function readAiffPcmMetadata(
  source: EncodedAudioSource,
  signal: AbortSignal,
): Promise<Readonly<AiffPcmMetadata>> {
  if (!source || typeof source.readAt !== 'function') {
    throw new TypeError('AIFF metadata requires an encoded audio source');
  }
  validateExactRead(source.size, 0, 0);
  if (source.size < 12) {
    throw new EncodedSourceIntegrityError('AIFF source is shorter than its FORM header');
  }
  throwIfAborted(signal);

  const top = await readExact(source, 0, 12, signal);
  if (fourCc(top) !== FORM_CHUNK) {
    throw new UnsupportedAiffContainerError('AIFF source does not begin with a FORM chunk');
  }
  const formType = fourCc(top, 8);
  const container: AiffContainer =
    formType === AIFF_FORM
      ? 'aiff'
      : formType === AIFC_FORM
        ? 'aifc'
        : (() => {
            throw new UnsupportedAiffContainerError(
              `FORM type ${JSON.stringify(formType)} is not AIFF or AIFC`,
            );
          })();
  const formBytes = new DataView(top.buffer, top.byteOffset, top.byteLength).getUint32(4, false);
  const logicalFileBytes = safeAdd(formBytes, 8, 'AIFF FORM size');
  if (logicalFileBytes !== source.size || logicalFileBytes < 12) {
    throw new EncodedSourceIntegrityError(
      'AIFF FORM logical size does not exactly match the encoded source',
    );
  }

  let common: CommonFields | null = null;
  let soundData: LocatedSoundData | null = null;
  let versionSeen = false;
  let cursor = 12;
  let chunkCount = 0;
  while (cursor < logicalFileBytes) {
    chunkCount += 1;
    if (chunkCount > AIFF_MAX_CHUNKS) {
      throw new EncodedSourceIntegrityError('AIFF contains too many chunks');
    }
    const headerEnd = safeAdd(cursor, 8, 'AIFF chunk header end');
    if (headerEnd > logicalFileBytes) {
      throw new EncodedSourceIntegrityError('AIFF ends inside a chunk header');
    }
    const header = await readExact(source, cursor, 8, signal);
    const chunkId = readChunkId(header);
    const chunkBytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      4,
      false,
    );
    const bodyOffset = headerEnd;
    const nextCursor = paddedChunkEnd(bodyOffset, chunkBytes, `AIFF ${chunkId} chunk`);
    if (nextCursor > logicalFileBytes) {
      throw new EncodedSourceIntegrityError(
        `AIFF chunk ${JSON.stringify(chunkId)} exceeds the FORM boundary`,
      );
    }
    if (chunkBytes % 2 !== 0) {
      const padding = await readExact(source, nextCursor - 1, 1, signal);
      if (padding[0] !== 0) {
        throw new EncodedSourceIntegrityError(
          `AIFF chunk ${JSON.stringify(chunkId)} has a nonzero padding byte`,
        );
      }
    }

    if (chunkId === COMM_CHUNK) {
      if (common) throw new EncodedSourceIntegrityError('AIFF contains duplicate COMM chunks');
      common = await readCommon(source, container, bodyOffset, chunkBytes, signal);
    } else if (chunkId === SSND_CHUNK) {
      if (soundData) throw new EncodedSourceIntegrityError('AIFF contains duplicate SSND chunks');
      if (chunkBytes < 8) {
        throw new EncodedSourceIntegrityError('AIFF SSND chunk is shorter than 8 bytes');
      }
      const fields = await readExact(source, bodyOffset, 8, signal);
      const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
      soundData = Object.freeze({
        bodyOffset,
        chunkBytes,
        offset: view.getUint32(0, false),
        blockSize: view.getUint32(4, false),
      });
    } else if (chunkId === FVER_CHUNK && container === 'aifc') {
      if (versionSeen) throw new EncodedSourceIntegrityError('AIFC contains duplicate FVER chunks');
      versionSeen = true;
      if (chunkBytes !== 4) {
        throw new EncodedSourceIntegrityError('AIFC FVER chunk must be exactly 4 bytes');
      }
      const version = await readExact(source, bodyOffset, 4, signal);
      if (
        new DataView(version.buffer, version.byteOffset, version.byteLength).getUint32(0, false) !==
        AIFC_VERSION_1
      ) {
        throw new EncodedSourceIntegrityError('AIFC FVER version is not 0xA2805140');
      }
    }
    cursor = nextCursor;
  }

  if (cursor !== logicalFileBytes) {
    throw new EncodedSourceIntegrityError('AIFF traversal did not end at the FORM boundary');
  }
  if (container === 'aifc' && !versionSeen) {
    throw new EncodedSourceIntegrityError('AIFC FVER chunk is missing');
  }
  if (!common) throw new EncodedSourceIntegrityError('AIFF COMM chunk is missing');
  if (!soundData) throw new EncodedSourceIntegrityError('AIFF SSND chunk is missing');

  const layout = sampleLayout(common);
  const bytesPerSample = layout.containerBitsPerSample / 8;
  const blockAlign = safeMultiply(common.channels, bytesPerSample, 'AIFF block alignment');
  const byteRate = safeMultiply(common.sourceSampleRate, blockAlign, 'AIFF byte rate');
  const expectedFrameBytes = safeMultiply(
    common.totalSourceFrames,
    blockAlign,
    'AIFF sample-frame bytes',
  );
  const ssndPayloadBytes = soundData.chunkBytes - 8;
  if (soundData.offset > ssndPayloadBytes) {
    throw new EncodedSourceIntegrityError('AIFF SSND offset exceeds its sound-data payload');
  }
  if (soundData.blockSize !== 0) {
    if (soundData.offset >= soundData.blockSize) {
      throw new EncodedSourceIntegrityError('AIFF SSND offset must be smaller than blockSize');
    }
  }
  const availableFrameBytes = ssndPayloadBytes - soundData.offset;
  if (availableFrameBytes < expectedFrameBytes) {
    throw new EncodedSourceIntegrityError(
      'AIFF SSND does not contain all sample frames declared by COMM',
    );
  }
  const dataOffset = safeAdd(
    safeAdd(soundData.bodyOffset, 8, 'AIFF SSND data prefix'),
    soundData.offset,
    'AIFF SSND data offset',
  );

  return Object.freeze({
    format: 'aiff',
    container,
    encoding: layout.encoding,
    compressionType: layout.compressionType,
    compressionName: common.compressionName,
    sourceSampleRate: common.sourceSampleRate,
    channels: common.channels,
    containerBitsPerSample: layout.containerBitsPerSample,
    validBitsPerSample: common.sampleSize,
    blockAlign,
    byteRate,
    dataOffset,
    dataBytes: expectedFrameBytes,
    totalSourceFrames: common.totalSourceFrames,
    durationSeconds: common.totalSourceFrames / common.sourceSampleRate,
    logicalFileBytes,
    ssndOffset: soundData.offset,
    ssndBlockSize: soundData.blockSize,
  });
}
