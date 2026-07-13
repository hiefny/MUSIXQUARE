import { parseAdtsHeader, type AdtsHeader } from './adts-header.ts';
import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES,
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS,
  AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES,
  AAC_DECODER_BACKEND_MIN_ACCESS_UNIT_BYTES,
  AAC_DECODER_BACKEND_MIN_RAW_ACCESS_UNIT_BYTES,
  AacDecoderBackendClosedError,
  AacDecoderBackendIntegrityError,
  AacDecoderBackendUnavailableError,
  aacCoreSampleRateHz,
  aacGenerationTimestampMicroseconds,
  snapshotAacDecoderBackendGenerationOptions,
  type AacDecoderAccessUnit,
  type AacDecoderBackend,
  type AacDecoderBackendFraming,
  type AacDecoderBackendGenerationOptions,
  type AacDecoderPcmBatch,
  type AacDecoderPcmPlanes,
} from './decoder-backend.ts';
import type { AdtsCoreConfiguration } from './incremental-frame-reader.ts';

const AAC_LC_CODEC = 'mp4a.40.2' as const;
const FLOAT32_BYTES = 4;
/** Native implementations normally emit one callback per AU; this also permits heavy splitting. */
export const AAC_WEB_CODECS_MAX_OUTPUT_CALLBACKS_PER_BATCH = 64;
/**
 * Chromium can quantize an exact rational AAC boundary one microsecond below
 * the submitted timestamp. One microsecond remains far below the shortest
 * admitted AAC-LC access unit (over 10 ms at 96 kHz), so it cannot make a
 * stale or reordered neighbouring access unit valid.
 */
export const AAC_WEB_CODECS_TIMESTAMP_TOLERANCE_MICROSECONDS = 1;

export interface AacWebCodecsBatchDecoderConfig {
  readonly codec: typeof AAC_LC_CODEC;
  readonly sampleRate: number;
  readonly numberOfChannels: 1 | 2;
  readonly description?: Uint8Array;
}

export interface AacWebCodecsBatchAudioDataCopyOptions {
  readonly format: 'f32-planar';
  readonly planeIndex: number;
  readonly frameOffset: 0;
  readonly frameCount: number;
}

export interface AacWebCodecsBatchAudioData {
  readonly numberOfChannels: unknown;
  readonly numberOfFrames: unknown;
  readonly sampleRate: unknown;
  readonly timestamp: unknown;
  allocationSize(options: AacWebCodecsBatchAudioDataCopyOptions): unknown;
  copyTo(destination: Uint8Array, options: AacWebCodecsBatchAudioDataCopyOptions): void;
  close(): void;
}

export interface AacWebCodecsBatchDecoderInit {
  readonly output: (data: AacWebCodecsBatchAudioData) => void;
  readonly error: (error: unknown) => void;
}

export interface AacWebCodecsBatchEncodedAudioChunkInit {
  readonly type: 'key';
  readonly timestamp: number;
  readonly data: Uint8Array;
}

export interface AacWebCodecsBatchNativeDecoder {
  configure(config: AacWebCodecsBatchDecoderConfig): void;
  decode(chunk: unknown): void;
  flush(): PromiseLike<void>;
  close(): void;
}

/** Small injectable surface; the production default binds directly to Worker WebCodecs globals. */
export interface AacWebCodecsBatchBindings {
  isConfigSupported(config: AacWebCodecsBatchDecoderConfig): PromiseLike<unknown>;
  createDecoder(init: AacWebCodecsBatchDecoderInit): AacWebCodecsBatchNativeDecoder;
  createEncodedAudioChunk(init: AacWebCodecsBatchEncodedAudioChunkInit): unknown;
}

interface BindingSnapshot {
  readonly authority: AacWebCodecsBatchBindings;
  readonly isConfigSupported: AacWebCodecsBatchBindings['isConfigSupported'];
  readonly createDecoder: AacWebCodecsBatchBindings['createDecoder'];
  readonly createEncodedAudioChunk: AacWebCodecsBatchBindings['createEncodedAudioChunk'];
}

interface NativeDecoderSnapshot {
  readonly authority: AacWebCodecsBatchNativeDecoder;
  readonly configure: AacWebCodecsBatchNativeDecoder['configure'];
  readonly decode: AacWebCodecsBatchNativeDecoder['decode'];
  readonly flush: AacWebCodecsBatchNativeDecoder['flush'];
  readonly close: AacWebCodecsBatchNativeDecoder['close'];
}

interface VerifiedAccessUnit {
  readonly accessUnitOrdinal: number;
  readonly bytes: Uint8Array;
}

interface ActiveBatch {
  readonly firstAccessUnitOrdinal: number;
  readonly accessUnitCount: number;
  readonly expectedFrames: number;
  readonly planes: AacDecoderPcmPlanes;
  readonly failurePromise: Promise<unknown>;
  readonly reportFailure: (cause: unknown) => void;
  submittedAccessUnits: number;
  writtenFrames: number;
  outputCallbacks: number;
  processingOutput: boolean;
  settled: boolean;
}

const Uint8ArrayIntrinsic = Uint8Array;
const Float32ArrayIntrinsic = Float32Array;
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
const uint8ArrayFill = Uint8ArrayIntrinsic.prototype.fill;
const uint8ArraySubarray = Uint8ArrayIntrinsic.prototype.subarray;
const float32ArrayFill = Float32ArrayIntrinsic.prototype.fill;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;
const NO_FAILURE = Symbol('no AAC decoder failure');

