import {
  EncodedSourceIntegrityError,
  type EncodedRandomAccessSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import {
  AdtsHeaderError,
  parseAdtsHeader,
  type AdtsHeader,
  type AdtsSampleRateIndex,
} from './adts-header.ts';

export const ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES = 64 * 1_024;
export const ADTS_MAX_FRAME_BYTES = 8_191;

const DEFAULT_PAGE_BYTES = ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES;
const ADTS_HEADER_BYTES = 7;
const MINIMUM_FRAME_BYTES = ADTS_HEADER_BYTES + 1;

const OPTION_KEYS = Object.freeze(['source', 'start', 'expectedConfig', 'pageBytes'] as const);
const START_KEYS = Object.freeze(['byteOffset', 'frameOrdinal'] as const);
const CONFIG_KEYS = Object.freeze([
  'mpegId',
  'profile',
  'coreAudioObjectType',
  'sampleRateIndex',
  'channelConfiguration',
  'protectionAbsent',
  'rawDataBlocks',
] as const);

type StrictRecord = Readonly<Record<string, unknown>>;

export interface AdtsCoreConfiguration {
  readonly mpegId: 0;
  readonly profile: 1;
  readonly coreAudioObjectType: 2;
  readonly sampleRateIndex: AdtsSampleRateIndex;
  readonly channelConfiguration: 1 | 2;
  readonly protectionAbsent: true;
  readonly rawDataBlocks: 1;
}

export interface AdtsIncrementalFrameStart {
  readonly byteOffset: number;
  readonly frameOrdinal: number;
}

export interface AdtsIncrementalFrameReaderOptions {
  readonly source: EncodedRandomAccessSource;
  /** Defaults to the physical origin. Nonzero values must be scanner-verified anchors. */
  readonly start?: AdtsIncrementalFrameStart;
  /**
   * Frozen metadata from a verified full scan. Required for a nonzero start and
   * optional at the origin, where the first frame otherwise establishes it.
   */
  readonly expectedConfig?: Readonly<AdtsCoreConfiguration>;
  /** Transport page size, bounded to 7..64 KiB. */
  readonly pageBytes?: number;
}

export interface AdtsIncrementalFrameDescriptor {
  readonly header: Readonly<AdtsHeader>;
  readonly frameOrdinal: number;
  readonly byteOffset: number;
  readonly byteEndOffset: number;
}

export interface AdtsIncrementalFrame {
  /** Independent exact-length copy; never a view into the transport page. */
  readonly bytes: Uint8Array;
  readonly descriptor: Readonly<AdtsIncrementalFrameDescriptor>;
}

export class AdtsIncrementalFrameReaderError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AdtsIncrementalFrameReaderError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

interface SourceSnapshot {
  readonly authority: EncodedRandomAccessSource;
  readonly size: number;
  readonly identity: string;
  readonly readAt: EncodedRandomAccessSource['readAt'];
}

interface ReaderOptionsSnapshot {
  readonly source: unknown;
  readonly start: unknown;
  readonly expectedConfig: unknown;
  readonly pageBytes: unknown;
}

const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;

function snapshotRecord(value: unknown, label: string): StrictRecord {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} must be an exact plain data record`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be an exact plain data record`);
    }
    const keys = Reflect.ownKeys(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string' || Object.hasOwn(snapshot, key)) {
        throw new TypeError(`${label} contains an unsupported key`);
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} must use enumerable data fields`);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} could not be inspected safely`, { cause: error });
  }
}

function requireAllowedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): StrictRecord {
  const record = snapshotRecord(value, label);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
  return record;
}

function snapshotOptions(value: unknown): ReaderOptionsSnapshot {
  const record = requireAllowedRecord(value, OPTION_KEYS, ['source'], 'ADTS reader options');
  return Object.freeze({
    source: record.source,
    start: record.start,
    expectedConfig: record.expectedConfig,
    pageBytes: record.pageBytes,
  });
}

function requireSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function snapshotStart(value: unknown, sourceSize: number): Readonly<AdtsIncrementalFrameStart> {
  if (value === undefined) return Object.freeze({ byteOffset: 0, frameOrdinal: 0 });
  const record = requireAllowedRecord(value, START_KEYS, START_KEYS, 'ADTS verified start');
  const byteOffset = requireSafeInteger(
    record.byteOffset,
    0,
    Math.max(0, sourceSize - MINIMUM_FRAME_BYTES),
    'ADTS start byteOffset',
  );
  const frameOrdinal = requireSafeInteger(
    record.frameOrdinal,
    0,
    Number.MAX_SAFE_INTEGER - 1,
    'ADTS start frameOrdinal',
  );
  if ((byteOffset === 0) !== (frameOrdinal === 0)) {
    throw new AdtsIncrementalFrameReaderError(
      'ADTS origin and nonzero verified starts must use matching byte and frame coordinates',
    );
  }
  return Object.freeze({ byteOffset, frameOrdinal });
}

