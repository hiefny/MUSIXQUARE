import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import {
  MpegLayer3FrameHeaderError,
  parseMpegLayer3FrameHeader,
  type MpegLayer3FrameHeader,
  type MpegLayer3Version,
} from './frame-header.ts';
import type { Mp3Id3Boundaries } from './id3.ts';
import { Mp3SideInfoError, parseMpegLayer3MainDataBegin } from './side-info.ts';

export const MP3_FRAME_SCAN_MAX_PAGE_BYTES = 64 * 1_024;

const DEFAULT_PAGE_BYTES = MP3_FRAME_SCAN_MAX_PAGE_BYTES;
const FRAME_HEADER_BYTES = 4;
const MAX_FIRST_FRAME_BYTES = 1_441;

export interface MpegLayer3FrameCoordinate {
  readonly frameOrdinal: number;
  readonly rawSample: number;
  readonly byteOffset: number;
}

export interface MpegLayer3VerifiedFrame extends MpegLayer3FrameCoordinate {
  readonly header: MpegLayer3FrameHeader;
  /** Exact Layer III bit-reservoir back-pointer declared by this frame. */
  readonly mainDataBeginBytes: number;
}

export interface MpegLayer3FrameScanOptions {
  /** Omit to verify the complete metadata-free audio span. */
  readonly maxFrames?: number;
  /** Transport page size. It may be reduced, but never exceed 64 KiB. */
  readonly pageBytes?: number;
  /** Called synchronously after each complete frame boundary is verified. */
  readonly onVerifiedFrame?: (frame: MpegLayer3VerifiedFrame) => void;
}

export interface MpegLayer3FrameScanResult {
  readonly complete: boolean;
  /** Frames verified from `boundaries.dataStart`, including the first frame. */
  readonly frameCount: number;
  readonly totalRawSamples: number;
  readonly verifiedAudioBytes: number;
  readonly next: MpegLayer3FrameCoordinate;
  /** An independent, exact-length copy used for Xing/Info/VBRI/LAME parsing. */
  readonly firstFrame: Uint8Array;
  readonly firstHeader: MpegLayer3FrameHeader;
  readonly version: MpegLayer3Version;
  readonly sampleRateHz: number;
  readonly channelCount: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  /** Describes the verified prefix; a later frame may still prove a prefix VBR. */
  readonly constantBitrate: boolean;
  readonly constantBitrateKbps: number | null;
}

export class MpegLayer3FrameScanError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'MpegLayer3FrameScanError';
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MpegLayer3FrameScanError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function validateBoundaries(
  sourceSize: number,
  boundaries: Mp3Id3Boundaries,
): { readonly dataStart: number; readonly audioEnd: number } {
  validateExactRead(sourceSize, 0, 0);
  if (!boundaries || typeof boundaries !== 'object') {
    throw new TypeError('MP3 ID3 boundaries must be an object');
  }
  if (boundaries.sourceBytes !== sourceSize) {
    throw new MpegLayer3FrameScanError('MP3 ID3 boundaries do not match the encoded source size');
  }
  const { dataStart, audioEnd } = boundaries;
  if (
    !Number.isSafeInteger(dataStart) ||
    !Number.isSafeInteger(audioEnd) ||
    dataStart < 0 ||
    dataStart >= audioEnd ||
    audioEnd > sourceSize
  ) {
    throw new MpegLayer3FrameScanError(
      'MP3 ID3 boundaries must describe a non-empty audio span inside the source',
    );
  }
  return Object.freeze({ dataStart, audioEnd });
}

function validateMaxFrames(value: number | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('MP3 frame scan maxFrames must be a positive safe integer');
  }
  return value;
}

function validatePageBytes(value: number | undefined): number {
  const pageBytes = value ?? DEFAULT_PAGE_BYTES;
  if (
    !Number.isSafeInteger(pageBytes) ||
    pageBytes < FRAME_HEADER_BYTES ||
    pageBytes > MP3_FRAME_SCAN_MAX_PAGE_BYTES
  ) {
    throw new RangeError(
      `MP3 frame scan pageBytes must be between ${FRAME_HEADER_BYTES} and ${MP3_FRAME_SCAN_MAX_PAGE_BYTES}`,
    );
  }
  return pageBytes;
}

class SequentialPageReader {
  private page: Uint8Array = new Uint8Array(0);
  private pageOffset = 0;

  constructor(
    private readonly source: EncodedAudioSource,
    private readonly sourceSize: number,
    private readonly lowerBound: number,
    private readonly upperBound: number,
    private readonly pageBytes: number,
    private readonly signal: AbortSignal,
  ) {}