function readAbortReason(signal: AbortSignal): unknown {
  try {
    return trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : undefined;
  } catch (cause) {
    return cause;
  }
}

function exactAbortReason(signal: AbortSignal): {
  readonly aborted: boolean;
  readonly reason: unknown;
} {
  let aborted: unknown;
  try {
    aborted = trustedAbortAborted ? Reflect.apply(trustedAbortAborted, signal, []) : signal.aborted;
  } catch (cause) {
    return Object.freeze({ aborted: true, reason: cause });
  }
  if (aborted !== true) return Object.freeze({ aborted: false, reason: undefined });
  const reason = readAbortReason(signal);
  return Object.freeze({
    aborted: true,
    reason:
      reason === undefined
        ? new DOMException('The AAC WebCodecs decoder operation was aborted', 'AbortError')
        : reason,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (typeof trustedAbortThrowIfAborted === 'function') {
    Reflect.apply(trustedAbortThrowIfAborted, signal, []);
    return;
  }
  const state = exactAbortReason(signal);
  if (state.aborted) throw state.reason;
}

function requireAbortSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError('AAC WebCodecs decoding requires an exact AbortSignal');
  }
  return value;
}

function addAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetAdd, signal, ['abort', listener, { once: true }]);
}

function removeAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetRemove, signal, ['abort', listener]);
}

async function raceAbort<T>(task: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort!: (reason: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const listener: EventListener = () => rejectAbort(exactAbortReason(signal).reason);
  addAbortListener(signal, listener);
  try {
    throwIfAborted(signal);
    return await Promise.race([Promise.resolve(task), abortPromise]);
  } finally {
    removeAbortListener(signal, listener);
  }
}

function asUnavailable(message: string, cause: unknown): AacDecoderBackendUnavailableError {
  return cause instanceof AacDecoderBackendUnavailableError
    ? cause
    : new AacDecoderBackendUnavailableError(message, cause);
}

function snapshotBindings(value: unknown): BindingSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('AAC WebCodecs bindings are required');
  }
  const authority = value as AacWebCodecsBatchBindings;
  let isConfigSupported: AacWebCodecsBatchBindings['isConfigSupported'];
  let createDecoder: AacWebCodecsBatchBindings['createDecoder'];
  let createEncodedAudioChunk: AacWebCodecsBatchBindings['createEncodedAudioChunk'];
  try {
    isConfigSupported = authority.isConfigSupported;
    createDecoder = authority.createDecoder;
    createEncodedAudioChunk = authority.createEncodedAudioChunk;
  } catch (cause) {
    throw new TypeError('AAC WebCodecs bindings could not be inspected', { cause });
  }
  if (
    typeof isConfigSupported !== 'function' ||
    typeof createDecoder !== 'function' ||
    typeof createEncodedAudioChunk !== 'function'
  ) {
    throw new TypeError('AAC WebCodecs bindings are incomplete');
  }
  return Object.freeze({ authority, isConfigSupported, createDecoder, createEncodedAudioChunk });
}

function defaultBindings(): AacWebCodecsBatchBindings {
  const decoderConstructor = globalThis.AudioDecoder;
  const chunkConstructor = globalThis.EncodedAudioChunk;
  if (
    typeof decoderConstructor !== 'function' ||
    typeof decoderConstructor.isConfigSupported !== 'function' ||
    typeof chunkConstructor !== 'function'
  ) {
    throw new AacDecoderBackendUnavailableError('WebCodecs audio decoding is unavailable');
  }
  return Object.freeze({
    isConfigSupported(config: AacWebCodecsBatchDecoderConfig): PromiseLike<unknown> {
      return Reflect.apply(decoderConstructor.isConfigSupported, decoderConstructor, [config]);
    },
    createDecoder(init: AacWebCodecsBatchDecoderInit): AacWebCodecsBatchNativeDecoder {
      return new decoderConstructor({
        output: init.output as AudioDataOutputCallback,
        error: init.error,
      }) as unknown as AacWebCodecsBatchNativeDecoder;
    },
    createEncodedAudioChunk(init: AacWebCodecsBatchEncodedAudioChunkInit): unknown {
      return new chunkConstructor(init);
    },
  });
}

function snapshotNativeDecoder(value: unknown): NativeDecoderSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('AAC WebCodecs decoder binding is invalid');
  }
  const authority = value as AacWebCodecsBatchNativeDecoder;
  let configure: AacWebCodecsBatchNativeDecoder['configure'];
  let decode: AacWebCodecsBatchNativeDecoder['decode'];
  let flush: AacWebCodecsBatchNativeDecoder['flush'];
  let close: AacWebCodecsBatchNativeDecoder['close'];
  try {
    configure = authority.configure;
    decode = authority.decode;
    flush = authority.flush;
    close = authority.close;
  } catch (cause) {
    throw new TypeError('AAC WebCodecs decoder methods could not be inspected', { cause });
  }
  if (
    typeof configure !== 'function' ||
    typeof decode !== 'function' ||
    typeof flush !== 'function' ||
    typeof close !== 'function'
  ) {
    throw new TypeError('AAC WebCodecs decoder binding is incomplete');
  }
  return Object.freeze({ authority, configure, decode, flush, close });
}

