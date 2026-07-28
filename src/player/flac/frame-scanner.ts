import type { FlacStreamInfo } from './metadata.ts';

const MAX_NATIVE_FLAC_FRAME_SIZE = 0xff_ffff;
const MAX_FRAME_HEADER_SIZE = 16;
const DEFAULT_READ_SIZE = 64 * 1024;
const CRC8_POLYNOMIAL = 0x07;
const CRC16_POLYNOMIAL = 0x8005;

const CRC8_TABLE = Uint8Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ CRC8_POLYNOMIAL) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
});

const CRC16_TABLE = Uint16Array.from({ length: 256 }, (_unused, value) => {
  let crc = value << 8;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ CRC16_POLYNOMIAL) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
});

function updateFlacCrc16ByteUnchecked(crc: number, byte: number): number {
  const lookup = ((crc >>> 8) ^ byte) & 0xff;
  return (((crc << 8) & 0xffff) ^ (CRC16_TABLE[lookup] ?? 0)) & 0xffff;
}

export type NativeFlacHeaderStreamInfo = Pick<
  FlacStreamInfo,
  'sampleRate' | 'channels' | 'bitDepth' | 'maxBlockSize'
>;

export type NativeFlacReaderStreamInfo = NativeFlacHeaderStreamInfo &
  Pick<FlacStreamInfo, 'minFrameSize' | 'maxFrameSize'>;

export type NativeFlacBlockingStrategy = 'fixed' | 'variable';

export interface NativeFlacFrameHeader {
  readonly blockingStrategy: NativeFlacBlockingStrategy;
  /** Frame number for fixed blocking, first source sample for variable blocking. */
  readonly codedNumber: number;
  readonly absoluteSourceSample: number;
  readonly blockSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelAssignment: number;
  readonly bitDepth: number;
  readonly headerSize: number;
}

export interface NativeFlacFrame {
  /** Complete native FLAC frame, including its two-byte CRC-16 footer. */
  readonly data: Uint8Array;
  readonly byteOffset: number;
  readonly absoluteSourceSample: number;
  readonly blockSize: number;
}

export interface NativeFlacFrameProbePoint {
  readonly byteOffset: number;
  readonly absoluteSourceSample: number;
  readonly blockSize: number;
  readonly frameSize: number;
}

export type NativeFlacChunkReader = (
  absoluteByteOffset: number,
  maximumBytes: number,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

export interface NativeFlacFrameReaderOptions {
  readonly readChunk: NativeFlacChunkReader;
  readonly startByteOffset: number;
  readonly streamInfo: NativeFlacReaderStreamInfo;
  /** Required when STREAMINFO does not declare maxFrameSize. */
  readonly productMaxFrameSize?: number;
  readonly readSize?: number;
}

export interface NativeFlacProbeOptions {
  /** Allows the final candidate to be verified against the end of the window. */
  readonly windowEndsAtEof?: boolean;
  /** Required when STREAMINFO does not declare maxFrameSize. */
  readonly productMaxFrameSize?: number;
}

export class NativeFlacFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeFlacFrameError';
  }
}

interface ParsedHeader {
  readonly blockingStrategy: NativeFlacBlockingStrategy;
  readonly codedNumber: number;
  readonly absoluteSourceSample: number;
  readonly blockSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelAssignment: number;
  readonly bitDepth: number;
  readonly headerSize: number;
}

type HeaderInspection =
  | { readonly status: 'valid'; readonly header: ParsedHeader }
  | { readonly status: 'incomplete' }
  | { readonly status: 'invalid'; readonly reason: string };

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function validateHeaderStreamInfo(streamInfo: NativeFlacHeaderStreamInfo): void {
  if (
    !Number.isSafeInteger(streamInfo.sampleRate) ||
    streamInfo.sampleRate < 1 ||
    streamInfo.sampleRate > 1_048_575
  ) {
    throw new RangeError('FLAC sample rate is outside the format range');
  }
  if (
    !Number.isSafeInteger(streamInfo.channels) ||
    streamInfo.channels < 1 ||
    streamInfo.channels > 8
  ) {
    throw new RangeError('FLAC channel count must be between 1 and 8');
  }
  if (
    !Number.isSafeInteger(streamInfo.bitDepth) ||
    streamInfo.bitDepth < 4 ||
    streamInfo.bitDepth > 32
  ) {
    throw new RangeError('FLAC bit depth must be between 4 and 32');
  }
  if (
    !Number.isSafeInteger(streamInfo.maxBlockSize) ||
    streamInfo.maxBlockSize < 1 ||
    streamInfo.maxBlockSize > 65_535
  ) {
    throw new RangeError('FLAC maximum block size must be between 1 and 65535');
  }
}

