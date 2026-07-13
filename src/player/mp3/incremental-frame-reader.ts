import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import {
  MpegLayer3FrameHeaderError,
  parseMpegLayer3FrameHeader,
  type MpegLayer3FrameHeader,
  type MpegLayer3Version,
} from './frame-header.ts';
import { Mp3SideInfoError, parseMpegLayer3MainDataBegin } from './side-info.ts';

export const MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES = 64 * 1_024;

const DEFAULT_PAGE_BYTES = MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES;
const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 1_441;

export interface MpegLayer3IncrementalFrameStart {
  readonly byteOffset: number;
  readonly frameOrdinal: number;
}

export interface MpegLayer3IncrementalFrameReaderOptions {
  readonly source: EncodedAudioSource;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  readonly audioFrameCount: number;
  readonly version: MpegLayer3Version;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  /** Scanner-verified coordinate at which this reader generation begins. */
  readonly start: MpegLayer3IncrementalFrameStart;
  /** Transport page size, bounded to 4..64 KiB. */
  readonly pageBytes?: number;
}

export interface MpegLayer3IncrementalFrameDescriptor {
  readonly header: MpegLayer3FrameHeader;
  readonly mainDataBeginBytes: number;
  readonly frameOrdinal: number;
  readonly rawSample: number;
  readonly byteOffset: number;
  readonly byteEndOffset: number;
}

export interface MpegLayer3IncrementalFrame {
  /** Independent exact-length copy; never a view into the transport page. */
  readonly bytes: Uint8Array;
  readonly descriptor: MpegLayer3IncrementalFrameDescriptor;
}

export class MpegLayer3IncrementalFrameReaderError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MpegLayer3IncrementalFrameReaderError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MpegLayer3IncrementalFrameReaderError(
      `${label} exceeds the browser safe-integer range`,
    );
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MpegLayer3IncrementalFrameReaderError(
      `${label} exceeds the browser safe-integer range`,
    );
  }
  return result;
}

function minimumFrameBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 576 ? 24 : 96;
}

function spanCanContainFrames(
  byteSpan: number,
  frameCount: number,
  minimumBytesPerFrame: number,
): boolean {
  if (
    !Number.isSafeInteger(byteSpan) ||
    byteSpan < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 0
  ) {
    return false;
  }
  const minimumSpan = frameCount * minimumBytesPerFrame;
  if (!Number.isSafeInteger(minimumSpan) || byteSpan < minimumSpan) return false;

  const maximumSpanFits = frameCount <= Math.floor(Number.MAX_SAFE_INTEGER / MAX_FRAME_BYTES);
  return !maximumSpanFits || byteSpan <= frameCount * MAX_FRAME_BYTES;
}

function validatePageBytes(value: number | undefined): number {
  const pageBytes = value ?? DEFAULT_PAGE_BYTES;
  if (
    !Number.isSafeInteger(pageBytes) ||
    pageBytes < FRAME_HEADER_BYTES ||
    pageBytes > MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES
  ) {
    throw new RangeError(
      `MP3 incremental pageBytes must be between ${FRAME_HEADER_BYTES} and ${MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES}`,
    );
  }
  return pageBytes;
}

function validateFixedGeometry(options: MpegLayer3IncrementalFrameReaderOptions): void {
  const versionRates: Readonly<Record<MpegLayer3Version, readonly number[]>> = Object.freeze({
    '1': Object.freeze([32_000, 44_100, 48_000]),
    '2': Object.freeze([16_000, 22_050, 24_000]),
    '2.5': Object.freeze([8_000, 11_025, 12_000]),
  });
  if (!Object.hasOwn(versionRates, options.version)) {
    throw new RangeError('MP3 incremental version must be MPEG-1, MPEG-2, or MPEG-2.5');
  }
  if (!versionRates[options.version].includes(options.sampleRateHz)) {
    throw new RangeError('MP3 incremental sample rate is incompatible with its MPEG version');
  }
  if (options.channels !== 1 && options.channels !== 2) {
    throw new RangeError('MP3 incremental channel count must be one or two');
  }
  const expectedSamplesPerFrame = options.version === '1' ? 1_152 : 576;
  if (options.samplesPerFrame !== expectedSamplesPerFrame) {
    throw new RangeError('MP3 incremental samples per frame is incompatible with its MPEG version');
  }
}