function snapshotBytes(value: unknown, minimumBytes: number, framingLabel: string): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value) ||
    typedArrayTagGetter.call(value) !== 'Uint8Array'
  ) {
    throw new AacDecoderBackendIntegrityError('AAC access unit must be a Uint8Array');
  }

  let byteLength: number;
  try {
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // Reject SharedArrayBuffer and detached storage before copying a security boundary.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      'AAC access unit must use readable, non-shared storage',
      cause,
    );
  }
  if (byteLength < minimumBytes || byteLength > AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES) {
    throw new AacDecoderBackendIntegrityError(
      `AAC access-unit byte length is outside ${framingLabel} bounds`,
    );
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    Reflect.apply(uint8ArraySet, owned, [value, 0]);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError('AAC access unit could not be copied', cause);
  }
  return owned;
}

function snapshotAccessUnitRecord(value: unknown): {
  readonly accessUnitOrdinal: unknown;
  readonly bytes: unknown;
} {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError('AAC access unit could not be inspected', cause);
  }
  if (value === null || typeof value !== 'object' || isArray) {
    throw new AacDecoderBackendIntegrityError('AAC access unit must be a plain data record');
  }
  let prototype: object | null;
  let ordinal: PropertyDescriptor | undefined;
  let bytes: PropertyDescriptor | undefined;
  let keys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    ordinal = Reflect.getOwnPropertyDescriptor(value, 'accessUnitOrdinal');
    bytes = Reflect.getOwnPropertyDescriptor(value, 'bytes');
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError('AAC access unit could not be inspected', cause);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 2 ||
    !keys.includes('accessUnitOrdinal') ||
    !keys.includes('bytes') ||
    !ordinal ||
    ordinal.enumerable !== true ||
    !Object.hasOwn(ordinal, 'value') ||
    !bytes ||
    bytes.enumerable !== true ||
    !Object.hasOwn(bytes, 'value')
  ) {
    throw new AacDecoderBackendIntegrityError(
      'AAC access unit must use plain enumerable data fields',
    );
  }
  return Object.freeze({ accessUnitOrdinal: ordinal.value, bytes: bytes.value });
}

function requireSafeOrdinal(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new AacDecoderBackendIntegrityError(
      'AAC access-unit ordinal must be a non-negative safe integer',
    );
  }
  return value;
}

function verifyHeader(
  bytes: Uint8Array,
  expected: Readonly<AdtsCoreConfiguration>,
): Readonly<AdtsHeader> {
  try {
    if (((bytes[1] ?? 0) & 1) !== 1) {
      throw new AacDecoderBackendIntegrityError('AAC WebCodecs batches reject ADTS CRC framing');
    }
    const headerBytes = Reflect.apply(uint8ArraySubarray, bytes, [0, 7]) as Uint8Array;
    const header = parseAdtsHeader(headerBytes);
    if (header.frameLengthBytes !== bytes.byteLength) {
      throw new AacDecoderBackendIntegrityError(
        'AAC access-unit bytes contradict the ADTS frame length',
      );
    }
    if (
      header.mpegId !== 0 ||
      header.profile !== 1 ||
      header.coreAudioObjectType !== 2 ||
      header.protectionAbsent !== true ||
      header.rawDataBlocks !== 1 ||
      (header.channelConfiguration !== 1 && header.channelConfiguration !== 2) ||
      header.coreChannelCount !== header.channelConfiguration
    ) {
      throw new AacDecoderBackendIntegrityError(
        'AAC WebCodecs batches require strict MPEG-4 AAC-LC mono/stereo ADTS',
      );
    }
    if (
      header.mpegId !== expected.mpegId ||
      header.profile !== expected.profile ||
      header.coreAudioObjectType !== expected.coreAudioObjectType ||
      header.sampleRateIndex !== expected.sampleRateIndex ||
      header.channelConfiguration !== expected.channelConfiguration ||
      header.protectionAbsent !== expected.protectionAbsent ||
      header.rawDataBlocks !== expected.rawDataBlocks
    ) {
      throw new AacDecoderBackendIntegrityError(
        'AAC access-unit core configuration changed within the decoder generation',
      );
    }
    return header;
  } catch (cause) {
    if (cause instanceof AacDecoderBackendIntegrityError) throw cause;
    throw new AacDecoderBackendIntegrityError(
      'AAC access unit failed defensive ADTS parsing',
      cause,
    );
  }
}

