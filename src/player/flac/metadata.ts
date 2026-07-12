import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import { EncodedSourceIntegrityError, throwIfAborted } from '../sources/encoded-audio-source.ts';

const FLAC_MARKER = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const STREAMINFO_TYPE = 0;
const SEEKTABLE_TYPE = 3;
const STREAMINFO_BYTES = 34;
const SEEKPOINT_BYTES = 18;
const MAX_METADATA_BLOCKS = 128;
const MAX_METADATA_SPAN_BYTES = 64 * 1024 * 1024;
const MAX_SEEKTABLE_BYTES = 4 * 1024 * 1024;
const PLACEHOLDER_SAMPLE = 0xffff_ffff_ffff_ffffn;

export interface FlacSeekPoint {
  /** Absolute PCM sample in the encoded FLAC sample-rate domain. */
  readonly sample: number;
  /** Byte offset relative to the first FLAC audio frame. */
  readonly streamOffset: number;
  readonly frameSamples: number;
}

export interface FlacStreamInfo {
  readonly minBlockSize: number;
  readonly maxBlockSize: number;
  readonly minFrameSize: number;
  readonly maxFrameSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: number;
  readonly totalSamples: number;
  readonly duration: number;
  readonly md5: string;
}

export interface FlacMetadata {
  readonly streamInfo: FlacStreamInfo;
  readonly seekPoints: readonly FlacSeekPoint[];
  readonly firstAudioFrameOffset: number;
  readonly metadataBlockCount: number;
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1_00_00_00 +
      (bytes[offset + 1] ?? 0) * 0x1_00_00 +
      (bytes[offset + 2] ?? 0) * 0x1_00 +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  return value;
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EncodedSourceIntegrityError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

function parseStreamInfo(bytes: Uint8Array): FlacStreamInfo {
  if (bytes.byteLength !== STREAMINFO_BYTES) {
    throw new EncodedSourceIntegrityError(`FLAC STREAMINFO must be ${STREAMINFO_BYTES} bytes`);
  }

  const minBlockSize = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
  const maxBlockSize = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const minFrameSize = readUint24(bytes, 4);
  const maxFrameSize = readUint24(bytes, 7);
  const sampleRate = ((bytes[10] ?? 0) << 12) | ((bytes[11] ?? 0) << 4) | ((bytes[12] ?? 0) >>> 4);
  const channels = (((bytes[12] ?? 0) & 0x0e) >>> 1) + 1;
  const bitDepth = ((((bytes[12] ?? 0) & 0x01) << 4) | ((bytes[13] ?? 0) >>> 4)) + 1;
  const totalSamples = ((bytes[13] ?? 0) & 0x0f) * 0x1_0000_0000 + readUint32(bytes, 14);

  if (minBlockSize < 16 || maxBlockSize < minBlockSize) {
    throw new EncodedSourceIntegrityError('FLAC STREAMINFO has invalid block-size bounds');
  }
  if (minFrameSize > 0 && maxFrameSize > 0 && maxFrameSize < minFrameSize) {
    throw new EncodedSourceIntegrityError('FLAC STREAMINFO has invalid frame-size bounds');
  }
  if (sampleRate < 1 || sampleRate > 655_350) {
    throw new EncodedSourceIntegrityError('FLAC STREAMINFO has an invalid sample rate');
  }
  if (channels < 1 || channels > 8) {
    throw new EncodedSourceIntegrityError('FLAC STREAMINFO has an unsupported channel count');
  }
  if (bitDepth < 4 || bitDepth > 32) {
    throw new EncodedSourceIntegrityError('FLAC STREAMINFO has an invalid bit depth');
  }
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0) {
    throw new EncodedSourceIntegrityError('FLAC STREAMINFO has an invalid total sample count');
  }