function parseHeader(bytes: Uint8Array, byteOffset: number): MpegLayer3FrameHeader {
  try {
    return parseMpegLayer3FrameHeader(bytes);
  } catch (error) {
    if (error instanceof MpegLayer3FrameHeaderError) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `Invalid MPEG Layer III frame at byte ${byteOffset}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

function parseMainDataBegin(
  frame: Uint8Array,
  header: MpegLayer3FrameHeader,
  byteOffset: number,
): number {
  try {
    return parseMpegLayer3MainDataBegin(frame, header);
  } catch (error) {
    if (error instanceof Mp3SideInfoError || error instanceof MpegLayer3FrameHeaderError) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `Invalid MPEG Layer III side-info at byte ${byteOffset}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

class ExactSequentialPageCache {
  #page: Uint8Array = new Uint8Array(0);
  #pageOffset = 0;

  constructor(
    private readonly source: EncodedAudioSource,
    private readonly sourceSize: number,
    private readonly sourceIdentity: string,
    private readonly lowerBound: number,
    private readonly upperBound: number,
    private readonly pageBytes: number,
  ) {}

  assertSourceStable(): void {
    if (this.source.size !== this.sourceSize || this.source.identity !== this.sourceIdentity) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 encoded source changed during incremental frame reading',
      );
    }
  }

  async copyInto(
    target: Uint8Array,
    targetOffset: number,
    sourceOffset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<void> {
    const sourceEnd = safeAdd(sourceOffset, length, 'MP3 incremental read end');
    const targetEnd = safeAdd(targetOffset, length, 'MP3 incremental target end');
    if (sourceOffset < this.lowerBound || sourceEnd > this.upperBound) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental read exceeds its declared audio span',
      );
    }
    if (targetOffset < 0 || targetEnd > target.byteLength) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental copy exceeds its owned frame buffer',
      );
    }

    let cursor = sourceOffset;
    let written = 0;
    while (written < length) {
      throwIfAborted(signal);
      this.assertSourceStable();
      const pageEnd = safeAdd(this.#pageOffset, this.#page.byteLength, 'MP3 page end');
      if (cursor < this.#pageOffset || cursor >= pageEnd) await this.#loadPage(cursor, signal);

      const available = this.#pageOffset + this.#page.byteLength - cursor;
      const copyBytes = Math.min(length - written, available);
      if (copyBytes <= 0) {
        throw new MpegLayer3IncrementalFrameReaderError(
          'MP3 incremental transport page made no forward progress',
        );
      }
      const pageSourceOffset = cursor - this.#pageOffset;
      target.set(
        this.#page.subarray(pageSourceOffset, pageSourceOffset + copyBytes),
        targetOffset + written,
      );
      cursor = safeAdd(cursor, copyBytes, 'MP3 incremental read cursor');
      written = safeAdd(written, copyBytes, 'MP3 incremental copied byte count');
    }
    throwIfAborted(signal);
    this.assertSourceStable();
  }

  async #loadPage(offset: number, signal: AbortSignal): Promise<void> {
    const length = Math.min(this.pageBytes, this.upperBound - offset);
    if (length <= 0) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental reader reached its declared audio boundary',
      );
    }
    this.assertSourceStable();
    validateExactRead(this.sourceSize, offset, length);
    throwIfAborted(signal);

    let bytes: Uint8Array;
    try {
      bytes = await this.source.readAt(offset, length, signal);
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
    throwIfAborted(signal);
    this.assertSourceStable();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MP3 transport page returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
      );
    }

    // The source contract guarantees an exact byte count, but it does not
    // require an owned backing buffer. Copy the page so a small transport view
    // can never pin an arbitrarily large response allocation in this reader.
    const ownedPage = new Uint8Array(length);
    try {
      ownedPage.set(bytes);
    } catch (error) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 transport page could not be copied into bounded storage',
        error,
      );
    }
    this.#pageOffset = offset;
    this.#page = ownedPage;
  }
}

/**
 * Duration-independent, exact-frame MPEG Layer III reader for one worker run.
 *
 * The source remains caller-owned. The reader retains one bounded transport
 * page and allocates one independent frame result per call; it never buffers
 * the complete encoded asset.
 */
export class MpegLayer3IncrementalFrameReader {
  readonly #source: EncodedAudioSource;
  readonly #sourceSize: number;
  readonly #sourceIdentity: string;
  readonly #audioEndByteOffset: number;
  readonly #audioFrameCount: number;
  readonly #version: MpegLayer3Version;
  readonly #sampleRateHz: number;
  readonly #channels: 1 | 2;
  readonly #samplesPerFrame: 576 | 1_152;
  readonly #pages: ExactSequentialPageCache;
  #nextByteOffset: number;
  #nextFrameOrdinal: number;
  #reading = false;
  #hasFatalError = false;
  #fatalError: unknown = null;