function snapshotBatch(
  value: unknown,
  expectedFirstOrdinal: number | null,
  expectedConfig: Readonly<AdtsCoreConfiguration>,
  framing: Readonly<AacDecoderBackendFraming>,
): readonly VerifiedAccessUnit[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError('AAC decoder batch could not be inspected', cause);
  }
  if (!isArray) {
    throw new AacDecoderBackendIntegrityError('AAC decoder batch must be an array');
  }
  const batch = value as object;
  let length: number;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(batch, 'length');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('missing length');
    length = descriptor.value as number;
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError('AAC decoder batch length is unreadable', cause);
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS
  ) {
    throw new AacDecoderBackendIntegrityError(
      `AAC decoder batch must contain 1 through ${AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS} access units`,
    );
  }
  try {
    const keys = Reflect.ownKeys(batch);
    if (
      keys.length !== length + 1 ||
      !keys.includes('length') ||
      keys.some((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })
    ) {
      throw new TypeError('batch has extra, symbolic, or missing fields');
    }
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      'AAC decoder batch must contain only exact indexed data fields',
      cause,
    );
  }
  if (expectedFirstOrdinal === null) {
    throw new AacDecoderBackendIntegrityError('AAC decoder ordinal range is exhausted');
  }

  const verified: VerifiedAccessUnit[] = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < length; index += 1) {
      let element: unknown;
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(batch, String(index));
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('batch element is missing or accessor-backed');
        }
        element = descriptor.value;
      } catch (cause) {
        throw new AacDecoderBackendIntegrityError(
          'AAC decoder batch is sparse or unreadable',
          cause,
        );
      }
      const record = snapshotAccessUnitRecord(element);
      const ordinal = requireSafeOrdinal(record.accessUnitOrdinal);
      const requiredOrdinal = expectedFirstOrdinal + index;
      if (!Number.isSafeInteger(requiredOrdinal) || ordinal !== requiredOrdinal) {
        throw new AacDecoderBackendIntegrityError(
          'AAC decoder batch ordinals must be exact and contiguous across the generation',
        );
      }
      const bytes = snapshotBytes(
        record.bytes,
        framing.kind === 'adts'
          ? AAC_DECODER_BACKEND_MIN_ACCESS_UNIT_BYTES
          : AAC_DECODER_BACKEND_MIN_RAW_ACCESS_UNIT_BYTES,
        framing.kind === 'adts' ? 'ADTS' : 'raw AAC',
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES) {
        Reflect.apply(uint8ArrayFill, bytes, [0]);
        throw new AacDecoderBackendIntegrityError(
          'AAC decoder batch exceeds its encoded-byte bound',
        );
      }
      try {
        if (framing.kind === 'adts') verifyHeader(bytes, expectedConfig);
        verified.push(Object.freeze({ accessUnitOrdinal: ordinal, bytes }));
      } catch (cause) {
        Reflect.apply(uint8ArrayFill, bytes, [0]);
        throw cause;
      }
    }
    return Object.freeze(verified);
  } catch (cause) {
    for (const accessUnit of verified) Reflect.apply(uint8ArrayFill, accessUnit.bytes, [0]);
    throw cause;
  }
}

function createPlanes(channels: 1 | 2, frames: number): AacDecoderPcmPlanes {
  if (channels === 1) return Object.freeze([new Float32ArrayIntrinsic(frames)]);
  return Object.freeze([new Float32ArrayIntrinsic(frames), new Float32ArrayIntrinsic(frames)]);
}

function clearPlanes(planes: AacDecoderPcmPlanes): void {
  for (const plane of planes) {
    try {
      Reflect.apply(float32ArrayFill, plane, [0]);
    } catch {
      // A hostile injected copyTo can detach a destination. The generation is
      // already poisoned; cleanup must not replace the original failure.
    }
  }
}

function isObjectIdentity(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function readPositiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value <= 0
  ) {
    throw new AacDecoderBackendIntegrityError(`${label} must be a positive safe integer`);
  }
  return value;
}

function readNonNegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new AacDecoderBackendIntegrityError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function outputTimestampIntervalMicroseconds(
  active: ActiveBatch,
  generationFirstAccessUnitOrdinal: number,
  coreSampleRateHz: number,
): readonly [floor: number, ceil: number] {
  // WebCodecs may split one decoded AU across callbacks while repeating that
  // AU's timestamp, so snap the already-written cursor back to its AU origin.
  const batchAccessUnitOffset = Math.floor(
    active.writtenFrames / AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  );
  const generationAccessUnitOffset =
    BigInt(active.firstAccessUnitOrdinal) -
    BigInt(generationFirstAccessUnitOrdinal) +
    BigInt(batchAccessUnitOffset);
  const numerator =
    generationAccessUnitOffset * BigInt(AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES) * 1_000_000n;
  const denominator = BigInt(coreSampleRateHz);
  const floor = numerator / denominator;
  const ceil = (numerator + denominator - 1n) / denominator;
  const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  if (ceil > maximumSafeInteger) {
    throw new AacDecoderBackendIntegrityError(
      'WebCodecs output timestamp exceeds the generation safe-integer range',
    );
  }
  const maximum =
    ceil < maximumSafeInteger
      ? ceil + BigInt(AAC_WEB_CODECS_TIMESTAMP_TOLERANCE_MICROSECONDS)
      : maximumSafeInteger;
  const minimum =
    floor > BigInt(AAC_WEB_CODECS_TIMESTAMP_TOLERANCE_MICROSECONDS)
      ? floor - BigInt(AAC_WEB_CODECS_TIMESTAMP_TOLERANCE_MICROSECONDS)
      : 0n;
  return Object.freeze([Number(minimum), Number(maximum)]);
}

class WebCodecsAacBatchDecoder implements AacDecoderBackend {
  readonly id = 'webcodecs' as const;
  readonly coreSampleRateHz: number;
  readonly channels: 1 | 2;
  readonly firstAccessUnitOrdinal: number;

  readonly #framing: Readonly<AacDecoderBackendFraming>;

