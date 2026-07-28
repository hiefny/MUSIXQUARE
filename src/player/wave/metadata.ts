import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import type { LinearPcmEncoding } from '../linear-pcm/sample-format.js';

export const WAVE_MAX_CHANNELS = 8;
export const WAVE_MAX_SAMPLE_RATE_HZ = 1_000_000;
export const WAVE_MAX_CHUNKS = 1_024;
export const WAVE_MAX_DS64_TABLE_ENTRIES = 4_096;
export const WAVE_MAX_FMT_BYTES = 64 * 1_024;

const RIFF_MARKER = 'RIFF';
const RF64_MARKER = 'RF64';
const BW64_MARKER = 'BW64';
const RIFX_MARKER = 'RIFX';
const WAVE64_MARKER = 'riff';
const WAVE_MARKER = 'WAVE';
const DS64_CHUNK = 'ds64';
const FMT_CHUNK = 'fmt ';
const DATA_CHUNK = 'data';
const UINT32_PLACEHOLDER = 0xffff_ffff;
const DS64_FIXED_BYTES = 28;
const DS64_TABLE_ENTRY_BYTES = 12;
const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const SUBFORMAT_GUID_SUFFIX = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

export type WaveContainer = 'riff' | 'rf64' | 'bw64';

/** Encodings admitted by the little-endian RIFF/RF64/BW64 parser. */
export type WavePcmEncoding = Extract<
  LinearPcmEncoding,
  'pcm-u8' | 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'float32le' | 'float64le'
>;

export interface WavePcmMetadata {
  readonly format: 'wave';
  readonly container: WaveContainer;
  readonly encoding: WavePcmEncoding;
  readonly formatTag: 0x0001 | 0x0003 | 0xfffe;
  readonly sourceSampleRate: number;
  readonly channels: number;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  readonly blockAlign: number;
  readonly byteRate: number;
  /** Zero means the source deliberately leaves channel positions unspecified. */
  readonly channelMask: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly totalSourceFrames: number;
  readonly durationSeconds: number;
  readonly logicalFileBytes: number;
  /** RF64 sampleCount, or null for RIFF, BW64, and an RF64 zero/unknown value. */
  readonly rf64SampleCount: number | null;
}

/** The byte stream is WAVE-family data, but its container is intentionally unsupported. */
export class UnsupportedWaveContainerError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWaveContainerError';
  }
}

/** The WAVE container is valid enough to identify a codec outside the bounded PCM engine. */
export class UnsupportedWaveCodecError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWaveCodecError';
  }
}

interface ParsedFormat {
  readonly encoding: WavePcmEncoding;
  readonly formatTag: 0x0001 | 0x0003 | 0xfffe;
  readonly sourceSampleRate: number;
  readonly channels: number;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  readonly blockAlign: number;
  readonly byteRate: number;
  readonly channelMask: number;
}

interface Ds64TableEntry {
  readonly chunkId: string;
  readonly size: number;
  consumed: boolean;
}

interface Ds64Metadata {
  readonly riffSize: number;
  readonly dataSize: number;
  readonly rf64SampleCount: number | null;
  readonly table: Ds64TableEntry[];
}