function resolveEffectiveMaxFrameSize(
  streamInfo: NativeFlacReaderStreamInfo,
  productMaxFrameSize: number | undefined,
): number {
  if (
    !Number.isSafeInteger(streamInfo.minFrameSize) ||
    streamInfo.minFrameSize < 0 ||
    streamInfo.minFrameSize > MAX_NATIVE_FLAC_FRAME_SIZE ||
    !Number.isSafeInteger(streamInfo.maxFrameSize) ||
    streamInfo.maxFrameSize < 0 ||
    streamInfo.maxFrameSize > MAX_NATIVE_FLAC_FRAME_SIZE
  ) {
    throw new RangeError('FLAC frame-size bounds must be valid unsigned 24-bit integers');
  }
  if (
    streamInfo.minFrameSize > 0 &&
    streamInfo.maxFrameSize > 0 &&
    streamInfo.minFrameSize > streamInfo.maxFrameSize
  ) {
    throw new RangeError('FLAC minimum frame size exceeds its maximum frame size');
  }
  if (streamInfo.maxFrameSize > 0) return streamInfo.maxFrameSize;
  if (
    !Number.isSafeInteger(productMaxFrameSize) ||
    (productMaxFrameSize ?? 0) < 1 ||
    (productMaxFrameSize ?? 0) > MAX_NATIVE_FLAC_FRAME_SIZE
  ) {
    throw new RangeError(
      'A product max frame size between 1 and 0xFFFFFF is required when STREAMINFO has no maximum',
    );
  }
  return productMaxFrameSize as number;
}

export function updateFlacCrc8(
  initial: number,
  bytes: Uint8Array,
  start = 0,
  end = bytes.byteLength,
): number {
  if (!Number.isInteger(initial) || initial < 0 || initial > 0xff) {
    throw new RangeError('FLAC CRC-8 initial value must be an unsigned byte');
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > bytes.byteLength
  ) {
    throw new RangeError('FLAC CRC-8 byte range is invalid');
  }
  let crc = initial;
  for (let index = start; index < end; index += 1) {
    crc = CRC8_TABLE[crc ^ (bytes[index] ?? 0)] ?? 0;
  }
  return crc;
}

export function flacCrc8(bytes: Uint8Array, start = 0, end = bytes.byteLength): number {
  return updateFlacCrc8(0, bytes, start, end);
}

export function updateFlacCrc16(
  initial: number,
  bytes: Uint8Array,
  start = 0,
  end = bytes.byteLength,
): number {
  if (!Number.isInteger(initial) || initial < 0 || initial > 0xffff) {
    throw new RangeError('FLAC CRC-16 initial value must be an unsigned 16-bit integer');
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > bytes.byteLength
  ) {
    throw new RangeError('FLAC CRC-16 byte range is invalid');
  }
  let crc = initial;
  for (let index = start; index < end; index += 1) {
    crc = updateFlacCrc16ByteUnchecked(crc, bytes[index] ?? 0);
  }
  return crc;
}

export function flacCrc16(bytes: Uint8Array, start = 0, end = bytes.byteLength): number {
  return updateFlacCrc16(0, bytes, start, end);
}