  constructor(options: MpegLayer3IncrementalFrameReaderOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('MP3 incremental frame reader options must be an object');
    }
    if (!options.source || typeof options.source !== 'object') {
      throw new TypeError('MP3 incremental frame reader requires an encoded source');
    }
    if (typeof options.source.readAt !== 'function') {
      throw new TypeError('MP3 incremental encoded source readAt must be a function');
    }
    if (typeof options.source.close !== 'function') {
      throw new TypeError('MP3 incremental encoded source close must be a function');
    }
    if (!options.start || typeof options.start !== 'object') {
      throw new TypeError('MP3 incremental frame reader requires a verified start coordinate');
    }

    const sourceSize = options.source.size;
    validateExactRead(sourceSize, 0, 0);
    if (!isEncodedAudioSourceIdentity(options.source.identity)) {
      throw new TypeError('MP3 incremental encoded source identity is invalid');
    }
    validateFixedGeometry(options);
    const pageBytes = validatePageBytes(options.pageBytes);

    const { firstAudioFrameOffset, audioEndByteOffset, audioFrameCount } = options;
    if (
      !Number.isSafeInteger(firstAudioFrameOffset) ||
      !Number.isSafeInteger(audioEndByteOffset) ||
      firstAudioFrameOffset < 0 ||
      firstAudioFrameOffset >= audioEndByteOffset ||
      audioEndByteOffset > sourceSize ||
      audioEndByteOffset - firstAudioFrameOffset < FRAME_HEADER_BYTES
    ) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental audio span must be non-empty and contained by the encoded source',
      );
    }
    if (!Number.isSafeInteger(audioFrameCount) || audioFrameCount < 1) {
      throw new RangeError('MP3 incremental audioFrameCount must be a positive safe integer');
    }
    safeMultiply(audioFrameCount, options.samplesPerFrame, 'MP3 total raw sample count');
    const minimumBytesPerFrame = minimumFrameBytes(options.samplesPerFrame);
    const audioSpanBytes = audioEndByteOffset - firstAudioFrameOffset;
    if (!spanCanContainFrames(audioSpanBytes, audioFrameCount, minimumBytesPerFrame)) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental audio span is inconsistent with its frame count',
      );
    }

    const { byteOffset: startByteOffset, frameOrdinal: startFrameOrdinal } = options.start;
    if (
      !Number.isSafeInteger(startByteOffset) ||
      !Number.isSafeInteger(startFrameOrdinal) ||
      startFrameOrdinal < 0 ||
      startFrameOrdinal > audioFrameCount
    ) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental start coordinate uses invalid safe-integer geometry',
      );
    }
    safeMultiply(startFrameOrdinal, options.samplesPerFrame, 'MP3 start raw sample');
    const validStart =
      (startFrameOrdinal === 0 && startByteOffset === firstAudioFrameOffset) ||
      (startFrameOrdinal === audioFrameCount && startByteOffset === audioEndByteOffset) ||
      (startFrameOrdinal > 0 &&
        startFrameOrdinal < audioFrameCount &&
        startByteOffset > firstAudioFrameOffset &&
        startByteOffset < audioEndByteOffset);
    if (!validStart) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental start coordinate contradicts the declared audio span',
      );
    }
    const bytesBeforeStart = startByteOffset - firstAudioFrameOffset;
    const framesAfterStart = audioFrameCount - startFrameOrdinal;
    const bytesAfterStart = audioEndByteOffset - startByteOffset;
    if (
      !spanCanContainFrames(bytesBeforeStart, startFrameOrdinal, minimumBytesPerFrame) ||
      !spanCanContainFrames(bytesAfterStart, framesAfterStart, minimumBytesPerFrame)
    ) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 incremental start offset contradicts its frame ordinal',
      );
    }

    this.#source = options.source;
    this.#sourceSize = sourceSize;
    this.#sourceIdentity = options.source.identity;
    this.#audioEndByteOffset = audioEndByteOffset;
    this.#audioFrameCount = audioFrameCount;
    this.#version = options.version;
    this.#sampleRateHz = options.sampleRateHz;
    this.#channels = options.channels;
    this.#samplesPerFrame = options.samplesPerFrame;
    this.#nextByteOffset = startByteOffset;
    this.#nextFrameOrdinal = startFrameOrdinal;
    this.#pages = new ExactSequentialPageCache(
      this.#source,
      this.#sourceSize,
      this.#sourceIdentity,
      startByteOffset,
      this.#audioEndByteOffset,
      pageBytes,
    );
  }

  readNext(signal: AbortSignal): Promise<MpegLayer3IncrementalFrame | null> {
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('MP3 incremental frame read requires an AbortSignal'));
    }
    // Integrity poisoning is generation-terminal and therefore outranks a
    // later caller abort. Aborts during a healthy read never poison the reader.
    if (this.#hasFatalError) return Promise.reject(this.#fatalError);
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#reading) {
      return Promise.reject(
        new MpegLayer3IncrementalFrameReaderError(
          'Concurrent or reentrant MP3 incremental frame reads are not supported',
        ),
      );
    }

    this.#reading = true;
    return this.#readNext(signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          this.#hasFatalError = true;
          this.#fatalError = error;
        }
        throw error;
      })
      .finally(() => {
        this.#reading = false;
      });
  }

  async #readNext(signal: AbortSignal): Promise<MpegLayer3IncrementalFrame | null> {
    this.#pages.assertSourceStable();
    if (this.#nextFrameOrdinal === this.#audioFrameCount) {
      if (this.#nextByteOffset !== this.#audioEndByteOffset) {
        throw new MpegLayer3IncrementalFrameReaderError(
          'MP3 declared final frame does not end at the exact audio boundary',
        );
      }
      return null;
    }
    if (this.#nextByteOffset >= this.#audioEndByteOffset) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 audio span ended before its declared final frame',
      );
    }

    const frameOrdinal = this.#nextFrameOrdinal;
    const byteOffset = this.#nextByteOffset;
    const remaining = this.#audioEndByteOffset - byteOffset;
    if (remaining < FRAME_HEADER_BYTES) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MP3 audio span has ${remaining} trailing byte${remaining === 1 ? '' : 's'} where frame ${frameOrdinal} must begin`,
      );
    }

    const headerBytes = new Uint8Array(FRAME_HEADER_BYTES);
    await this.#pages.copyInto(headerBytes, 0, byteOffset, FRAME_HEADER_BYTES, signal);
    const header = parseHeader(headerBytes, byteOffset);
    this.#assertCompatibleHeader(header, byteOffset);

    const byteEndOffset = safeAdd(byteOffset, header.frameLengthBytes, 'MP3 frame end');
    if (byteEndOffset > this.#audioEndByteOffset) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MPEG frame ${frameOrdinal} at byte ${byteOffset} is truncated at the declared audio end`,
      );
    }

    const nextFrameOrdinal = safeAdd(frameOrdinal, 1, 'MP3 frame ordinal');
    if (nextFrameOrdinal < this.#audioFrameCount && byteEndOffset === this.#audioEndByteOffset) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 audio span ends before its declared final frame',
      );
    }
    if (nextFrameOrdinal === this.#audioFrameCount && byteEndOffset !== this.#audioEndByteOffset) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MP3 declared final frame leaves ${this.#audioEndByteOffset - byteEndOffset} extra audio bytes`,
      );
    }

    const bytes = new Uint8Array(header.frameLengthBytes);
    bytes.set(headerBytes);
    await this.#pages.copyInto(
      bytes,
      FRAME_HEADER_BYTES,
      byteOffset + FRAME_HEADER_BYTES,
      header.frameLengthBytes - FRAME_HEADER_BYTES,
      signal,
    );
    const mainDataBeginBytes = parseMainDataBegin(bytes, header, byteOffset);
    if (frameOrdinal === 0 && mainDataBeginBytes !== 0) {
      throw new MpegLayer3IncrementalFrameReaderError(
        'MP3 first audio frame cannot reference an earlier bit reservoir',
      );
    }

    const rawSample = safeMultiply(frameOrdinal, this.#samplesPerFrame, 'MP3 raw sample');
    const descriptor: MpegLayer3IncrementalFrameDescriptor = Object.freeze({
      header,
      mainDataBeginBytes,
      frameOrdinal,
      rawSample,
      byteOffset,
      byteEndOffset,
    });
    const frame: MpegLayer3IncrementalFrame = Object.freeze({ bytes, descriptor });

    throwIfAborted(signal);
    this.#pages.assertSourceStable();
    this.#nextFrameOrdinal = nextFrameOrdinal;
    this.#nextByteOffset = byteEndOffset;
    return frame;
  }

  #assertCompatibleHeader(header: MpegLayer3FrameHeader, byteOffset: number): void {
    if (header.version !== this.#version) {
      throw new MpegLayer3IncrementalFrameReaderError(`MPEG version changes at byte ${byteOffset}`);
    }
    if (header.sampleRateHz !== this.#sampleRateHz) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MPEG sample rate changes at byte ${byteOffset}`,
      );
    }
    if (header.channelCount !== this.#channels) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MPEG channel count changes at byte ${byteOffset}`,
      );
    }
    if (header.samplesPerFrame !== this.#samplesPerFrame) {
      throw new MpegLayer3IncrementalFrameReaderError(
        `MPEG samples per frame changes at byte ${byteOffset}`,
      );
    }
  }
}