  private readonly configuration: Readonly<AdtsCoreConfiguration>;
  private readonly bindings: BindingSnapshot;
  private readonly closedOutputs = new WeakSet<object>();
  private nativeDecoder: NativeDecoderSnapshot | null = null;
  private nativeCloseAttempted = false;
  private terminalFailure: unknown | typeof NO_FAILURE = NO_FAILURE;
  private normallyClosed = false;
  private decodeOperationInProgress = false;
  private activeBatch: ActiveBatch | null = null;
  private nextAccessUnitOrdinal: number | null;

  constructor(options: Readonly<AacDecoderBackendGenerationOptions>, bindings: BindingSnapshot) {
    this.configuration = options.coreConfiguration;
    this.firstAccessUnitOrdinal = options.firstAccessUnitOrdinal;
    this.#framing = options.framing;
    Object.defineProperty(this, 'framing', {
      configurable: false,
      enumerable: true,
      value: this.#framing,
      writable: false,
    });
    this.nextAccessUnitOrdinal = options.firstAccessUnitOrdinal;
    this.channels = options.coreConfiguration.channelConfiguration;
    this.coreSampleRateHz = aacCoreSampleRateHz(options.coreConfiguration);
    this.bindings = bindings;
  }

  get framing(): Readonly<AacDecoderBackendFraming> {
    return this.#framing;
  }