  return Object.freeze({
    minBlockSize,
    maxBlockSize,
    minFrameSize,
    maxFrameSize,
    sampleRate,
    channels,
    bitDepth,
    totalSamples,
    duration: totalSamples / sampleRate,
    md5: Array.from(bytes.subarray(18, 34), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  });
}

function parseSeekTable(bytes: Uint8Array): readonly FlacSeekPoint[] {
  if (bytes.byteLength % SEEKPOINT_BYTES !== 0) {
    throw new EncodedSourceIntegrityError('FLAC SEEKTABLE length is not a multiple of 18 bytes');
  }

  const points: FlacSeekPoint[] = [];
  let previousSample = -1;
  let previousOffset = -1;
  for (let offset = 0; offset < bytes.byteLength; offset += SEEKPOINT_BYTES) {
    const rawSample = readUint64(bytes, offset);
    if (rawSample === PLACEHOLDER_SAMPLE) continue;
    const sample = toSafeNumber(rawSample, 'FLAC seek sample');
    const streamOffset = toSafeNumber(readUint64(bytes, offset + 8), 'FLAC seek offset');
    const frameSamples = ((bytes[offset + 16] ?? 0) << 8) | (bytes[offset + 17] ?? 0);
    if (sample <= previousSample || streamOffset < previousOffset || frameSamples <= 0) {
      throw new EncodedSourceIntegrityError('FLAC SEEKTABLE entries are not strictly ordered');
    }
    points.push(Object.freeze({ sample, streamOffset, frameSamples }));
    previousSample = sample;
    previousOffset = streamOffset;
  }
  return Object.freeze(points);
}

async function readExact(
  source: EncodedAudioSource,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const bytes = await source.readAt(offset, length, signal);
  throwIfAborted(signal);
  if (bytes.byteLength !== length) {
    throw new EncodedSourceIntegrityError(
      `FLAC metadata read returned ${bytes.byteLength} bytes; expected ${length}`,
    );
  }
  return bytes;
}

/**
 * Parse native FLAC metadata using bounded exact reads.
 *
 * Large PICTURE, PADDING, and comment blocks are skipped without copying their
 * bodies. Ogg-FLAC is deliberately not accepted by the streaming backend.
 */
export async function readFlacMetadata(
  source: EncodedAudioSource,
  signal: AbortSignal,
): Promise<FlacMetadata> {
  if (source.size < FLAC_MARKER.byteLength) {
    throw new EncodedSourceIntegrityError('FLAC source is too short');
  }
  const marker = await readExact(source, 0, FLAC_MARKER.byteLength, signal);
  if (!marker.every((byte, index) => byte === FLAC_MARKER[index])) {
    throw new EncodedSourceIntegrityError('Streaming playback requires a native FLAC file');
  }
  let cursor = FLAC_MARKER.byteLength;
  let blockCount = 0;
  let streamInfo: FlacStreamInfo | null = null;
  let seekPoints: readonly FlacSeekPoint[] = Object.freeze([]);
  let last = false;

  while (!last) {
    blockCount += 1;
    if (blockCount > MAX_METADATA_BLOCKS) {
      throw new EncodedSourceIntegrityError('FLAC has too many metadata blocks');
    }
    const header = await readExact(source, cursor, 4, signal);
    cursor += 4;
    last = ((header[0] ?? 0) & 0x80) !== 0;
    const type = (header[0] ?? 0) & 0x7f;
    const length = readUint24(header, 1);
    const end = cursor + length;
    if (!Number.isSafeInteger(end) || end > source.size || end > MAX_METADATA_SPAN_BYTES) {
      throw new EncodedSourceIntegrityError('FLAC metadata span is invalid or unreasonably large');
    }

    if (blockCount === 1 && type !== STREAMINFO_TYPE) {
      throw new EncodedSourceIntegrityError('FLAC STREAMINFO must be the first metadata block');
    }
    if (type === STREAMINFO_TYPE) {
      if (streamInfo) throw new EncodedSourceIntegrityError('FLAC contains duplicate STREAMINFO');
      streamInfo = parseStreamInfo(await readExact(source, cursor, length, signal));
    } else if (type === SEEKTABLE_TYPE) {
      if (seekPoints.length > 0)
        throw new EncodedSourceIntegrityError('FLAC contains duplicate SEEKTABLE');
      if (length > MAX_SEEKTABLE_BYTES) {
        throw new EncodedSourceIntegrityError('FLAC SEEKTABLE is unreasonably large');
      }
      seekPoints = parseSeekTable(await readExact(source, cursor, length, signal));
    }
    cursor = end;
  }

  if (!streamInfo) throw new EncodedSourceIntegrityError('FLAC STREAMINFO is missing');
  if (cursor >= source.size) throw new EncodedSourceIntegrityError('FLAC has no audio frames');

  return Object.freeze({
    streamInfo,
    seekPoints,
    firstAudioFrameOffset: cursor,
    metadataBlockCount: blockCount,
  });
}