function snapshotExpectedConfig(value: unknown): Readonly<AdtsCoreConfiguration> | null {
  if (value === undefined) return null;
  const record = requireAllowedRecord(
    value,
    CONFIG_KEYS,
    CONFIG_KEYS,
    'ADTS expected core configuration',
  );
  if (
    record.mpegId !== 0 ||
    record.profile !== 1 ||
    record.coreAudioObjectType !== 2 ||
    record.protectionAbsent !== true ||
    record.rawDataBlocks !== 1
  ) {
    throw new AdtsIncrementalFrameReaderError(
      'ADTS expected core configuration is outside the MPEG-4 AAC-LC atomic-frame policy',
    );
  }
  const sampleRateIndex = requireSafeInteger(
    record.sampleRateIndex,
    0,
    12,
    'ADTS expected sampleRateIndex',
  ) as AdtsSampleRateIndex;
  if (record.channelConfiguration !== 1 && record.channelConfiguration !== 2) {
    throw new AdtsIncrementalFrameReaderError(
      'ADTS expected core configuration must be core mono or stereo',
    );
  }
  return Object.freeze({
    mpegId: 0,
    profile: 1,
    coreAudioObjectType: 2,
    sampleRateIndex,
    channelConfiguration: record.channelConfiguration,
    protectionAbsent: true,
    rawDataBlocks: 1,
  });
}

function snapshotSource(value: unknown): SourceSnapshot {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      throw new TypeError('ADTS reader requires an encoded source');
    }
    const authority = value as EncodedRandomAccessSource;
    const size = authority.size;
    const identity = authority.identity;
    const readAt = authority.readAt;
    const close = authority.close;
    validateExactRead(size, 0, 0);
    if (!isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('ADTS encoded source identity is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('ADTS encoded source methods are invalid');
    }
    return Object.freeze({ authority, size, identity, readAt });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError('ADTS encoded source could not be inspected safely', { cause: error });
  }
}

function validatePageBytes(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_BYTES;
  return requireSafeInteger(
    value,
    ADTS_HEADER_BYTES,
    ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
    'ADTS incremental pageBytes',
  );
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AdtsIncrementalFrameReaderError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function snapshotExactPage(value: unknown, expectedLength: number): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new AdtsIncrementalFrameReaderError('ADTS transport returned invalid page bytes');
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // Reject SharedArrayBuffer pages: copying one cannot guarantee a coherent
    // encoded frame snapshot while another agent can mutate it.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new AdtsIncrementalFrameReaderError(
      'ADTS transport page must be a readable non-shared Uint8Array',
      error,
    );
  }
  if (byteLength !== expectedLength) {
    throw new AdtsIncrementalFrameReaderError(
      `ADTS transport page returned ${byteLength} bytes; expected ${expectedLength}`,
    );
  }

  const owned = new Uint8ArrayIntrinsic(expectedLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new AdtsIncrementalFrameReaderError(
      'ADTS transport page could not be copied into bounded storage',
      error,
    );
  }
  return owned;
}

function configurationFromHeader(header: Readonly<AdtsHeader>): Readonly<AdtsCoreConfiguration> {
  return Object.freeze({
    mpegId: 0,
    profile: 1,
    coreAudioObjectType: 2,
    sampleRateIndex: header.sampleRateIndex,
    channelConfiguration: header.channelConfiguration as 1 | 2,
    protectionAbsent: true,
    rawDataBlocks: 1,
  });
}

function sameConfiguration(
  left: Readonly<AdtsCoreConfiguration>,
  right: Readonly<AdtsCoreConfiguration>,
): boolean {
  return CONFIG_KEYS.every((key) => left[key] === right[key]);
}