  createNativeConfig(): Readonly<AacWebCodecsBatchDecoderConfig> {
    const base = {
      codec: AAC_LC_CODEC,
      sampleRate: this.coreSampleRateHz,
      numberOfChannels: this.channels,
    } as const;
    if (this.#framing.kind === 'adts') return Object.freeze(base);
    const description = new Uint8ArrayIntrinsic(this.#framing.description.length);
    for (let index = 0; index < description.length; index += 1) {
      description[index] = this.#framing.description[index] ?? 0;
    }
    return Object.freeze({ ...base, description });
  }

  initialize(): void {
    let candidate: unknown;
    try {
      candidate = Reflect.apply(this.bindings.createDecoder, this.bindings.authority, [
        Object.freeze({
          output: (data: AacWebCodecsBatchAudioData): void => this.handleOutput(data),
          error: (error: unknown): void => {
            if (this.normallyClosed || this.terminalFailure !== NO_FAILURE) return;
            this.poison(asUnavailable('WebCodecs AAC decoder reported an error', error));
          },
        }),
      ]);
      try {
        this.nativeDecoder = snapshotNativeDecoder(candidate);
      } catch (cause) {
        this.closeUnboundCandidateOnce(candidate);
        throw cause;
      }
      if (this.terminalFailure !== NO_FAILURE) {
        this.closeNativeOnce();
        throw this.terminalFailure;
      }
      Reflect.apply(this.nativeDecoder.configure, this.nativeDecoder.authority, [
        this.createNativeConfig(),
      ]);
      if (this.terminalFailure !== NO_FAILURE) throw this.terminalFailure;
    } catch (cause) {
      const failure =
        this.terminalFailure !== NO_FAILURE
          ? this.terminalFailure
          : asUnavailable('WebCodecs AAC decoder configuration failed', cause);
      this.poison(failure);
      throw failure;
    }
  }

  async decodeBatch(
    accessUnits: readonly Readonly<AacDecoderAccessUnit>[],
    signalValue: AbortSignal,
  ): Promise<Readonly<AacDecoderPcmBatch>> {
    const signal = requireAbortSignal(signalValue);
    if (this.normallyClosed) throw new AacDecoderBackendClosedError();
    if (this.terminalFailure !== NO_FAILURE) throw this.terminalFailure;
    if (this.decodeOperationInProgress || this.activeBatch !== null) {
      const failure = new AacDecoderBackendIntegrityError(
        'AAC decoder generation does not permit overlapping or reentrant batches',
      );
      this.poison(failure);
      throw failure;
    }
    this.decodeOperationInProgress = true;

    let verified: readonly VerifiedAccessUnit[] = [];
    let active: ActiveBatch | null = null;
    try {
      throwIfAborted(signal);
      verified = snapshotBatch(
        accessUnits,
        this.nextAccessUnitOrdinal,
        this.configuration,
        this.#framing,
      );
      this.throwCurrentFailureOrAbort(signal);

      const expectedFrames = verified.length * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
      const planes = createPlanes(this.channels, expectedFrames);
      let reportFailure!: (cause: unknown) => void;
      const failurePromise = new Promise<unknown>((resolve) => {
        reportFailure = resolve;
      });
      active = {
        firstAccessUnitOrdinal: verified[0]!.accessUnitOrdinal,
        accessUnitCount: verified.length,
        expectedFrames,
        planes,
        failurePromise,
        reportFailure,
        submittedAccessUnits: 0,
        writtenFrames: 0,
        outputCallbacks: 0,
        processingOutput: false,
        settled: false,
      };
      this.activeBatch = active;

      const decoder = this.nativeDecoder;
      if (!decoder) {
        throw new AacDecoderBackendUnavailableError('WebCodecs AAC decoder is unavailable');
      }
      for (let index = 0; index < verified.length; index += 1) {
        const accessUnit = verified[index]!;
        const init = Object.freeze({
          type: 'key' as const,
          timestamp: aacGenerationTimestampMicroseconds(
            accessUnit.accessUnitOrdinal,
            this.firstAccessUnitOrdinal,
            this.coreSampleRateHz,
          ),
          data: accessUnit.bytes,
        });
        let chunk: unknown;
        try {
          chunk = Reflect.apply(this.bindings.createEncodedAudioChunk, this.bindings.authority, [
            init,
          ]);
        } catch (cause) {
          throw asUnavailable('WebCodecs rejected an AAC encoded chunk', cause);
        } finally {
          // Native EncodedAudioChunk construction synchronously copies BufferSource.
          Reflect.apply(uint8ArrayFill, accessUnit.bytes, [0]);
        }
        this.throwCurrentFailureOrAbort(signal);
        active.submittedAccessUnits = index + 1;
        try {
          Reflect.apply(decoder.decode, decoder.authority, [chunk]);
        } catch (cause) {
          throw asUnavailable('WebCodecs AAC decode submission failed', cause);
        }
        this.throwCurrentFailureOrAbort(signal);
      }

      let flushTask: PromiseLike<void>;
      try {
        flushTask = Reflect.apply(decoder.flush, decoder.authority, []) as PromiseLike<void>;
      } catch (cause) {
        throw asUnavailable('WebCodecs AAC decoder flush could not start', cause);
      }
      const completion = Promise.race([
        Promise.resolve(flushTask).then(() => Object.freeze({ kind: 'flush' as const })),
        active.failurePromise.then((cause) => Object.freeze({ kind: 'failure' as const, cause })),
      ]);
      let completed: Awaited<typeof completion>;
      try {
        completed = await this.raceActiveAbort(completion, signal);
      } catch (cause) {
        const abort = exactAbortReason(signal);
        if (abort.aborted) throw abort.reason;
        throw asUnavailable('WebCodecs AAC decoder flush failed', cause);
      }
      if (completed.kind === 'failure') throw completed.cause;
      this.throwCurrentFailureOrAbort(signal);
      if (active.writtenFrames !== active.expectedFrames || active.outputCallbacks < 1) {
        throw new AacDecoderBackendIntegrityError(
          'WebCodecs did not emit exactly 1024 core frames per AAC access unit',
        );
      }

      active.settled = true;
      this.activeBatch = null;
      const lastOrdinal = verified[verified.length - 1]!.accessUnitOrdinal;
      this.nextAccessUnitOrdinal = lastOrdinal === Number.MAX_SAFE_INTEGER ? null : lastOrdinal + 1;
      const result = Object.freeze({
        firstAccessUnitOrdinal: active.firstAccessUnitOrdinal,
        accessUnitCount: active.accessUnitCount,
        frameCount: active.expectedFrames,
        sampleRateHz: this.coreSampleRateHz,
        channels: this.channels,
        planes: active.planes,
      });
      active = null;
      return result;
    } catch (cause) {
      const abort = exactAbortReason(signal);
      const failure = abort.aborted ? abort.reason : cause;
      this.poison(failure, abort.aborted);
      throw failure;
    } finally {
      this.decodeOperationInProgress = false;
      for (const accessUnit of verified) Reflect.apply(uint8ArrayFill, accessUnit.bytes, [0]);
      if (active !== null) {
        active.settled = true;
        clearPlanes(active.planes);
        if (this.activeBatch === active) this.activeBatch = null;
      }
    }
  }

  close(): void {
    if (this.normallyClosed || this.terminalFailure !== NO_FAILURE) return;
    this.normallyClosed = true;
    const failure = new AacDecoderBackendClosedError();
    const active = this.activeBatch;
    if (active && !active.settled) active.reportFailure(failure);
    this.closeNativeOnce();
  }

  private async raceActiveAbort<T>(task: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    let rejectAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const listener: EventListener = () => {
      const reason = exactAbortReason(signal).reason;
      this.poison(reason, true);
      rejectAbort(reason);
    };
    addAbortListener(signal, listener);
    try {
      throwIfAborted(signal);
      return await Promise.race([Promise.resolve(task), abortPromise]);
    } finally {
      removeAbortListener(signal, listener);
    }
  }

  private throwCurrentFailureOrAbort(signal: AbortSignal): void {
    const abort = exactAbortReason(signal);
    if (abort.aborted) throw abort.reason;
    if (this.terminalFailure !== NO_FAILURE) throw this.terminalFailure;
    if (this.normallyClosed) throw new AacDecoderBackendClosedError();
  }

  private poison(cause: unknown, prefer = false): void {
    if (this.normallyClosed) return;
    if (this.terminalFailure === NO_FAILURE || prefer) this.terminalFailure = cause;
    const active = this.activeBatch;
    if (active && !active.settled) active.reportFailure(this.terminalFailure);
    this.closeNativeOnce();
  }

  private closeNativeOnce(): AacDecoderBackendUnavailableError | null {
    if (this.nativeCloseAttempted) return null;
    const decoder = this.nativeDecoder;
    if (!decoder) return null;
    this.nativeCloseAttempted = true;
    try {
      Reflect.apply(decoder.close, decoder.authority, []);
      return null;
    } catch (cause) {
      const failure = asUnavailable('WebCodecs AAC decoder could not be closed', cause);
      if (this.terminalFailure === NO_FAILURE && !this.normallyClosed) {
        this.terminalFailure = failure;
      }
      return failure;
    }
  }

  private closeUnboundCandidateOnce(candidate: unknown): AacDecoderBackendUnavailableError | null {
    if (this.nativeCloseAttempted || !isObjectIdentity(candidate)) return null;
    this.nativeCloseAttempted = true;
    try {
      const close = Reflect.get(candidate, 'close');
      if (typeof close !== 'function') return null;
      Reflect.apply(close, candidate, []);
      return null;
    } catch (cause) {
      return asUnavailable('Invalid WebCodecs AAC decoder could not be closed', cause);
    }
  }

  private closeOutputOnce(output: unknown): AacDecoderBackendUnavailableError | null {
    if (!isObjectIdentity(output)) {
      return new AacDecoderBackendUnavailableError('WebCodecs emitted non-object AudioData');
    }
    if (this.closedOutputs.has(output)) return null;
    this.closedOutputs.add(output);
    try {
      const close = (output as AacWebCodecsBatchAudioData).close;
      if (typeof close !== 'function') throw new TypeError('AudioData close is unavailable');
      Reflect.apply(close, output, []);
      return null;
    } catch (cause) {
      return asUnavailable('WebCodecs AudioData could not be closed', cause);
    }
  }

  /**
   * Copy native output immediately into bounded canonical storage.
   *
   * Exact rate/channel/1024 geometry rejects visible SBR/PS expansion. It
   * cannot prove absence of in-band SBR/PS if a user agent silently ignores
   * those extensions; canonical payload validation or a cohort WASM backend is
   * still required for that stronger claim.
   */
  private handleOutput(data: AacWebCodecsBatchAudioData): void {
    if (!isObjectIdentity(data)) {
      this.poison(new AacDecoderBackendIntegrityError('WebCodecs emitted invalid AudioData'));
      return;
    }
    if (this.closedOutputs.has(data)) {
      if (!this.normallyClosed && this.terminalFailure === NO_FAILURE) {
        this.poison(
          new AacDecoderBackendIntegrityError('WebCodecs emitted the same AudioData twice'),
        );
      }
      return;
    }

    const active = this.activeBatch;
    if (this.normallyClosed || this.terminalFailure !== NO_FAILURE || !active || active.settled) {
      const closeFailure = this.closeOutputOnce(data);
      if (closeFailure && !this.normallyClosed && this.terminalFailure === NO_FAILURE) {
        this.poison(closeFailure);
      } else if (!this.normallyClosed && this.terminalFailure === NO_FAILURE) {
        this.poison(
          new AacDecoderBackendIntegrityError(
            'WebCodecs emitted AudioData outside its submitted AAC batch',
          ),
        );
      }
      return;
    }
    if (active.submittedAccessUnits < 1) {
      const closeFailure = this.closeOutputOnce(data);
      this.poison(
        closeFailure ??
          new AacDecoderBackendIntegrityError(
            'WebCodecs emitted AudioData before an AAC access unit was submitted',
          ),
      );
      return;
    }
    if (active.processingOutput) {
      const closeFailure = this.closeOutputOnce(data);
      this.poison(
        closeFailure ??
          new AacDecoderBackendIntegrityError('WebCodecs re-entered its AudioData callback'),
      );
      return;
    }

    active.processingOutput = true;
    let failure: unknown | typeof NO_FAILURE = NO_FAILURE;
    try {
      active.outputCallbacks += 1;
      if (active.outputCallbacks > AAC_WEB_CODECS_MAX_OUTPUT_CALLBACKS_PER_BATCH) {
        throw new AacDecoderBackendIntegrityError(
          'WebCodecs split one AAC batch into too many output callbacks',
        );
      }
      const channels = readPositiveSafeInteger(
        data.numberOfChannels,
        'WebCodecs output channel count',
      );
      const frames = readPositiveSafeInteger(data.numberOfFrames, 'WebCodecs output frame count');
      const sampleRate = readPositiveSafeInteger(data.sampleRate, 'WebCodecs output sample rate');
      const timestamp = readNonNegativeSafeInteger(data.timestamp, 'WebCodecs output timestamp');
      if (channels !== this.channels) {
        throw new AacDecoderBackendIntegrityError(
          'WebCodecs output channel count differs from the AAC core',
        );
      }
      if (sampleRate !== this.coreSampleRateHz) {
        throw new AacDecoderBackendIntegrityError(
          'WebCodecs output sample rate differs from the AAC core',
        );
      }
      const [minimumTimestamp, maximumTimestamp] = outputTimestampIntervalMicroseconds(
        active,
        this.firstAccessUnitOrdinal,
        this.coreSampleRateHz,
      );
      if (timestamp < minimumTimestamp || timestamp > maximumTimestamp) {
        throw new AacDecoderBackendIntegrityError(
          `WebCodecs output timestamp ${timestamp} is stale, reordered, or outside its AAC core interval ${minimumTimestamp}-${maximumTimestamp} after ${active.writtenFrames} written frames and ${active.submittedAccessUnits} submitted access units`,
        );
      }
      if (
        this.normallyClosed ||
        this.terminalFailure !== NO_FAILURE ||
        active !== this.activeBatch
      ) {
        if (this.terminalFailure !== NO_FAILURE) throw this.terminalFailure;
        if (this.normallyClosed) throw new AacDecoderBackendClosedError();
        throw new AacDecoderBackendIntegrityError(
          'WebCodecs output callback changed decoder state',
        );
      }
      const submittedFrameLimit =
        active.submittedAccessUnits * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
      if (
        frames > active.expectedFrames - active.writtenFrames ||
        active.writtenFrames + frames > submittedFrameLimit
      ) {
        throw new AacDecoderBackendIntegrityError(
          'WebCodecs output exceeds its submitted AAC-LC core-frame geometry',
        );
      }

      const expectedBytes = frames * FLOAT32_BYTES;
      for (let planeIndex = 0; planeIndex < this.channels; planeIndex += 1) {
        const options = Object.freeze({
          format: 'f32-planar' as const,
          planeIndex,
          frameOffset: 0 as const,
          frameCount: frames,
        });
        const allocationBytes = Reflect.apply(data.allocationSize, data, [options]) as unknown;
        if (allocationBytes !== expectedBytes) {
          throw new AacDecoderBackendIntegrityError(
            'WebCodecs reported an invalid f32-planar allocation size',
          );
        }
        const plane = active.planes[planeIndex]!;
        const start = active.writtenFrames;
        const end = start + frames;
        // A successful copyTo return is insufficient evidence that every byte
        // was written. NaN sentinels make no-op/partial native copies fail the
        // finite-PCM scan without allocating another plane-sized scratch area.
        Reflect.apply(float32ArrayFill, plane, [Number.NaN, start, end]);
        const destination = new Uint8ArrayIntrinsic(
          plane.buffer,
          plane.byteOffset + start * FLOAT32_BYTES,
          expectedBytes,
        );
        Reflect.apply(data.copyTo, data, [destination, options]);
        if (
          this.normallyClosed ||
          this.terminalFailure !== NO_FAILURE ||
          active !== this.activeBatch
        ) {
          if (this.terminalFailure !== NO_FAILURE) throw this.terminalFailure;
          if (this.normallyClosed) throw new AacDecoderBackendClosedError();
          throw new AacDecoderBackendIntegrityError(
            'WebCodecs output callback changed decoder state',
          );
        }
        for (let index = start; index < end; index += 1) {
          if (!Number.isFinite(plane[index])) {
            throw new AacDecoderBackendIntegrityError(
              'WebCodecs emitted non-finite f32-planar PCM',
            );
          }
        }
      }
      active.writtenFrames += frames;
    } catch (cause) {
      failure =
        cause instanceof AacDecoderBackendIntegrityError ||
        cause instanceof AacDecoderBackendUnavailableError ||
        cause instanceof AacDecoderBackendClosedError
          ? cause
          : asUnavailable('WebCodecs could not copy bounded f32-planar PCM', cause);
    } finally {
      const closeFailure = this.closeOutputOnce(data);
      if (failure === NO_FAILURE && closeFailure !== null) failure = closeFailure;
      active.processingOutput = false;
    }
    if (failure !== NO_FAILURE) this.poison(failure);
  }
}

/**
 * Create one fresh, stateful WebCodecs AAC generation after a real support query.
 * The selected backend never silently falls back; cohort policy owns substitution.
 */
export async function createAacWebCodecsBatchDecoder(
  optionsValue: AacDecoderBackendGenerationOptions,
  signalValue: AbortSignal,
  injectedBindings?: AacWebCodecsBatchBindings,
): Promise<AacDecoderBackend> {
  const signal = requireAbortSignal(signalValue);
  throwIfAborted(signal);
  let options: Readonly<AacDecoderBackendGenerationOptions>;
  try {
    options = snapshotAacDecoderBackendGenerationOptions(optionsValue);
  } catch (cause) {
    const abort = exactAbortReason(signal);
    if (abort.aborted) throw abort.reason;
    throw cause;
  }
  throwIfAborted(signal);

  let bindings: BindingSnapshot;
  try {
    bindings = snapshotBindings(injectedBindings ?? defaultBindings());
  } catch (cause) {
    const abort = exactAbortReason(signal);
    if (abort.aborted) throw abort.reason;
    throw cause;
  }
  throwIfAborted(signal);
  const generation = new WebCodecsAacBatchDecoder(options, bindings);

  let support: unknown;
  try {
    const task = Reflect.apply(bindings.isConfigSupported, bindings.authority, [
      generation.createNativeConfig(),
    ]);
    support = await raceAbort(task, signal);
  } catch (cause) {
    const abort = exactAbortReason(signal);
    if (abort.aborted) throw abort.reason;
    throw asUnavailable('WebCodecs AAC-LC support probing failed', cause);
  }
  throwIfAborted(signal);
  if ((typeof support !== 'object' && typeof support !== 'function') || support === null) {
    throw new AacDecoderBackendUnavailableError('WebCodecs returned an invalid AAC support result');
  }
  let supported: unknown;
  try {
    supported = Reflect.get(support, 'supported');
  } catch (cause) {
    const abort = exactAbortReason(signal);
    if (abort.aborted) throw abort.reason;
    throw asUnavailable('WebCodecs AAC support result could not be inspected', cause);
  }
  throwIfAborted(signal);
  if (supported !== true) {
    throw new AacDecoderBackendUnavailableError(
      `WebCodecs does not support ${options.framing.kind} AAC-LC access units`,
    );
  }

  try {
    generation.initialize();
    throwIfAborted(signal);
    return generation;
  } catch (cause) {
    try {
      generation.close();
    } catch {
      // Cleanup is best-effort and must never replace configure/abort failure.
    }
    const abort = exactAbortReason(signal);
    if (abort.aborted) throw abort.reason;
    throw cause;
  }
}