function inspectCodedNumber(
  bytes: Uint8Array,
  offset: number,
):
  | { readonly status: 'valid'; readonly value: number; readonly length: number }
  | { readonly status: 'incomplete' }
  | { readonly status: 'invalid'; readonly reason: string } {
  if (offset >= bytes.byteLength) return { status: 'incomplete' };
  const first = bytes[offset] ?? 0;
  let length: number;
  let value: bigint;

  if ((first & 0x80) === 0) {
    length = 1;
    value = BigInt(first);
  } else if ((first & 0xe0) === 0xc0) {
    length = 2;
    value = BigInt(first & 0x1f);
  } else if ((first & 0xf0) === 0xe0) {
    length = 3;
    value = BigInt(first & 0x0f);
  } else if ((first & 0xf8) === 0xf0) {
    length = 4;
    value = BigInt(first & 0x07);
  } else if ((first & 0xfc) === 0xf8) {
    length = 5;
    value = BigInt(first & 0x03);
  } else if ((first & 0xfe) === 0xfc) {
    length = 6;
    value = BigInt(first & 0x01);
  } else if (first === 0xfe) {
    length = 7;
    value = 0n;
  } else {
    return { status: 'invalid', reason: 'FLAC coded number has an invalid lead byte' };
  }

  if (offset + length > bytes.byteLength) return { status: 'incomplete' };
  for (let index = 1; index < length; index += 1) {
    const continuation = bytes[offset + index] ?? 0;
    if ((continuation & 0xc0) !== 0x80) {
      return { status: 'invalid', reason: 'FLAC coded number has an invalid continuation byte' };
    }
    value = (value << 6n) | BigInt(continuation & 0x3f);
  }

  const canonicalMinimums = [0n, 0x80n, 0x800n, 0x1_0000n, 0x20_0000n, 0x400_0000n, 0x8000_0000n];
  if (value < (canonicalMinimums[length - 1] ?? 0n)) {
    return { status: 'invalid', reason: 'FLAC coded number is not canonically encoded' };
  }
  if (value > 0xf_ffff_ffffn) {
    return { status: 'invalid', reason: 'FLAC coded number exceeds 36 bits' };
  }
  return { status: 'valid', value: Number(value), length };
}

function blockSizeForCode(code: number): number | null {
  if (code === 1) return 192;
  if (code >= 2 && code <= 5) return 576 * 2 ** (code - 2);
  if (code >= 8 && code <= 15) return 256 * 2 ** (code - 8);
  return null;
}

const COMMON_SAMPLE_RATES = [
  0, 88_200, 176_400, 192_000, 8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 96_000,
] as const;

function channelsForAssignment(channelAssignment: number): number | null {
  if (channelAssignment <= 7) return channelAssignment + 1;
  if (channelAssignment <= 10) return 2;
  return null;
}

const BIT_DEPTHS = [0, 8, 12, -1, 16, 20, 24, 32] as const;

