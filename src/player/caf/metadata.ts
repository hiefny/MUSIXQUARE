import type { LinearPcmEncoding } from '../linear-pcm/sample-format.js';
import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';

export const CAF_MAX_CHANNELS = 8;
export const CAF_MAX_SAMPLE_RATE_HZ = 1_000_000;
export const CAF_MAX_CHUNKS = 1_024;
export const CAF_MAX_METADATA_READ_BYTES = 32;

const CAF_FILE_HEADER_BYTES = 8;
const CAF_CHUNK_HEADER_BYTES = 12;
const CAF_AUDIO_DESCRIPTION_BYTES = 32;
const CAF_DATA_EDIT_COUNT_BYTES = 4;
const CAF_VERSION = 1;
const CAF_UNKNOWN_DATA_SIZE = -1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const CAF_MARKER = 'caff';
const DESCRIPTION_CHUNK = 'desc';
const DATA_CHUNK = 'data';
const PACKET_TABLE_CHUNK = 'pakt';
const LINEAR_PCM_FORMAT = 'lpcm';

const LINEAR_PCM_IS_FLOAT = 1 << 0;
const LINEAR_PCM_IS_LITTLE_ENDIAN = 1 << 1;
const LINEAR_PCM_ALLOWED_FLAGS = LINEAR_PCM_IS_FLOAT | LINEAR_PCM_IS_LITTLE_ENDIAN;

/** Signed integer and floating-point encodings admitted by CAF LPCM. */
export type CafLinearPcmEncoding = Extract<
  LinearPcmEncoding,
  | 'pcm-s8'
  | 'pcm-s16le'
  | 'pcm-s16be'
  | 'pcm-s24le'
  | 'pcm-s24be'
  | 'pcm-s32le'
  | 'pcm-s32be'
  | 'float32le'
  | 'float32be'
  | 'float64le'
  | 'float64be'
>;

export interface CafLinearPcmMetadata {
  readonly format: 'caf';
  readonly encoding: CafLinearPcmEncoding;
  readonly sourceSampleRate: number;
  readonly channels: number;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  /** One interleaved LPCM packet. CAF LPCM is admitted only at one frame per packet. */
  readonly blockAlign: number;
  readonly bytesPerPacket: number;
  readonly framesPerPacket: 1;
  readonly formatFlags: number;
  /** First audio byte after the CAF data chunk's four-byte edit count. */
  readonly dataOffset: number;
  /** Audio bytes only; excludes the edit count. */
  readonly dataBytes: number;
  readonly editCount: number;
  readonly totalSourceFrames: number;
  readonly durationSeconds: number;
  /** CAF has no top-level length field, so this is the exactly traversed source size. */
  readonly logicalFileBytes: number;
  readonly dataChunkSizeUnknown: boolean;
}

/** The CAF container is valid enough to identify a codec outside LPCM. */
export class UnsupportedCafCodecError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCafCodecError';
  }
}

/** Variable-packet CAF needs packet-table indexing, which this fixed-packet parser omits. */
export class UnsupportedCafPacketTableError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCafPacketTableError';
  }
}

interface ParsedDescription {
  readonly encoding: CafLinearPcmEncoding;
  readonly sourceSampleRate: number;
  readonly channels: number;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  readonly blockAlign: number;
  readonly bytesPerPacket: number;
  readonly framesPerPacket: 1;
  readonly formatFlags: number;
}