interface LocatedDataChunk {
  readonly offset: number;
  readonly bytes: number;
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function fourCc(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
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

function safeUint64(value: bigint, label: string): number {
  if (value > MAX_SAFE_BIGINT) {
    throw new EncodedSourceIntegrityError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
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
      `WAVE metadata read returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
    );
  }
  return bytes;
}

function countSetBits(value: number): number {
  let remaining = value >>> 0;
  let count = 0;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function subformatTag(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 16 > bytes.byteLength) return null;
  for (let index = 0; index < SUBFORMAT_GUID_SUFFIX.byteLength; index += 1) {
    if (bytes[offset + 2 + index] !== SUBFORMAT_GUID_SUFFIX[index]) return null;
  }
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function unsupportedFormatTag(formatTag: number): UnsupportedWaveCodecError {
  return new UnsupportedWaveCodecError(
    `WAVE codec format tag 0x${formatTag.toString(16).padStart(4, '0')} is not supported; bounded playback requires PCM or IEEE float`,
  );
}

function encodingForFormat(
  codecTag: number,
  bitsPerSample: number,
): {
  readonly encoding: WavePcmEncoding;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
} {
  if (codecTag === WAVE_FORMAT_PCM) {
    if (bitsPerSample === 8) return { encoding: 'pcm-u8', containerBitsPerSample: 8 };
    if (bitsPerSample === 16) return { encoding: 'pcm-s16le', containerBitsPerSample: 16 };
    if (bitsPerSample === 24) return { encoding: 'pcm-s24le', containerBitsPerSample: 24 };
    if (bitsPerSample === 32) return { encoding: 'pcm-s32le', containerBitsPerSample: 32 };
    throw new UnsupportedWaveCodecError(
      `WAVE PCM uses an unsupported ${bitsPerSample}-bit sample container`,
    );
  }
  if (codecTag === WAVE_FORMAT_IEEE_FLOAT) {
    if (bitsPerSample === 32) return { encoding: 'float32le', containerBitsPerSample: 32 };
    if (bitsPerSample === 64) return { encoding: 'float64le', containerBitsPerSample: 64 };
    throw new UnsupportedWaveCodecError(
      `WAVE IEEE float uses an unsupported ${bitsPerSample}-bit sample container`,
    );
  }
  throw unsupportedFormatTag(codecTag);
}

function parseFormat(bytes: Uint8Array, declaredBytes: number): ParsedFormat {
  if (declaredBytes < 16 || bytes.byteLength < Math.min(declaredBytes, 16)) {
    throw new EncodedSourceIntegrityError('WAVE fmt chunk is shorter than 16 bytes');
  }
  if (declaredBytes > WAVE_MAX_FMT_BYTES) {
    throw new EncodedSourceIntegrityError('WAVE fmt chunk is unreasonably large');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatTag = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sourceSampleRate = view.getUint32(4, true);
  const byteRate = view.getUint32(8, true);
  const blockAlign = view.getUint16(12, true);
  const bitsPerSample = view.getUint16(14, true);

  if (channels < 1 || channels > WAVE_MAX_CHANNELS) {
    throw new EncodedSourceIntegrityError(
      `WAVE channel count must be from 1 through ${WAVE_MAX_CHANNELS}`,
    );
  }
  if (sourceSampleRate < 1 || sourceSampleRate > WAVE_MAX_SAMPLE_RATE_HZ) {
    throw new EncodedSourceIntegrityError(
      `WAVE sample rate must be from 1 through ${WAVE_MAX_SAMPLE_RATE_HZ} Hz`,
    );
  }

  let codecTag = formatTag;
  let validBitsPerSample = bitsPerSample;
  let channelMask = 0;
  if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
    if (declaredBytes < 40 || bytes.byteLength < 40) {
      throw new EncodedSourceIntegrityError(
        'WAVE_FORMAT_EXTENSIBLE fmt chunk is shorter than 40 bytes',
      );
    }
    const extensionBytes = view.getUint16(16, true);
    if (extensionBytes < 22 || safeAdd(18, extensionBytes, 'WAVE fmt extension') > declaredBytes) {
      throw new EncodedSourceIntegrityError('WAVE_FORMAT_EXTENSIBLE has an invalid cbSize');
    }
    validBitsPerSample = view.getUint16(18, true);
    channelMask = view.getUint32(20, true);
    const parsedSubformat = subformatTag(bytes, 24);
    if (parsedSubformat !== WAVE_FORMAT_PCM && parsedSubformat !== WAVE_FORMAT_IEEE_FLOAT) {
      throw new UnsupportedWaveCodecError(
        'WAVE_FORMAT_EXTENSIBLE subformat is not PCM or IEEE float',
      );
    }
    codecTag = parsedSubformat;
  } else {
    if (formatTag !== WAVE_FORMAT_PCM && formatTag !== WAVE_FORMAT_IEEE_FLOAT) {
      throw unsupportedFormatTag(formatTag);
    }
    if (declaredBytes === 17) {
      throw new EncodedSourceIntegrityError('WAVE fmt extension is truncated');
    }
    if (declaredBytes >= 18) {
      if (bytes.byteLength < 18) {
        throw new EncodedSourceIntegrityError('WAVE fmt extension is truncated');
      }
      const extensionBytes = view.getUint16(16, true);
      if (safeAdd(18, extensionBytes, 'WAVE fmt extension') > declaredBytes) {
        throw new EncodedSourceIntegrityError('WAVE fmt cbSize exceeds the chunk');
      }
    }
  }

  const { encoding, containerBitsPerSample } = encodingForFormat(codecTag, bitsPerSample);
  if (validBitsPerSample < 1 || validBitsPerSample > containerBitsPerSample) {
    throw new EncodedSourceIntegrityError('WAVE valid bits per sample exceed the sample container');
  }
  if (codecTag === WAVE_FORMAT_IEEE_FLOAT && validBitsPerSample !== containerBitsPerSample) {
    throw new EncodedSourceIntegrityError(
      'WAVE IEEE float valid bits must equal its sample container size',
    );
  }
  if (channelMask !== 0 && countSetBits(channelMask) !== channels) {
    throw new EncodedSourceIntegrityError(
      'WAVE channel mask population does not match the channel count',
    );
  }

  const bytesPerSample = containerBitsPerSample / 8;
  const expectedBlockAlign = safeMultiply(channels, bytesPerSample, 'WAVE block alignment');
  if (blockAlign !== expectedBlockAlign) {
    throw new EncodedSourceIntegrityError('WAVE blockAlign contradicts its channel/sample layout');
  }
  const expectedByteRate = safeMultiply(sourceSampleRate, expectedBlockAlign, 'WAVE byte rate');
  if (byteRate !== expectedByteRate) {
    throw new EncodedSourceIntegrityError('WAVE byteRate contradicts its sample rate and layout');
  }

  return Object.freeze({
    encoding,
    formatTag: formatTag as 0x0001 | 0x0003 | 0xfffe,
    sourceSampleRate,
    channels,
    containerBitsPerSample,
    validBitsPerSample,
    blockAlign,
    byteRate,
    channelMask,
  });
}

function parseDs64(bytes: Uint8Array, container: 'rf64' | 'bw64'): Ds64Metadata {
  if (bytes.byteLength < DS64_FIXED_BYTES) {
    throw new EncodedSourceIntegrityError('WAVE ds64 chunk is shorter than 28 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableLength = view.getUint32(24, true);
  if (tableLength > WAVE_MAX_DS64_TABLE_ENTRIES) {
    throw new EncodedSourceIntegrityError('WAVE ds64 table has too many entries');
  }
  const tableBytes = safeMultiply(tableLength, DS64_TABLE_ENTRY_BYTES, 'WAVE ds64 table size');
  const expectedBytes = safeAdd(DS64_FIXED_BYTES, tableBytes, 'WAVE ds64 size');
  if (bytes.byteLength !== expectedBytes) {
    throw new EncodedSourceIntegrityError('WAVE ds64 chunk size contradicts its table length');
  }

  const riffSize = safeUint64(view.getBigUint64(0, true), 'WAVE 64-bit RIFF size');
  const dataSize = safeUint64(view.getBigUint64(8, true), 'WAVE 64-bit data size');
  // RF64 assigns this slot to sampleCount. Current BW64 assigns it to a dummy
  // compatibility value, which is deliberately not interpreted or converted.
  const rawThirdValue = view.getBigUint64(16, true);
  const rf64SampleCount =
    container === 'rf64' && rawThirdValue !== 0n
      ? safeUint64(rawThirdValue, 'RF64 sample count')
      : null;
  const table: Ds64TableEntry[] = [];
  for (let index = 0; index < tableLength; index += 1) {
    const offset = DS64_FIXED_BYTES + index * DS64_TABLE_ENTRY_BYTES;
    table.push({
      chunkId: fourCc(bytes, offset),
      size: safeUint64(view.getBigUint64(offset + 4, true), 'WAVE ds64 chunk size'),
      consumed: false,
    });
  }
  return Object.freeze({ riffSize, dataSize, rf64SampleCount, table });
}

function consumeDs64TableSize(ds64: Ds64Metadata, chunkId: string): number {
  const entry = ds64.table.find(
    (candidate) => !candidate.consumed && candidate.chunkId === chunkId,
  );
  if (!entry) {
    throw new EncodedSourceIntegrityError(
      `WAVE chunk ${JSON.stringify(chunkId)} uses a 64-bit placeholder without a ds64 entry`,
    );
  }
  entry.consumed = true;
  return entry.size;
}

function resolveChunkSize(chunkId: string, rawSize: number, ds64: Ds64Metadata | null): number {
  if (rawSize !== UINT32_PLACEHOLDER) return rawSize;
  if (!ds64) {
    throw new EncodedSourceIntegrityError('RIFF/WAVE uses a 64-bit chunk placeholder without ds64');
  }
  if (chunkId === DATA_CHUNK) return ds64.dataSize;
  return consumeDs64TableSize(ds64, chunkId);
}

function readContainer(marker: string): WaveContainer {
  if (marker === RIFF_MARKER) return 'riff';
  if (marker === RF64_MARKER) return 'rf64';
  if (marker === BW64_MARKER) return 'bw64';
  if (marker === RIFX_MARKER) {
    throw new UnsupportedWaveContainerError('Big-endian RIFX/WAVE is not supported');
  }
  if (marker === WAVE64_MARKER) {
    throw new UnsupportedWaveContainerError('Sony Wave64 is not supported');
  }
  throw new EncodedSourceIntegrityError('WAVE source does not use a RIFF, RF64, or BW64 container');
}

/**
 * Parse PCM/IEEE-float WAVE metadata using bounded, abort-aware random reads.
 *
 * Audio payload bytes are never read. Unknown chunks are skipped by their
 * validated offsets, including multi-gigabyte data and broadcast metadata.
 */
export async function readWavePcmMetadata(
  source: EncodedAudioSource,
  signal: AbortSignal,
): Promise<Readonly<WavePcmMetadata>> {
  if (!source || typeof source.readAt !== 'function') {
    throw new TypeError('WAVE metadata requires an encoded audio source');
  }
  validateExactRead(source.size, 0, 0);
  if (source.size < 12) {
    throw new EncodedSourceIntegrityError('WAVE source is shorter than its RIFF header');
  }
  throwIfAborted(signal);

  const top = await readExact(source, 0, 12, signal);
  const marker = fourCc(top);
  const container = readContainer(marker);
  if (!matchesAscii(top, 8, WAVE_MARKER)) {
    throw new EncodedSourceIntegrityError('RIFF-family source does not declare WAVE data');
  }
  const topSize = new DataView(top.buffer, top.byteOffset, top.byteLength).getUint32(4, true);

  let ds64: Ds64Metadata | null = null;
  let logicalFileBytes: number;
  let cursor = 12;
  let chunkCount = 0;

  if (container === 'riff') {
    if (topSize === UINT32_PLACEHOLDER) {
      throw new EncodedSourceIntegrityError('RIFF/WAVE uses an RF64 size placeholder without RF64');
    }
    logicalFileBytes = safeAdd(topSize, 8, 'RIFF/WAVE logical size');
  } else {
    if (topSize !== UINT32_PLACEHOLDER) {
      throw new EncodedSourceIntegrityError(
        `${container.toUpperCase()} top-level size must be 0xffffffff`,
      );
    }
    if (source.size < 20) {
      throw new EncodedSourceIntegrityError(`${container.toUpperCase()} source has no ds64 chunk`);
    }
    const header = await readExact(source, cursor, 8, signal);
    chunkCount += 1;
    if (!matchesAscii(header, 0, DS64_CHUNK)) {
      throw new EncodedSourceIntegrityError(
        `${container.toUpperCase()} ds64 must be the first chunk`,
      );
    }
    const ds64Bytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      4,
      true,
    );
    const maximumDs64Bytes = safeAdd(
      DS64_FIXED_BYTES,
      safeMultiply(
        WAVE_MAX_DS64_TABLE_ENTRIES,
        DS64_TABLE_ENTRY_BYTES,
        'maximum WAVE ds64 table size',
      ),
      'maximum WAVE ds64 size',
    );
    if (ds64Bytes < DS64_FIXED_BYTES || ds64Bytes > maximumDs64Bytes) {
      throw new EncodedSourceIntegrityError('WAVE ds64 chunk has an invalid or unreasonable size');
    }
    const bodyOffset = safeAdd(cursor, 8, 'WAVE ds64 body offset');
    const physicalEnd = paddedChunkEnd(bodyOffset, ds64Bytes, 'WAVE ds64 chunk');
    if (physicalEnd > source.size) {
      throw new EncodedSourceIntegrityError('WAVE ds64 chunk exceeds the encoded source');
    }
    ds64 = parseDs64(await readExact(source, bodyOffset, ds64Bytes, signal), container);
    logicalFileBytes = safeAdd(ds64.riffSize, 8, '64-bit WAVE logical size');
    cursor = physicalEnd;
  }

  if (logicalFileBytes !== source.size || logicalFileBytes < cursor) {
    throw new EncodedSourceIntegrityError(
      'WAVE declared logical size does not exactly match the encoded source',
    );
  }

  let format: ParsedFormat | null = null;
  let data: LocatedDataChunk | null = null;
  while (cursor < logicalFileBytes) {
    chunkCount += 1;
    if (chunkCount > WAVE_MAX_CHUNKS) {
      throw new EncodedSourceIntegrityError('WAVE contains too many chunks');
    }
    const headerEnd = safeAdd(cursor, 8, 'WAVE chunk header end');
    if (headerEnd > logicalFileBytes) {
      throw new EncodedSourceIntegrityError('WAVE ends inside a chunk header');
    }
    const header = await readExact(source, cursor, 8, signal);
    const chunkId = fourCc(header);
    const rawSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      4,
      true,
    );
    if (chunkId === DS64_CHUNK) {
      throw new EncodedSourceIntegrityError('WAVE contains a duplicate or misplaced ds64 chunk');
    }
    const chunkBytes = resolveChunkSize(chunkId, rawSize, ds64);
    const bodyOffset = headerEnd;
    const nextCursor = paddedChunkEnd(bodyOffset, chunkBytes, `WAVE ${chunkId} chunk`);
    if (nextCursor > logicalFileBytes) {
      throw new EncodedSourceIntegrityError(
        `WAVE chunk ${JSON.stringify(chunkId)} exceeds the declared container`,
      );
    }

    if (chunkId === FMT_CHUNK) {
      if (format) throw new EncodedSourceIntegrityError('WAVE contains duplicate fmt chunks');
      if (chunkBytes > WAVE_MAX_FMT_BYTES) {
        throw new EncodedSourceIntegrityError('WAVE fmt chunk is unreasonably large');
      }
      const prefixBytes = Math.min(chunkBytes, 40);
      format = parseFormat(await readExact(source, bodyOffset, prefixBytes, signal), chunkBytes);
    } else if (chunkId === DATA_CHUNK) {
      if (data) throw new EncodedSourceIntegrityError('WAVE contains multiple data chunks');
      if (ds64 && rawSize !== UINT32_PLACEHOLDER && chunkBytes !== ds64.dataSize) {
        throw new EncodedSourceIntegrityError('WAVE data size contradicts ds64');
      }
      data = Object.freeze({ offset: bodyOffset, bytes: chunkBytes });
    }
    cursor = nextCursor;
  }

  if (cursor !== logicalFileBytes) {
    throw new EncodedSourceIntegrityError(
      'WAVE chunk traversal did not end at the container boundary',
    );
  }
  if (ds64?.table.some((entry) => !entry.consumed)) {
    throw new EncodedSourceIntegrityError('WAVE ds64 table contains unused chunk-size entries');
  }
  if (!format) throw new EncodedSourceIntegrityError('WAVE fmt chunk is missing');
  if (!data) throw new EncodedSourceIntegrityError('WAVE data chunk is missing');
  if (data.bytes <= 0) throw new EncodedSourceIntegrityError('WAVE data chunk is empty');
  if (data.bytes % format.blockAlign !== 0) {
    throw new EncodedSourceIntegrityError('WAVE data size is not a whole number of sample frames');
  }
  const totalSourceFrames = data.bytes / format.blockAlign;
  if (!Number.isSafeInteger(totalSourceFrames) || totalSourceFrames <= 0) {
    throw new EncodedSourceIntegrityError('WAVE has an invalid total sample-frame count');
  }
  if (
    ds64 !== null &&
    ds64.rf64SampleCount !== null &&
    ds64.rf64SampleCount !== totalSourceFrames
  ) {
    throw new EncodedSourceIntegrityError('RF64 sampleCount contradicts the PCM data size');
  }

  return Object.freeze({
    format: 'wave',
    container,
    ...format,
    dataOffset: data.offset,
    dataBytes: data.bytes,
    totalSourceFrames,
    durationSeconds: totalSourceFrames / format.sourceSampleRate,
    logicalFileBytes,
    rf64SampleCount: ds64?.rf64SampleCount ?? null,
  });
}