function inspectNativeFlacFrameHeader(
  bytes: Uint8Array,
  offset: number,
  streamInfo: NativeFlacHeaderStreamInfo,
): HeaderInspection {
  if (offset < 0 || !Number.isSafeInteger(offset)) {
    return { status: 'invalid', reason: 'FLAC frame header offset is invalid' };
  }
  if (bytes.byteLength - offset < 4) return { status: 'incomplete' };

  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  if (first !== 0xff || (second & 0xfe) !== 0xf8) {
    return { status: 'invalid', reason: 'FLAC frame sync code is invalid' };
  }

  const third = bytes[offset + 2] ?? 0;
  const fourth = bytes[offset + 3] ?? 0;
  const blockSizeCode = third >>> 4;
  const sampleRateCode = third & 0x0f;
  const channelAssignment = fourth >>> 4;
  const bitDepthCode = (fourth >>> 1) & 0x07;

  if (blockSizeCode === 0) return { status: 'invalid', reason: 'FLAC block-size code is reserved' };
  if (sampleRateCode === 15)
    return { status: 'invalid', reason: 'FLAC sample-rate code is forbidden' };
  const channels = channelsForAssignment(channelAssignment);
  if (channels === null)
    return { status: 'invalid', reason: 'FLAC channel assignment is reserved' };
  if (bitDepthCode === 3) return { status: 'invalid', reason: 'FLAC bit-depth code is reserved' };
  if ((fourth & 0x01) !== 0)
    return { status: 'invalid', reason: 'FLAC frame reserved bit is not zero' };

  let cursor = offset + 4;
  const codedNumber = inspectCodedNumber(bytes, cursor);
  if (codedNumber.status !== 'valid') return codedNumber;
  cursor += codedNumber.length;

  let blockSize = blockSizeForCode(blockSizeCode);
  if (blockSizeCode === 6) {
    if (cursor >= bytes.byteLength) return { status: 'incomplete' };
    blockSize = (bytes[cursor] ?? 0) + 1;
    cursor += 1;
  } else if (blockSizeCode === 7) {
    if (cursor + 2 > bytes.byteLength) return { status: 'incomplete' };
    const storedBlockSize = ((bytes[cursor] ?? 0) << 8) | (bytes[cursor + 1] ?? 0);
    if (storedBlockSize === 0xffff) {
      return { status: 'invalid', reason: 'FLAC block size 65536 is forbidden' };
    }
    blockSize = storedBlockSize + 1;
    cursor += 2;
  }
  if (blockSize === null)
    return { status: 'invalid', reason: 'FLAC block size could not be resolved' };

  let sampleRate: number = COMMON_SAMPLE_RATES[sampleRateCode] ?? 0;
  if (sampleRateCode === 0) {
    sampleRate = streamInfo.sampleRate;
  } else if (sampleRateCode === 12) {
    if (cursor >= bytes.byteLength) return { status: 'incomplete' };
    sampleRate = (bytes[cursor] ?? 0) * 1_000;
    cursor += 1;
  } else if (sampleRateCode === 13 || sampleRateCode === 14) {
    if (cursor + 2 > bytes.byteLength) return { status: 'incomplete' };
    sampleRate = ((bytes[cursor] ?? 0) << 8) | (bytes[cursor + 1] ?? 0);
    if (sampleRateCode === 14) sampleRate *= 10;
    cursor += 2;
  }
  if (sampleRate === 0) return { status: 'invalid', reason: 'FLAC frame sample rate is zero' };

  if (cursor >= bytes.byteLength) return { status: 'incomplete' };
  const storedHeaderCrc = bytes[cursor] ?? 0;
  if (flacCrc8(bytes, offset, cursor) !== storedHeaderCrc) {
    return { status: 'invalid', reason: 'FLAC frame header CRC-8 does not validate' };
  }
  cursor += 1;

  const bitDepth = BIT_DEPTHS[bitDepthCode] ?? -1;
  const resolvedBitDepth = bitDepth === 0 ? streamInfo.bitDepth : bitDepth;
  if (sampleRate !== streamInfo.sampleRate) {
    return { status: 'invalid', reason: 'FLAC frame sample rate differs from STREAMINFO' };
  }
  if (channels !== streamInfo.channels) {
    return { status: 'invalid', reason: 'FLAC frame channel count differs from STREAMINFO' };
  }
  if (resolvedBitDepth !== streamInfo.bitDepth) {
    return { status: 'invalid', reason: 'FLAC frame bit depth differs from STREAMINFO' };
  }
  if (blockSize > streamInfo.maxBlockSize) {
    return { status: 'invalid', reason: 'FLAC frame block size exceeds STREAMINFO' };
  }

  const blockingStrategy: NativeFlacBlockingStrategy = (second & 0x01) === 0 ? 'fixed' : 'variable';
  if (blockingStrategy === 'fixed' && codedNumber.length > 6) {
    return { status: 'invalid', reason: 'FLAC fixed-block frame number exceeds six bytes' };
  }
  if (blockingStrategy === 'fixed' && codedNumber.value > 0x7fff_ffff) {
    return { status: 'invalid', reason: 'FLAC fixed-block frame number exceeds 31 bits' };
  }

  const absoluteSourceSampleBigInt =
    blockingStrategy === 'fixed'
      ? BigInt(codedNumber.value) * BigInt(streamInfo.maxBlockSize)
      : BigInt(codedNumber.value);
  if (absoluteSourceSampleBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      status: 'invalid',
      reason: 'FLAC frame sample position exceeds the safe-integer range',
    };
  }

  return {
    status: 'valid',
    header: {
      blockingStrategy,
      codedNumber: codedNumber.value,
      absoluteSourceSample: Number(absoluteSourceSampleBigInt),
      blockSize,
      sampleRate,
      channels,
      channelAssignment,
      bitDepth: resolvedBitDepth,
      headerSize: cursor - offset,
    },
  };
}

/** Parse and CRC-check one byte-aligned native FLAC frame header. */
export function parseNativeFlacFrameHeader(
  bytes: Uint8Array,
  offset: number,
  streamInfo: NativeFlacHeaderStreamInfo,
): NativeFlacFrameHeader {
  validateHeaderStreamInfo(streamInfo);
  const result = inspectNativeFlacFrameHeader(bytes, offset, streamInfo);
  if (result.status === 'incomplete')
    throw new NativeFlacFrameError('FLAC frame header is truncated');
  if (result.status === 'invalid') throw new NativeFlacFrameError(result.reason);
  return Object.freeze({ ...result.header });
}