function parseHeader(bytes: Uint8Array, byteOffset: number): Readonly<AdtsHeader> {
  try {
    return parseAdtsHeader(bytes);
  } catch (error) {
    if (
      error instanceof AdtsHeaderError ||
      error instanceof TypeError ||
      error instanceof RangeError
    ) {
      throw new AdtsIncrementalFrameReaderError(
        `Invalid ADTS frame at byte ${byteOffset}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

function admitHeader(header: Readonly<AdtsHeader>, byteOffset: number): void {
  if (
    header.mpegId !== 0 ||
    header.profile !== 1 ||
    header.coreAudioObjectType !== 2 ||
    header.protectionAbsent !== true ||
    header.hasCrc ||
    header.rawDataBlocks !== 1 ||
    (header.channelConfiguration !== 1 && header.channelConfiguration !== 2) ||
    (header.coreChannelCount !== 1 && header.coreChannelCount !== 2)
  ) {
    throw new AdtsIncrementalFrameReaderError(
      `ADTS frame at byte ${byteOffset} is outside the MPEG-4 AAC-LC, no-CRC, one-block mono/stereo policy`,
    );
  }
  if (
    header.headerLengthBytes !== ADTS_HEADER_BYTES ||
    header.frameLengthBytes < MINIMUM_FRAME_BYTES ||
    header.frameLengthBytes > ADTS_MAX_FRAME_BYTES
  ) {
    throw new AdtsIncrementalFrameReaderError(
      `ADTS frame at byte ${byteOffset} has invalid bounded frame geometry`,
    );
  }
}

class ExactSequentialPageCache {
  #page: Uint8Array = new Uint8ArrayIntrinsic(0);
  #pageOffset = 0;

  constructor(
    private readonly source: SourceSnapshot,
    private readonly lowerBound: number,
    private readonly pageBytes: number,
  ) {}

  async copyInto(
    target: Uint8Array,
    targetOffset: number,
    sourceOffset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<void> {
    const sourceEnd = safeAdd(sourceOffset, length, 'ADTS incremental read end');
    const targetEnd = safeAdd(targetOffset, length, 'ADTS incremental target end');
    if (sourceOffset < this.lowerBound || sourceEnd > this.source.size) {
      throw new AdtsIncrementalFrameReaderError('ADTS incremental read exceeds its source span');
    }
    if (targetOffset < 0 || targetEnd > target.byteLength) {
      throw new AdtsIncrementalFrameReaderError(
        'ADTS incremental copy exceeds its owned frame buffer',
      );
    }

    let cursor = sourceOffset;
    let written = 0;
    while (written < length) {
      throwIfAborted(signal);
      const pageEnd = safeAdd(this.#pageOffset, this.#page.byteLength, 'ADTS page end');
      if (cursor < this.#pageOffset || cursor >= pageEnd) await this.#loadPage(cursor, signal);

      const available = this.#pageOffset + this.#page.byteLength - cursor;
      const copyBytes = Math.min(length - written, available);
      if (copyBytes <= 0) {
        throw new AdtsIncrementalFrameReaderError(
          'ADTS incremental transport page made no forward progress',
        );
      }
      const pageSourceOffset = cursor - this.#pageOffset;
      target.set(
        this.#page.subarray(pageSourceOffset, pageSourceOffset + copyBytes),
        targetOffset + written,
      );
      cursor = safeAdd(cursor, copyBytes, 'ADTS incremental read cursor');
      written = safeAdd(written, copyBytes, 'ADTS incremental copied byte count');
    }
    throwIfAborted(signal);
  }

  async #loadPage(offset: number, signal: AbortSignal): Promise<void> {
    const length = Math.min(this.pageBytes, this.source.size - offset);
    if (length <= 0) {
      throw new AdtsIncrementalFrameReaderError('ADTS incremental reader reached physical EOF');
    }
    validateExactRead(this.source.size, offset, length);
    throwIfAborted(signal);

    let candidate: unknown;
    try {
      candidate = await Reflect.apply(this.source.readAt, this.source.authority, [
        offset,
        length,
        signal,
      ]);
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
    throwIfAborted(signal);
    const owned = snapshotExactPage(candidate, length);
    throwIfAborted(signal);
    this.#pageOffset = offset;
    this.#page = owned;
  }
}

/**
 * Duration-independent strict reader for one contiguous raw ADTS source.
 *
 * The reader never resynchronizes after invalid bytes. A nonzero generation
 * must begin at an exact anchor produced by a verified full scan and carry that
 * scan's frozen core configuration. The source remains caller-owned.
 */
export class AdtsIncrementalFrameReader {
  readonly #sourceSize: number;
  readonly #pages: ExactSequentialPageCache;
  readonly #expectedConfig: Readonly<AdtsCoreConfiguration> | null;
  #activeConfig: Readonly<AdtsCoreConfiguration> | null = null;
  #nextByteOffset: number;
  #nextFrameOrdinal: number;
  #reading = false;
  #hasFatalError = false;
  #fatalError: unknown = null;

  constructor(options: AdtsIncrementalFrameReaderOptions) {
    const input = snapshotOptions(options);
    const source = snapshotSource(input.source);
    if (source.size < MINIMUM_FRAME_BYTES) {
      throw new AdtsIncrementalFrameReaderError(
        'ADTS source must contain at least one complete header and AAC payload byte',
      );
    }
    const start = snapshotStart(input.start, source.size);
    const expectedConfig = snapshotExpectedConfig(input.expectedConfig);
    if (start.byteOffset !== 0 && expectedConfig === null) {
      throw new AdtsIncrementalFrameReaderError(
        'A nonzero ADTS verified start requires full-scan expected core configuration',
      );
    }
    const pageBytes = validatePageBytes(input.pageBytes);

    this.#sourceSize = source.size;
    this.#nextByteOffset = start.byteOffset;
    this.#nextFrameOrdinal = start.frameOrdinal;
    this.#expectedConfig = expectedConfig;
    this.#pages = new ExactSequentialPageCache(source, start.byteOffset, pageBytes);
  }

  readNext(signal: AbortSignal): Promise<AdtsIncrementalFrame | null> {
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('ADTS incremental frame read requires an AbortSignal'));
    }
    // A structural failure poisons this exact reader generation. A caller
    // abort leaves the cursor untouched and can be retried with a fresh signal.
    if (this.#hasFatalError) return Promise.reject(this.#fatalError);
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#reading) {
      return Promise.reject(
        new AdtsIncrementalFrameReaderError(
          'Concurrent or reentrant ADTS incremental frame reads are not supported',
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

  async #readNext(signal: AbortSignal): Promise<AdtsIncrementalFrame | null> {
    if (this.#nextByteOffset === this.#sourceSize) return null;
    const frameOrdinal = this.#nextFrameOrdinal;
    const byteOffset = this.#nextByteOffset;
    const remaining = this.#sourceSize - byteOffset;
    if (remaining < ADTS_HEADER_BYTES) {
      throw new AdtsIncrementalFrameReaderError(
        `ADTS source has ${remaining} trailing byte${remaining === 1 ? '' : 's'} where frame ${frameOrdinal} must begin`,
      );
    }

    const headerBytes = new Uint8ArrayIntrinsic(ADTS_HEADER_BYTES);
    await this.#pages.copyInto(headerBytes, 0, byteOffset, ADTS_HEADER_BYTES, signal);
    const header = parseHeader(headerBytes, byteOffset);
    admitHeader(header, byteOffset);
    const configuration = configurationFromHeader(header);
    const requiredConfiguration = this.#activeConfig ?? this.#expectedConfig;
    if (requiredConfiguration && !sameConfiguration(configuration, requiredConfiguration)) {
      throw new AdtsIncrementalFrameReaderError(
        `ADTS core configuration changes or contradicts verified metadata at byte ${byteOffset}`,
      );
    }

    const byteEndOffset = safeAdd(byteOffset, header.frameLengthBytes, 'ADTS frame end');
    if (byteEndOffset > this.#sourceSize) {
      throw new AdtsIncrementalFrameReaderError(
        `ADTS frame ${frameOrdinal} at byte ${byteOffset} is truncated at physical EOF`,
      );
    }

    const bytes = new Uint8ArrayIntrinsic(header.frameLengthBytes);
    bytes.set(headerBytes);
    await this.#pages.copyInto(
      bytes,
      ADTS_HEADER_BYTES,
      byteOffset + ADTS_HEADER_BYTES,
      header.frameLengthBytes - ADTS_HEADER_BYTES,
      signal,
    );
    const nextFrameOrdinal = safeAdd(frameOrdinal, 1, 'ADTS frame ordinal');
    const descriptor: Readonly<AdtsIncrementalFrameDescriptor> = Object.freeze({
      header,
      frameOrdinal,
      byteOffset,
      byteEndOffset,
    });
    const frame: AdtsIncrementalFrame = Object.freeze({ bytes, descriptor });

    throwIfAborted(signal);
    this.#activeConfig = configuration;
    this.#nextFrameOrdinal = nextFrameOrdinal;
    this.#nextByteOffset = byteEndOffset;
    return frame;
  }
}