interface LocatedDataChunk {
  readonly offset: number;
  readonly bytes: number;
  readonly editCount: number;
  readonly sizeUnknown: boolean;
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

function safeSignedChunkSize(value: bigint, chunkId: string): number {
  if (value < 0n) {
    throw new EncodedSourceIntegrityError(
      `CAF chunk ${JSON.stringify(chunkId)} has an invalid negative size`,
    );
  }
  if (value > MAX_SAFE_BIGINT) {
    throw new EncodedSourceIntegrityError(
      `CAF chunk ${JSON.stringify(chunkId)} exceeds the browser safe-integer range`,
    );
  }
  return Number(value);
}

async function readExact(
  source: EncodedAudioSource,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (length > CAF_MAX_METADATA_READ_BYTES) {
    throw new RangeError('CAF metadata read exceeds its fixed read bound');
  }
  validateExactRead(source.size, offset, length);
  throwIfAborted(signal);
  const bytes = await source.readAt(offset, length, signal);
  throwIfAborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new EncodedSourceIntegrityError(
      `CAF metadata read returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
    );
  }
  return bytes;
}

function integerEncoding(
  containerBits: 8 | 16 | 24 | 32,
  littleEndian: boolean,
): CafLinearPcmEncoding {
  if (containerBits === 8) return 'pcm-s8';
  if (containerBits === 16) return littleEndian ? 'pcm-s16le' : 'pcm-s16be';
  if (containerBits === 24) return littleEndian ? 'pcm-s24le' : 'pcm-s24be';
  return littleEndian ? 'pcm-s32le' : 'pcm-s32be';
}

function floatEncoding(containerBits: 32 | 64, littleEndian: boolean): CafLinearPcmEncoding {
  if (containerBits === 32) return littleEndian ? 'float32le' : 'float32be';
  return littleEndian ? 'float64le' : 'float64be';
}

function parseDescription(bytes: Uint8Array): ParsedDescription {
  if (bytes.byteLength !== CAF_AUDIO_DESCRIPTION_BYTES) {
    throw new EncodedSourceIntegrityError('CAF desc chunk must contain exactly 32 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sourceSampleRate = view.getFloat64(0, false);
  if (
    !Number.isSafeInteger(sourceSampleRate) ||
    sourceSampleRate < 1 ||
    sourceSampleRate > CAF_MAX_SAMPLE_RATE_HZ
  ) {
    throw new EncodedSourceIntegrityError(
      `CAF sample rate must be a whole number from 1 through ${CAF_MAX_SAMPLE_RATE_HZ} Hz`,
    );
  }
  const formatId = fourCc(bytes, 8);
  if (formatId !== LINEAR_PCM_FORMAT) {
    throw new UnsupportedCafCodecError(
      `CAF codec ${JSON.stringify(formatId)} is not supported; bounded CAF playback requires LPCM`,
    );
  }

  const formatFlags = view.getUint32(12, false);
  if ((formatFlags & ~LINEAR_PCM_ALLOWED_FLAGS) !== 0) {
    throw new EncodedSourceIntegrityError('CAF LPCM uses reserved format flags');
  }
  const bytesPerPacket = view.getUint32(16, false);
  const framesPerPacket = view.getUint32(20, false);
  const channels = view.getUint32(24, false);
  const validBitsPerSample = view.getUint32(28, false);

  if (framesPerPacket !== 1) {
    throw new EncodedSourceIntegrityError('CAF LPCM must contain exactly one frame per packet');
  }
  if (channels < 1 || channels > CAF_MAX_CHANNELS) {
    throw new EncodedSourceIntegrityError(
      `CAF channel count must be from 1 through ${CAF_MAX_CHANNELS}`,
    );
  }
  if (bytesPerPacket < 1 || bytesPerPacket % channels !== 0) {
    throw new EncodedSourceIntegrityError(
      'CAF bytesPerPacket does not describe equal interleaved channel containers',
    );
  }

  const bytesPerSample = bytesPerPacket / channels;
  const containerBits = bytesPerSample * 8;
  const isFloat = (formatFlags & LINEAR_PCM_IS_FLOAT) !== 0;
  const isLittleEndian = (formatFlags & LINEAR_PCM_IS_LITTLE_ENDIAN) !== 0;

  let encoding: CafLinearPcmEncoding;
  let containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  if (isFloat) {
    if (
      (validBitsPerSample !== 32 && validBitsPerSample !== 64) ||
      containerBits !== validBitsPerSample
    ) {
      throw new EncodedSourceIntegrityError(
        'CAF floating-point LPCM must use an exact 32-bit or 64-bit sample container',
      );
    }
    containerBitsPerSample = validBitsPerSample;
    encoding = floatEncoding(containerBitsPerSample, isLittleEndian);
  } else {
    if (validBitsPerSample < 1 || validBitsPerSample > 32) {
      throw new EncodedSourceIntegrityError(
        'CAF integer LPCM valid bits must be from 1 through 32',
      );
    }
    if (
      containerBits !== 8 &&
      containerBits !== 16 &&
      containerBits !== 24 &&
      containerBits !== 32
    ) {
      throw new EncodedSourceIntegrityError(
        'CAF integer LPCM sample containers must contain 1 through 4 whole bytes',
      );
    }
    if (validBitsPerSample > containerBits) {
      throw new EncodedSourceIntegrityError(
        'CAF integer LPCM valid bits exceed the high-aligned sample container',
      );
    }
    containerBitsPerSample = containerBits;
    encoding = integerEncoding(containerBitsPerSample, isLittleEndian);
  }

  return Object.freeze({
    encoding,
    sourceSampleRate,
    channels,
    containerBitsPerSample,
    validBitsPerSample,
    blockAlign: bytesPerPacket,
    bytesPerPacket,
    framesPerPacket: 1,
    formatFlags,
  });
}

/**
 * Parse fixed-packet CAF LPCM metadata using bounded, abort-aware random reads.
 *
 * The parser never reads audio payload bytes. Known-size chunks are traversed
 * by validated offsets; a `data` size of -1 consumes the exact remaining
 * source after its edit count, as required by CAF.
 */
export async function readCafLinearPcmMetadata(
  source: EncodedAudioSource,
  signal: AbortSignal,
): Promise<Readonly<CafLinearPcmMetadata>> {
  if (!source || typeof source.readAt !== 'function') {
    throw new TypeError('CAF metadata requires an encoded audio source');
  }
  validateExactRead(source.size, 0, 0);
  if (source.size < CAF_FILE_HEADER_BYTES) {
    throw new EncodedSourceIntegrityError('CAF source is shorter than its file header');
  }
  throwIfAborted(signal);

  const fileHeader = await readExact(source, 0, CAF_FILE_HEADER_BYTES, signal);
  if (!matchesAscii(fileHeader, 0, CAF_MARKER)) {
    throw new EncodedSourceIntegrityError('CAF source does not use the caff marker');
  }
  const fileView = new DataView(fileHeader.buffer, fileHeader.byteOffset, fileHeader.byteLength);
  if (fileView.getUint16(4, false) !== CAF_VERSION) {
    throw new EncodedSourceIntegrityError('CAF source must use file version 1');
  }
  if (fileView.getUint16(6, false) !== 0) {
    throw new EncodedSourceIntegrityError('CAF file header uses reserved flags');
  }

  let cursor = CAF_FILE_HEADER_BYTES;
  const firstHeaderEnd = safeAdd(cursor, CAF_CHUNK_HEADER_BYTES, 'CAF desc header end');
  if (firstHeaderEnd > source.size) {
    throw new EncodedSourceIntegrityError('CAF source has no complete first chunk header');
  }
  const firstHeader = await readExact(source, cursor, CAF_CHUNK_HEADER_BYTES, signal);
  if (!matchesAscii(firstHeader, 0, DESCRIPTION_CHUNK)) {
    throw new EncodedSourceIntegrityError('CAF desc must be the first chunk');
  }
  const firstView = new DataView(
    firstHeader.buffer,
    firstHeader.byteOffset,
    firstHeader.byteLength,
  );
  const firstChunkSize = firstView.getBigInt64(4, false);
  if (firstChunkSize !== BigInt(CAF_AUDIO_DESCRIPTION_BYTES)) {
    throw new EncodedSourceIntegrityError('CAF desc chunk must contain exactly 32 bytes');
  }
  const descriptionEnd = safeAdd(firstHeaderEnd, CAF_AUDIO_DESCRIPTION_BYTES, 'CAF desc chunk end');
  if (descriptionEnd > source.size) {
    throw new EncodedSourceIntegrityError('CAF desc chunk exceeds the encoded source');
  }
  const description = parseDescription(
    await readExact(source, firstHeaderEnd, CAF_AUDIO_DESCRIPTION_BYTES, signal),
  );
  cursor = descriptionEnd;

  let chunkCount = 1;
  let data: LocatedDataChunk | null = null;
  while (cursor < source.size) {
    chunkCount += 1;
    if (chunkCount > CAF_MAX_CHUNKS) {
      throw new EncodedSourceIntegrityError('CAF contains too many chunks');
    }
    const headerEnd = safeAdd(cursor, CAF_CHUNK_HEADER_BYTES, 'CAF chunk header end');
    if (headerEnd > source.size) {
      throw new EncodedSourceIntegrityError('CAF ends inside a chunk header');
    }

    const header = await readExact(source, cursor, CAF_CHUNK_HEADER_BYTES, signal);
    const chunkId = fourCc(header);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const rawChunkSize = headerView.getBigInt64(4, false);

    if (chunkId === PACKET_TABLE_CHUNK) {
      throw new UnsupportedCafPacketTableError(
        'CAF packet tables are not supported by the fixed-packet LPCM parser',
      );
    }
    if (chunkId === DESCRIPTION_CHUNK) {
      throw new EncodedSourceIntegrityError('CAF contains a duplicate desc chunk');
    }

    if (rawChunkSize === CAF_UNKNOWN_DATA_SIZE) {
      if (chunkId !== DATA_CHUNK) {
        throw new EncodedSourceIntegrityError('Only a CAF data chunk may use size -1');
      }
      if (data) throw new EncodedSourceIntegrityError('CAF contains multiple data chunks');
      const editCountEnd = safeAdd(headerEnd, CAF_DATA_EDIT_COUNT_BYTES, 'CAF data edit-count end');
      if (editCountEnd > source.size) {
        throw new EncodedSourceIntegrityError('CAF data chunk is shorter than its edit count');
      }
      const editBytes = await readExact(source, headerEnd, CAF_DATA_EDIT_COUNT_BYTES, signal);
      data = Object.freeze({
        offset: editCountEnd,
        bytes: source.size - editCountEnd,
        editCount: new DataView(
          editBytes.buffer,
          editBytes.byteOffset,
          editBytes.byteLength,
        ).getUint32(0, false),
        sizeUnknown: true,
      });
      cursor = source.size;
      continue;
    }

    const chunkBytes = safeSignedChunkSize(rawChunkSize, chunkId);
    const nextCursor = safeAdd(headerEnd, chunkBytes, `CAF ${chunkId} chunk end`);
    if (nextCursor > source.size) {
      throw new EncodedSourceIntegrityError(
        `CAF chunk ${JSON.stringify(chunkId)} exceeds the encoded source`,
      );
    }

    if (chunkId === DATA_CHUNK) {
      if (data) throw new EncodedSourceIntegrityError('CAF contains multiple data chunks');
      if (chunkBytes < CAF_DATA_EDIT_COUNT_BYTES) {
        throw new EncodedSourceIntegrityError('CAF data chunk is shorter than its edit count');
      }
      const editCountEnd = safeAdd(headerEnd, CAF_DATA_EDIT_COUNT_BYTES, 'CAF data edit-count end');
      const editBytes = await readExact(source, headerEnd, CAF_DATA_EDIT_COUNT_BYTES, signal);
      data = Object.freeze({
        offset: editCountEnd,
        bytes: chunkBytes - CAF_DATA_EDIT_COUNT_BYTES,
        editCount: new DataView(
          editBytes.buffer,
          editBytes.byteOffset,
          editBytes.byteLength,
        ).getUint32(0, false),
        sizeUnknown: false,
      });
    }
    cursor = nextCursor;
  }

  if (cursor !== source.size) {
    throw new EncodedSourceIntegrityError('CAF chunks do not exactly traverse the encoded source');
  }
  if (!data) throw new EncodedSourceIntegrityError('CAF data chunk is missing');
  if (data.bytes <= 0) throw new EncodedSourceIntegrityError('CAF data chunk is empty');
  if (data.bytes % description.bytesPerPacket !== 0) {
    throw new EncodedSourceIntegrityError('CAF data is not a whole number of LPCM packets');
  }
  const totalSourceFrames = data.bytes / description.bytesPerPacket;
  if (!Number.isSafeInteger(totalSourceFrames) || totalSourceFrames < 1) {
    throw new EncodedSourceIntegrityError('CAF source frame count exceeds the safe-integer range');
  }
  const durationSeconds = totalSourceFrames / description.sourceSampleRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new EncodedSourceIntegrityError('CAF duration is not a positive finite number');
  }

  return Object.freeze({
    format: 'caf',
    ...description,
    dataOffset: data.offset,
    dataBytes: data.bytes,
    editCount: data.editCount,
    totalSourceFrames,
    durationSeconds,
    logicalFileBytes: source.size,
    dataChunkSizeUnknown: data.sizeUnknown,
  });
}