function isConsecutiveFrame(previous: ParsedHeader, next: ParsedHeader): boolean {
  return (
    previous.blockingStrategy === next.blockingStrategy &&
    next.absoluteSourceSample === previous.absoluteSourceSample + previous.blockSize
  );
}

function validateFrameSize(
  frameSize: number,
  streamInfo: NativeFlacReaderStreamInfo,
  effectiveMaxFrameSize: number,
): boolean {
  return (
    frameSize >= 2 &&
    frameSize <= effectiveMaxFrameSize &&
    (streamInfo.minFrameSize === 0 || frameSize >= streamInfo.minFrameSize) &&
    (streamInfo.maxFrameSize === 0 || frameSize <= streamInfo.maxFrameSize)
  );
}

function frameCrcValid(bytes: Uint8Array, start: number, end: number): boolean {
  return end - start >= 2 && flacCrc16(bytes, start, end) === 0;
}

/**
 * Find frame points that are safe to promote into a seek index.
 *
 * A point is returned only when its own header CRC-8, its complete frame
 * CRC-16, and the following consecutive frame header all validate. A window
 * that is known to end at source EOF may additionally verify its last frame.
 */
export function probeNativeFlacFramePoints(
  bytes: Uint8Array,
  absoluteWindowOffset: number,
  streamInfo: NativeFlacReaderStreamInfo,
  options: NativeFlacProbeOptions = {},
): readonly NativeFlacFrameProbePoint[] {
  assertSafeNonNegativeInteger(absoluteWindowOffset, 'FLAC probe window offset');
  validateHeaderStreamInfo(streamInfo);
  const effectiveMaxFrameSize = resolveEffectiveMaxFrameSize(
    streamInfo,
    options.productMaxFrameSize,
  );
  const candidates: Array<{ offset: number; header: ParsedHeader }> = [];

  for (let offset = 0; offset + 1 < bytes.byteLength; offset += 1) {
    if ((bytes[offset] ?? 0) !== 0xff || ((bytes[offset + 1] ?? 0) & 0xfe) !== 0xf8) continue;
    const result = inspectNativeFlacFrameHeader(bytes, offset, streamInfo);
    if (result.status === 'valid') candidates.push({ offset, header: result.header });
  }

  const points: NativeFlacFrameProbePoint[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const current = candidates[index];
    if (!current) continue;
    const next = candidates[index + 1];
    const end = next?.offset ?? bytes.byteLength;
    const frameSize = end - current.offset;
    const hasVerifiedEnd = next
      ? isConsecutiveFrame(current.header, next.header)
      : options.windowEndsAtEof === true;
    if (
      hasVerifiedEnd &&
      (current.header.blockSize >= 16 || !next) &&
      validateFrameSize(frameSize, streamInfo, effectiveMaxFrameSize) &&
      frameCrcValid(bytes, current.offset, end)
    ) {
      points.push(
        Object.freeze({
          byteOffset: absoluteWindowOffset + current.offset,
          absoluteSourceSample: current.header.absoluteSourceSample,
          blockSize: current.header.blockSize,
          frameSize,
        }),
      );
    }
  }
  return Object.freeze(points);
}

/**
 * Incrementally separates native FLAC frames without decoding their payloads.
 *
 * The caller must provide an already verified frame byte offset. Media bytes
 * stay bounded by STREAMINFO.maxFrameSize, or by the explicit product cap when
 * that field is unknown. At most one maximum-sized frame plus a 16-byte header
 * lookahead is retained; no whole-file buffering is performed.
 */
export class NativeFlacFrameReader {
  readonly effectiveMaxFrameSize: number;

  readonly #readChunk: NativeFlacChunkReader;
  readonly #streamInfo: NativeFlacReaderStreamInfo;
  readonly #readSize: number;
  readonly #bufferLimit: number;
  #buffer: Uint8Array;
  #bufferStart = 0;
  #length = 0;
  #absoluteBufferOffset: number;
  #scanOffset = 0;
  #scanCrc16 = 0;
  #minimumBoundaryOffset = 0;
  #currentHeader: ParsedHeader | null = null;
  #eof = false;
  #finished = false;
  #reading = false;