  async copyExact(offset: number, length: number): Promise<Uint8Array> {
    const end = safeAdd(offset, length, 'MP3 scan read end');
    if (offset < this.lowerBound || end > this.upperBound) {
      throw new MpegLayer3FrameScanError('MP3 scan read exceeds the declared audio span');
    }

    const result = new Uint8Array(length);
    let cursor = offset;
    let written = 0;
    while (written < length) {
      throwIfAborted(this.signal);
      const pageEnd = this.pageOffset + this.page.byteLength;
      if (cursor < this.pageOffset || cursor >= pageEnd) await this.loadPage(cursor);

      const available = this.pageOffset + this.page.byteLength - cursor;
      const copyBytes = Math.min(length - written, available);
      if (copyBytes <= 0) {
        throw new MpegLayer3FrameScanError('MP3 scan page made no forward progress');
      }
      const sourceOffset = cursor - this.pageOffset;
      result.set(this.page.subarray(sourceOffset, sourceOffset + copyBytes), written);
      cursor = safeAdd(cursor, copyBytes, 'MP3 scan read cursor');
      written = safeAdd(written, copyBytes, 'MP3 scan copied byte count');
    }
    throwIfAborted(this.signal);
    return result;
  }

  private async loadPage(offset: number): Promise<void> {
    const length = Math.min(this.pageBytes, this.upperBound - offset);
    if (length <= 0) throw new MpegLayer3FrameScanError('MP3 scan reached the audio boundary');
    validateExactRead(this.sourceSize, offset, length);
    throwIfAborted(this.signal);
    const bytes = await this.source.readAt(offset, length, this.signal);
    throwIfAborted(this.signal);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new MpegLayer3FrameScanError(
        `MP3 frame page returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
      );
    }
    this.pageOffset = offset;
    this.page = bytes;
  }
}

function parseHeader(bytes: Uint8Array, byteOffset: number): MpegLayer3FrameHeader {
  try {
    return parseMpegLayer3FrameHeader(bytes);
  } catch (error) {
    if (error instanceof MpegLayer3FrameHeaderError) {
      throw new MpegLayer3FrameScanError(
        `Invalid MPEG Layer III frame at byte ${byteOffset}: ${error.message}`,
      );
    }
    throw error;
  }
}

function parseMainDataBegin(
  framePrefix: Uint8Array,
  header: MpegLayer3FrameHeader,
  byteOffset: number,
): number {
  try {
    return parseMpegLayer3MainDataBegin(framePrefix, header);
  } catch (error) {
    if (error instanceof Mp3SideInfoError || error instanceof MpegLayer3FrameHeaderError) {
      throw new MpegLayer3FrameScanError(
        `Invalid MPEG Layer III side-info at byte ${byteOffset}: ${error.message}`,
      );
    }
    throw error;
  }
}

function assertCompatibleHeader(
  first: MpegLayer3FrameHeader,
  current: MpegLayer3FrameHeader,
  byteOffset: number,
): void {
  if (current.version !== first.version) {
    throw new MpegLayer3FrameScanError(`MPEG version changes at byte ${byteOffset}`);
  }
  if (current.sampleRateHz !== first.sampleRateHz) {
    throw new MpegLayer3FrameScanError(`MPEG sample rate changes at byte ${byteOffset}`);
  }
  if (current.channelCount !== first.channelCount) {
    throw new MpegLayer3FrameScanError(`MPEG channel count changes at byte ${byteOffset}`);
  }
  if (current.samplesPerFrame !== first.samplesPerFrame) {
    throw new MpegLayer3FrameScanError(`MPEG samples per frame changes at byte ${byteOffset}`);
  }
}

function notifyVerifiedFrame(
  callback: MpegLayer3FrameScanOptions['onVerifiedFrame'],
  frame: MpegLayer3VerifiedFrame,
): void {
  if (!callback) return;
  const returned = (callback as (verified: MpegLayer3VerifiedFrame) => unknown)(frame);
  if (
    returned !== null &&
    (typeof returned === 'object' || typeof returned === 'function') &&
    typeof (returned as { readonly then?: unknown }).then === 'function'
  ) {
    throw new TypeError('MP3 onVerifiedFrame callback must be synchronous');
  }
}

/**
 * Verify a contiguous MPEG Layer III span by following declared frame sizes.
 *
 * The reader holds one transport page at a time. It retains no encoded frame
 * bodies after return other than the independent, parser-capped first frame.
 */
export async function scanMpegLayer3Frames(
  source: EncodedAudioSource,
  boundaries: Mp3Id3Boundaries,
  signal: AbortSignal,
  options: MpegLayer3FrameScanOptions = {},
): Promise<MpegLayer3FrameScanResult> {
  if (!source || typeof source !== 'object') {
    throw new TypeError('MP3 encoded source must be an object');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('MP3 frame scan signal must be an AbortSignal');
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('MP3 frame scan options must be an object');
  }

  const sourceSize = source.size;
  const { dataStart, audioEnd } = validateBoundaries(sourceSize, boundaries);
  const maxFrames = validateMaxFrames(options.maxFrames);
  const pageBytes = validatePageBytes(options.pageBytes);
  if (options.onVerifiedFrame !== undefined && typeof options.onVerifiedFrame !== 'function') {
    throw new TypeError('MP3 onVerifiedFrame must be a function');
  }
  throwIfAborted(signal);

  const reader = new SequentialPageReader(
    source,
    sourceSize,
    dataStart,
    audioEnd,
    pageBytes,
    signal,
  );
  let byteOffset = dataStart;
  let frameOrdinal = 0;
  let rawSample = 0;
  let firstHeader: MpegLayer3FrameHeader | null = null;
  let firstFrame: Uint8Array | null = null;
  let constantBitrate = true;

  while (byteOffset < audioEnd && frameOrdinal < maxFrames) {
    throwIfAborted(signal);
    const remaining = audioEnd - byteOffset;
    if (remaining < FRAME_HEADER_BYTES) {
      throw new MpegLayer3FrameScanError(
        `MP3 audio span has ${remaining} trailing byte${remaining === 1 ? '' : 's'} after its final frame`,
      );
    }

    const headerBytes = await reader.copyExact(byteOffset, FRAME_HEADER_BYTES);
    const header = parseHeader(headerBytes, byteOffset);
    if (firstHeader === null) {
      firstHeader = header;
      if (header.frameLengthBytes > MAX_FIRST_FRAME_BYTES) {
        throw new MpegLayer3FrameScanError('MP3 first frame exceeds the bounded parser limit');
      }
    } else {
      assertCompatibleHeader(firstHeader, header, byteOffset);
      if (header.bitrateKbps !== firstHeader.bitrateKbps) constantBitrate = false;
    }

    const frameEnd = safeAdd(byteOffset, header.frameLengthBytes, 'MP3 frame end');
    if (frameEnd > audioEnd) {
      throw new MpegLayer3FrameScanError(
        `MPEG frame at byte ${byteOffset} is truncated at the declared audio end`,
      );
    }

    const sideInfoPrefixBytes = (header.hasCrc ? 2 : 0) + (header.version === '1' ? 2 : 1);
    const framePrefix = new Uint8Array(FRAME_HEADER_BYTES + sideInfoPrefixBytes);
    framePrefix.set(headerBytes);
    framePrefix.set(
      await reader.copyExact(byteOffset + FRAME_HEADER_BYTES, sideInfoPrefixBytes),
      FRAME_HEADER_BYTES,
    );
    const mainDataBeginBytes = parseMainDataBegin(framePrefix, header, byteOffset);

    if (firstFrame === null)
      firstFrame = await reader.copyExact(byteOffset, header.frameLengthBytes);

    const verified = Object.freeze({
      frameOrdinal,
      rawSample,
      byteOffset,
      header,
      mainDataBeginBytes,
    });
    notifyVerifiedFrame(options.onVerifiedFrame, verified);
    throwIfAborted(signal);

    frameOrdinal = safeAdd(frameOrdinal, 1, 'MP3 frame ordinal');
    rawSample = safeAdd(rawSample, header.samplesPerFrame, 'MP3 raw sample count');
    byteOffset = frameEnd;
  }

  throwIfAborted(signal);
  if (firstHeader === null || firstFrame === null) {
    throw new MpegLayer3FrameScanError('MP3 audio span does not contain a complete frame');
  }

  const next = Object.freeze({ frameOrdinal, rawSample, byteOffset });
  return Object.freeze({
    complete: byteOffset === audioEnd,
    frameCount: frameOrdinal,
    totalRawSamples: rawSample,
    verifiedAudioBytes: byteOffset - dataStart,
    next,
    firstFrame,
    firstHeader,
    version: firstHeader.version,
    sampleRateHz: firstHeader.sampleRateHz,
    channelCount: firstHeader.channelCount,
    samplesPerFrame: firstHeader.samplesPerFrame,
    constantBitrate,
    constantBitrateKbps: constantBitrate ? firstHeader.bitrateKbps : null,
  });
}