  constructor(options: NativeFlacFrameReaderOptions) {
    validateHeaderStreamInfo(options.streamInfo);
    assertSafeNonNegativeInteger(options.startByteOffset, 'FLAC reader start offset');
    const readSize = options.readSize ?? DEFAULT_READ_SIZE;
    if (!Number.isSafeInteger(readSize) || readSize < 1) {
      throw new RangeError('FLAC reader readSize must be a positive safe integer');
    }
    this.effectiveMaxFrameSize = resolveEffectiveMaxFrameSize(
      options.streamInfo,
      options.productMaxFrameSize,
    );
    this.#readChunk = options.readChunk;
    this.#streamInfo = options.streamInfo;
    this.#readSize = readSize;
    this.#bufferLimit = this.effectiveMaxFrameSize + MAX_FRAME_HEADER_SIZE;
    this.#buffer = new Uint8Array(Math.min(this.#bufferLimit, Math.max(32, readSize)));
    this.#absoluteBufferOffset = options.startByteOffset;
  }

  async next(signal?: AbortSignal): Promise<NativeFlacFrame | null> {
    if (this.#finished) return null;
    if (this.#reading)
      throw new NativeFlacFrameError('Concurrent FLAC frame reads are not supported');
    this.#reading = true;
    try {
      signal?.throwIfAborted();
      await this.#ensureCurrentHeader(signal);
      const currentHeader = this.#currentHeader;
      if (!currentHeader) return null;

      while (true) {
        signal?.throwIfAborted();
        const boundary = this.#findVerifiedBoundary(currentHeader);
        if (boundary !== null) return this.#yieldFrame(boundary, currentHeader);

        if (this.#eof) {
          const bytes = this.#currentBytes();
          if (
            !validateFrameSize(this.#length, this.#streamInfo, this.effectiveMaxFrameSize) ||
            !frameCrcValid(bytes, 0, bytes.byteLength)
          ) {
            throw new NativeFlacFrameError('Final FLAC frame size or CRC-16 does not validate');
          }
          return this.#yieldFinalFrame(currentHeader);
        }

        if (this.#length >= this.#bufferLimit) {
          throw new NativeFlacFrameError('FLAC frame exceeds the effective maximum frame size');
        }
        await this.#fill(signal);
      }
    } finally {
      this.#reading = false;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<NativeFlacFrame> {
    return {
      next: async () => {
        const value = await this.next();
        return value === null ? { done: true, value: undefined } : { done: false, value };
      },
    };
  }

  async #ensureCurrentHeader(signal?: AbortSignal): Promise<void> {
    if (this.#currentHeader) return;
    while (true) {
      const result = inspectNativeFlacFrameHeader(this.#currentBytes(), 0, this.#streamInfo);
      if (result.status === 'valid') {
        this.#currentHeader = result.header;
        this.#scanOffset = 0;
        this.#scanCrc16 = 0;
        this.#minimumBoundaryOffset = Math.max(
          result.header.headerSize + 2,
          this.#streamInfo.minFrameSize || 0,
        );
        return;
      }
      if (result.status === 'invalid') {
        throw new NativeFlacFrameError(`Verified FLAC frame offset is invalid: ${result.reason}`);
      }
      if (this.#eof) throw new NativeFlacFrameError('FLAC source ends inside a frame header');
      await this.#fill(signal);
    }
  }

  #findVerifiedBoundary(currentHeader: ParsedHeader): number | null {
    const bytes = this.#currentBytes();
    const lastPossibleStart = Math.min(this.#length - 2, this.effectiveMaxFrameSize);
    let offset = this.#scanOffset;
    let crc = this.#scanCrc16;
    while (offset <= lastPossibleStart) {
      if (
        offset < this.#minimumBoundaryOffset ||
        (bytes[offset] ?? 0) !== 0xff ||
        ((bytes[offset + 1] ?? 0) & 0xfe) !== 0xf8
      ) {
        crc = updateFlacCrc16ByteUnchecked(crc, bytes[offset] ?? 0);
        offset += 1;
        continue;
      }
      const next = inspectNativeFlacFrameHeader(bytes, offset, this.#streamInfo);
      if (next.status === 'incomplete') {
        this.#scanOffset = offset;
        this.#scanCrc16 = crc;
        return null;
      }
      if (next.status === 'valid' && crc === 0) {
        if (!validateFrameSize(offset, this.#streamInfo, this.effectiveMaxFrameSize)) {
          throw new NativeFlacFrameError('FLAC frame violates its declared frame-size bounds');
        }
        if (currentHeader.blockSize < 16) {
          throw new NativeFlacFrameError(
            'A sub-16-sample FLAC block appears before the final frame',
          );
        }
        if (!isConsecutiveFrame(currentHeader, next.header)) {
          throw new NativeFlacFrameError(
            'Consecutive FLAC frame numbers or sample positions are invalid',
          );
        }
        this.#scanOffset = offset;
        this.#scanCrc16 = crc;
        return offset;
      }
      crc = updateFlacCrc16ByteUnchecked(crc, bytes[offset] ?? 0);
      offset += 1;
    }
    this.#scanOffset = offset;
    this.#scanCrc16 = crc;
    return null;
  }

  #yieldFrame(boundary: number, header: ParsedHeader): NativeFlacFrame {
    const data = this.#currentBytes().slice(0, boundary);
    const byteOffset = this.#absoluteBufferOffset;
    this.#bufferStart += boundary;
    this.#length -= boundary;
    this.#absoluteBufferOffset += boundary;

    const next = inspectNativeFlacFrameHeader(this.#currentBytes(), 0, this.#streamInfo);
    if (next.status !== 'valid') {
      throw new NativeFlacFrameError('Internal FLAC boundary lost its verified next header');
    }
    this.#currentHeader = next.header;
    this.#scanOffset = 0;
    this.#scanCrc16 = 0;
    this.#minimumBoundaryOffset = Math.max(
      next.header.headerSize + 2,
      this.#streamInfo.minFrameSize || 0,
    );

    return Object.freeze({
      data,
      byteOffset,
      absoluteSourceSample: header.absoluteSourceSample,
      blockSize: header.blockSize,
    });
  }

  #yieldFinalFrame(header: ParsedHeader): NativeFlacFrame {
    const data = this.#currentBytes().slice();
    const frame = Object.freeze({
      data,
      byteOffset: this.#absoluteBufferOffset,
      absoluteSourceSample: header.absoluteSourceSample,
      blockSize: header.blockSize,
    });
    this.#bufferStart = 0;
    this.#length = 0;
    this.#currentHeader = null;
    this.#finished = true;
    return frame;
  }

  async #fill(signal?: AbortSignal): Promise<void> {
    const remainingCapacity = this.#bufferLimit - this.#length;
    if (remainingCapacity <= 0) return;
    const requested = Math.min(this.#readSize, remainingCapacity);
    const bytes = await this.#readChunk(
      this.#absoluteBufferOffset + this.#length,
      requested,
      signal,
    );
    signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('FLAC chunk reader must return a Uint8Array');
    }
    if (bytes.byteLength > requested) {
      throw new NativeFlacFrameError('FLAC chunk reader returned more bytes than requested');
    }
    if (bytes.byteLength === 0) {
      this.#eof = true;
      return;
    }
    this.#ensureBufferCapacity(this.#length + bytes.byteLength);
    this.#buffer.set(bytes, this.#bufferStart + this.#length);
    this.#length += bytes.byteLength;
  }

  #ensureBufferCapacity(required: number): void {
    if (this.#bufferStart + required <= this.#buffer.byteLength) return;
    if (required <= this.#buffer.byteLength) {
      this.#buffer.copyWithin(0, this.#bufferStart, this.#bufferStart + this.#length);
      this.#bufferStart = 0;
      return;
    }
    let capacity = this.#buffer.byteLength;
    while (capacity < required) capacity = Math.min(this.#bufferLimit, capacity * 2);
    const replacement = new Uint8Array(capacity);
    replacement.set(this.#currentBytes());
    this.#buffer = replacement;
    this.#bufferStart = 0;
  }

  #currentBytes(): Uint8Array {
    return this.#buffer.subarray(this.#bufferStart, this.#bufferStart + this.#length);
  }
}
