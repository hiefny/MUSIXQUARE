import { adtsCoreSampleRateHzForIndex } from './adts-header.ts';
import { parseCanonicalAacLcAudioSpecificConfig } from './audio-specific-config.ts';
import type { AacLcAudioSpecificConfigDescription } from './audio-specific-config.ts';
import type { AdtsCoreConfiguration } from './incremental-frame-reader.ts';
import type { AacDecoderBackendId } from './decoder-protocol.ts';

export type { AacDecoderBackendId } from './decoder-protocol.ts';

export const AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES = 1_024;
export const AAC_DECODER_BACKEND_MIN_ACCESS_UNIT_BYTES = 8;
export const AAC_DECODER_BACKEND_MIN_RAW_ACCESS_UNIT_BYTES = 1;
export const AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES = 8_191;
export const AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS = 8;
export const AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES =
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS * AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES;

const GENERATION_OPTION_KEYS = Object.freeze([
  'coreConfiguration',
  'firstAccessUnitOrdinal',
  'framing',
] as const);
const ADTS_FRAMING_KEYS = Object.freeze(['kind'] as const);
const RAW_FRAMING_KEYS = Object.freeze(['kind', 'description'] as const);
const PCM_BATCH_EXPECTATION_KEYS = Object.freeze([
  'firstAccessUnitOrdinal',
  'accessUnitCount',
  'coreConfiguration',
] as const);
const PCM_BATCH_RESULT_KEYS = Object.freeze([
  'firstAccessUnitOrdinal',
  'accessUnitCount',
  'frameCount',
  'sampleRateHz',
  'channels',
  'planes',
] as const satisfies readonly (keyof AacDecoderPcmBatch)[]);
const CORE_CONFIGURATION_KEYS = Object.freeze([
  'mpegId',
  'profile',
  'coreAudioObjectType',
  'sampleRateIndex',
  'channelConfiguration',
  'protectionAbsent',
  'rawDataBlocks',
] as const satisfies readonly (keyof AdtsCoreConfiguration)[]);

export interface AacDecoderBackendGenerationOptions {
  /** Scanner-verified invariant repeated at the decoder boundary. */
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
  /** Absolute ordinal represented by generation-local timestamp zero. */
  readonly firstAccessUnitOrdinal: number;
  /** Exact encoded access-unit framing used for the entire generation. */
  readonly framing: Readonly<AacDecoderBackendFraming>;
}

export type AacDecoderBackendFraming =
  | Readonly<{ readonly kind: 'adts' }>
  | Readonly<{
      readonly kind: 'raw';
      readonly description: AacLcAudioSpecificConfigDescription;
    }>;

export interface AacDecoderAccessUnit {
  readonly accessUnitOrdinal: number;
  /**
   * Caller-owned encoded bytes. A backend must snapshot without mutation and
   * retain neither this view nor its backing buffer after decodeBatch settles.
   */
  readonly bytes: Uint8Array;
}

export type AacDecoderPcmPlanes = readonly [Float32Array] | readonly [Float32Array, Float32Array];

export interface AacDecoderPcmBatch {
  readonly firstAccessUnitOrdinal: number;
  readonly accessUnitCount: number;
  readonly frameCount: number;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  /**
   * Independent caller-owned canonical f32-planar storage. The arrays remain
   * mutable so the caller may append/copy and then zero/release them, or
   * transfer them only when its next boundary explicitly permits ownership
   * transfer. The backend neither retains nor chooses that consumption path.
   */
  readonly planes: AacDecoderPcmPlanes;
}

/** Authoritative geometry used to validate one untrusted backend result. */
export interface AacDecoderPcmBatchExpectation {
  readonly firstAccessUnitOrdinal: number;
  readonly accessUnitCount: number;
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
}

/** One stateful decoder incarnation. Callers create a fresh one for every seek generation. */
export interface AacDecoderBackend {
  readonly id: AacDecoderBackendId;
  readonly coreSampleRateHz: number;
  readonly channels: 1 | 2;
  readonly firstAccessUnitOrdinal: number;
  readonly framing: Readonly<AacDecoderBackendFraming>;
  /**
   * Every batch is internally contiguous and must begin exactly after the
   * preceding successful batch (or at firstAccessUnitOrdinal for batch one).
   * Any rejection, including abort, poisons this generation; subsequent calls
   * reject rather than retrying state whose decoder history is uncertain.
   */
  decodeBatch(
    accessUnits: readonly Readonly<AacDecoderAccessUnit>[],
    signal: AbortSignal,
  ): Promise<Readonly<AacDecoderPcmBatch>>;
  /** Idempotent, best-effort terminal cleanup; native close errors do not escape. */
  close(): void;
}

export class AacDecoderBackendError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AacDecoderBackendError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

export class AacDecoderBackendUnavailableError extends AacDecoderBackendError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AacDecoderBackendUnavailableError';
  }
}

export class AacDecoderBackendIntegrityError extends AacDecoderBackendError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AacDecoderBackendIntegrityError';
  }
}

export class AacDecoderBackendClosedError extends AacDecoderBackendError {
  constructor(message = 'AAC decoder generation is closed') {
    super(message);
    this.name = 'AacDecoderBackendClosedError';
  }
}

const Uint8ArrayIntrinsic = Uint8Array;
const Float32ArrayIntrinsic = Float32Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Float32ArrayIntrinsic.prototype) as
  | object
  | null;
const typedArrayLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get
  : undefined;
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
const float32ArraySet = Float32ArrayIntrinsic.prototype.set;
const float32ArrayFill = Float32ArrayIntrinsic.prototype.fill;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;

type DataRecord = Readonly<Record<string, unknown>>;

function snapshotExactDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): DataRecord {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch (cause) {
    throw new TypeError(`${label} could not be inspected safely`, { cause });
  }
  if (value === null || typeof value !== 'object' || isArray) {
    throw new TypeError(`${label} must be an exact plain data record`);
  }

  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value as object);
    prototype = Reflect.getPrototypeOf(value as object);
  } catch (cause) {
    throw new TypeError(`${label} could not be inspected safely`, { cause });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be an exact plain data record`);
  }

  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }

  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must use enumerable data fields`);
    }
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function requireSafeOrdinal(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function snapshotCoreConfiguration(value: unknown): Readonly<AdtsCoreConfiguration> {
  const record = snapshotExactDataRecord(value, CORE_CONFIGURATION_KEYS, 'AAC core configuration');
  if (
    record.mpegId !== 0 ||
    record.profile !== 1 ||
    record.coreAudioObjectType !== 2 ||
    record.protectionAbsent !== true ||
    record.rawDataBlocks !== 1
  ) {
    throw new RangeError(
      'AAC backend requires canonical MPEG-4 AAC-LC core geometry without CRC and one RDB',
    );
  }
  try {
    adtsCoreSampleRateHzForIndex(record.sampleRateIndex);
  } catch (cause) {
    throw new RangeError('AAC core sample-rate index is invalid', { cause });
  }
  if (record.channelConfiguration !== 1 && record.channelConfiguration !== 2) {
    throw new RangeError('AAC backend supports exact mono or stereo core geometry');
  }
  return Object.freeze({ ...record }) as unknown as Readonly<AdtsCoreConfiguration>;
}

function snapshotDescriptionTuple(value: unknown): Uint8Array {
  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    if (!isArray) throw new TypeError('description is not an Array');
    descriptors = Object.getOwnPropertyDescriptors(value as object);
    prototype = Reflect.getPrototypeOf(value as object);
  } catch (cause) {
    throw new TypeError('AAC raw framing description could not be inspected safely', { cause });
  }
  if (prototype !== Array.prototype) {
    throw new TypeError('AAC raw framing description must be an exact Array tuple');
  }
  const actualKeys = Reflect.ownKeys(descriptors);
  const length = descriptors.length;
  const tupleLength = length && Object.hasOwn(length, 'value') ? length.value : undefined;
  if (
    (tupleLength !== 2 && tupleLength !== 5) ||
    actualKeys.length !== tupleLength + 1 ||
    !actualKeys.includes('length') ||
    Array.from({ length: tupleLength }, (_unused, index) => String(index)).some(
      (key) => !actualKeys.includes(key),
    )
  ) {
    throw new TypeError(
      'AAC raw framing description must contain an exact canonical 2- or 5-byte tuple',
    );
  }

  const bytes = new Uint8ArrayIntrinsic(tupleLength);
  for (let index = 0; index < tupleLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('AAC raw framing description must use enumerable data elements');
    }
    const element = descriptor.value;
    if (
      typeof element !== 'number' ||
      !Number.isSafeInteger(element) ||
      Object.is(element, -0) ||
      element < 0 ||
      element > 0xff
    ) {
      throw new RangeError('AAC raw framing description elements must be bytes');
    }
    bytes[index] = element;
  }
  return bytes;
}

export function snapshotAacDecoderBackendFraming(
  value: unknown,
  coreConfigurationValue: unknown,
): Readonly<AacDecoderBackendFraming> {
  const coreConfiguration = snapshotCoreConfiguration(coreConfigurationValue);
  let kind: unknown;
  try {
    const descriptor =
      value !== null && (typeof value === 'object' || typeof value === 'function')
        ? Reflect.getOwnPropertyDescriptor(value, 'kind')
        : undefined;
    kind =
      descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
        ? descriptor.value
        : undefined;
  } catch (cause) {
    throw new TypeError('AAC decoder framing could not be inspected safely', { cause });
  }
  if (kind === 'adts') {
    snapshotExactDataRecord(value, ADTS_FRAMING_KEYS, 'AAC ADTS framing');
    return Object.freeze({ kind: 'adts' });
  }
  if (kind !== 'raw') {
    throw new TypeError('AAC decoder framing kind must be exact ADTS or raw');
  }

  const record = snapshotExactDataRecord(value, RAW_FRAMING_KEYS, 'AAC raw framing');
  const parsed = parseCanonicalAacLcAudioSpecificConfig(
    snapshotDescriptionTuple(record.description),
  );
  if (
    parsed.audioObjectType !== coreConfiguration.coreAudioObjectType ||
    parsed.sampleRateIndex !== coreConfiguration.sampleRateIndex ||
    parsed.channelConfiguration !== coreConfiguration.channelConfiguration
  ) {
    throw new RangeError(
      'AAC raw framing description does not match its generation core configuration',
    );
  }
  return Object.freeze({
    kind: 'raw',
    description: parsed.description,
  });
}

/** Snapshot a fresh-generation contract before any native decoder allocation. */
export function snapshotAacDecoderBackendGenerationOptions(
  value: unknown,
): Readonly<AacDecoderBackendGenerationOptions> {
  const record = snapshotExactDataRecord(
    value,
    GENERATION_OPTION_KEYS,
    'AAC decoder generation options',
  );
  const coreConfiguration = snapshotCoreConfiguration(record.coreConfiguration);
  return Object.freeze({
    coreConfiguration,
    firstAccessUnitOrdinal: requireSafeOrdinal(
      record.firstAccessUnitOrdinal,
      'AAC first access-unit ordinal',
    ),
    framing: snapshotAacDecoderBackendFraming(record.framing, coreConfiguration),
  });
}

export function aacCoreSampleRateHz(configuration: Readonly<AdtsCoreConfiguration>): number {
  const verified = snapshotCoreConfiguration(configuration);
  return adtsCoreSampleRateHzForIndex(verified.sampleRateIndex);
}

/**
 * Map an absolute AU ordinal to generation-local integer microseconds.
 *
 * BigInt arithmetic avoids floating-point drift at 44.1 kHz and cancellation
 * when a fresh generation begins near Number.MAX_SAFE_INTEGER. Flooring is the
 * canonical WebCodecs timestamp rule used by both chunk creation and tests.
 */
export function aacGenerationTimestampMicroseconds(
  accessUnitOrdinal: number,
  firstAccessUnitOrdinal: number,
  coreSampleRateHz: number,
): number {
  const ordinal = requireSafeOrdinal(accessUnitOrdinal, 'AAC access-unit ordinal');
  const first = requireSafeOrdinal(firstAccessUnitOrdinal, 'AAC first access-unit ordinal');
  if (ordinal < first) {
    throw new RangeError('AAC access-unit ordinal precedes its decoder generation');
  }
  if (
    !Number.isSafeInteger(coreSampleRateHz) ||
    Object.is(coreSampleRateHz, -0) ||
    coreSampleRateHz <= 0
  ) {
    throw new RangeError('AAC core sample rate must be a positive safe integer');
  }

  const delta = BigInt(ordinal) - BigInt(first);
  const timestamp =
    (delta * BigInt(AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES) * 1_000_000n) /
    BigInt(coreSampleRateHz);
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('AAC generation-local timestamp exceeds the safe-integer range');
  }
  return Number(timestamp);
}

interface VerifiedPcmBatchExpectation {
  readonly firstAccessUnitOrdinal: number;
  readonly accessUnitCount: number;
  readonly frameCount: number;
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
}

function requireAbortSignal(value: unknown): AbortSignal {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    typeof trustedAbortAborted !== 'function'
  ) {
    throw new TypeError('AAC decoder PCM snapshot requires an exact AbortSignal');
  }
  try {
    Reflect.apply(trustedAbortAborted, value, []);
  } catch (cause) {
    throw new TypeError('AAC decoder PCM snapshot requires an exact AbortSignal', { cause });
  }
  return value as AbortSignal;
}

function exactAbortState(signal: AbortSignal): {
  readonly aborted: boolean;
  readonly reason: unknown;
} {
  let aborted: unknown;
  try {
    aborted = Reflect.apply(trustedAbortAborted!, signal, []);
  } catch (cause) {
    return Object.freeze({ aborted: true, reason: cause });
  }
  if (aborted !== true) return Object.freeze({ aborted: false, reason: undefined });

  let reason: unknown;
  try {
    reason =
      typeof trustedAbortReason === 'function'
        ? Reflect.apply(trustedAbortReason, signal, [])
        : undefined;
  } catch (cause) {
    reason = cause;
  }
  return Object.freeze({
    aborted: true,
    reason:
      reason === undefined
        ? new DOMException('The AAC decoder PCM snapshot was aborted', 'AbortError')
        : reason,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (typeof trustedAbortThrowIfAborted === 'function') {
    Reflect.apply(trustedAbortThrowIfAborted, signal, []);
    return;
  }
  const state = exactAbortState(signal);
  if (state.aborted) throw state.reason;
}

function snapshotPcmBatchExpectation(value: unknown): VerifiedPcmBatchExpectation {
  const record = snapshotExactDataRecord(
    value,
    PCM_BATCH_EXPECTATION_KEYS,
    'AAC decoder PCM batch expectation',
  );
  const firstAccessUnitOrdinal = requireSafeOrdinal(
    record.firstAccessUnitOrdinal,
    'AAC PCM batch first access-unit ordinal',
  );
  if (
    typeof record.accessUnitCount !== 'number' ||
    !Number.isSafeInteger(record.accessUnitCount) ||
    Object.is(record.accessUnitCount, -0) ||
    record.accessUnitCount < 1 ||
    record.accessUnitCount > AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS
  ) {
    throw new RangeError(
      `AAC PCM batch expectation must contain 1 through ${AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS} access units`,
    );
  }
  if (firstAccessUnitOrdinal > Number.MAX_SAFE_INTEGER - (record.accessUnitCount - 1)) {
    throw new RangeError('AAC PCM batch expectation exceeds the safe access-unit ordinal range');
  }
  const coreConfiguration = snapshotCoreConfiguration(record.coreConfiguration);
  return Object.freeze({
    firstAccessUnitOrdinal,
    accessUnitCount: record.accessUnitCount,
    frameCount: record.accessUnitCount * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
    coreConfiguration,
    sampleRateHz: adtsCoreSampleRateHzForIndex(coreConfiguration.sampleRateIndex),
    channels: coreConfiguration.channelConfiguration,
  });
}

function snapshotPcmBatchResultRecord(value: unknown): DataRecord {
  try {
    return snapshotExactDataRecord(value, PCM_BATCH_RESULT_KEYS, 'AAC decoder PCM batch result');
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      'AAC decoder returned a non-canonical PCM batch record',
      cause,
    );
  }
}

function snapshotPlaneValues(value: unknown, channels: 1 | 2): readonly unknown[] {
  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    if (!isArray) {
      throw new TypeError('PCM planes are not an Array');
    }
    const planes = value as unknown[];
    descriptors = Object.getOwnPropertyDescriptors(planes) as unknown as PropertyDescriptorMap;
    prototype = Reflect.getPrototypeOf(planes);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      'AAC decoder PCM planes could not be inspected safely',
      cause,
    );
  }
  if (prototype !== Array.prototype) {
    throw new AacDecoderBackendIntegrityError('AAC decoder PCM planes must be an exact Array');
  }

  const expectedKeys = Array.from({ length: channels }, (_unused, index) => String(index));
  expectedKeys.push('length');
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new AacDecoderBackendIntegrityError(
      'AAC decoder PCM planes must be exact, dense, and free of extra fields',
    );
  }
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== channels
  ) {
    throw new AacDecoderBackendIntegrityError(
      'AAC decoder PCM plane count does not match its core channels',
    );
  }

  const values: unknown[] = [];
  for (let index = 0; index < channels; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new AacDecoderBackendIntegrityError(
        'AAC decoder PCM planes must use dense enumerable data elements',
      );
    }
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}

function clearOwnedPlanes(planes: readonly Float32Array[]): void {
  for (const plane of planes) {
    try {
      Reflect.apply(float32ArrayFill, plane, [0]);
    } catch {
      // Cleanup is best-effort and must not replace integrity or abort failure.
    }
  }
}

function copyFiniteFloat32Plane(value: unknown, frames: number, label: string): Float32Array {
  if (
    typeof typedArrayLengthGetter !== 'function' ||
    typeof typedArrayByteLengthGetter !== 'function' ||
    typeof typedArrayBufferGetter !== 'function' ||
    typeof typedArrayTagGetter !== 'function' ||
    typeof arrayBufferByteLengthGetter !== 'function'
  ) {
    throw new AacDecoderBackendIntegrityError('Float32 PCM runtime intrinsics are unavailable');
  }

  let isView: boolean;
  let length: number;
  let byteLength: number;
  try {
    isView = arrayBufferIsView(value);
    if (!isView || Reflect.apply(typedArrayTagGetter, value, []) !== 'Float32Array') {
      throw new TypeError(`${label} is not Float32Array storage`);
    }
    length = Reflect.apply(typedArrayLengthGetter, value, []) as number;
    byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []);
    // The ArrayBuffer intrinsic rejects SharedArrayBuffer. Detached views have
    // zero internal length and fail the exact geometry check below.
    Reflect.apply(arrayBufferByteLengthGetter, buffer, []);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      `${label} must use readable, non-shared Float32Array storage`,
      cause,
    );
  }
  if (length !== frames || byteLength !== frames * Float32ArrayIntrinsic.BYTES_PER_ELEMENT) {
    throw new AacDecoderBackendIntegrityError(
      `${label} must contain exactly ${frames} Float32 frames`,
    );
  }

  let owned: Float32Array;
  try {
    owned = new Float32ArrayIntrinsic(frames);
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      `${label} could not allocate its bounded canonical copy`,
      cause,
    );
  }
  try {
    Reflect.apply(float32ArraySet, owned, [value, 0]);
    for (let index = 0; index < frames; index += 1) {
      if (!Number.isFinite(owned[index])) {
        throw new AacDecoderBackendIntegrityError(
          `${label} contains non-finite PCM at frame ${index}`,
        );
      }
    }
    return owned;
  } catch (cause) {
    clearOwnedPlanes([owned]);
    if (cause instanceof AacDecoderBackendIntegrityError) throw cause;
    throw new AacDecoderBackendIntegrityError(`${label} could not be copied safely`, cause);
  }
}

/**
 * Validate and deeply detach one backend batch before it reaches PCM output.
 *
 * The copy is bounded to eight AAC-LC access units (64 KiB at stereo) and the
 * returned Float32Array buffers are owned solely by this snapshot. The outer
 * record and plane tuple are frozen; plane storage remains transferable.
 */
export function snapshotAacDecoderPcmBatch(
  value: unknown,
  expectationValue: unknown,
  signalValue: AbortSignal,
): Readonly<AacDecoderPcmBatch> {
  const signal = requireAbortSignal(signalValue);
  const ownedPlanes: Float32Array[] = [];
  try {
    throwIfAborted(signal);
    const expectation = snapshotPcmBatchExpectation(expectationValue);
    throwIfAborted(signal);
    const record = snapshotPcmBatchResultRecord(value);
    throwIfAborted(signal);
    if (
      !Object.is(record.firstAccessUnitOrdinal, expectation.firstAccessUnitOrdinal) ||
      !Object.is(record.accessUnitCount, expectation.accessUnitCount) ||
      !Object.is(record.frameCount, expectation.frameCount) ||
      !Object.is(record.sampleRateHz, expectation.sampleRateHz) ||
      !Object.is(record.channels, expectation.channels)
    ) {
      throw new AacDecoderBackendIntegrityError(
        'AAC decoder PCM batch geometry contradicts its requested access units',
      );
    }

    const planeValues = snapshotPlaneValues(record.planes, expectation.channels);
    throwIfAborted(signal);
    for (let index = 0; index < expectation.channels; index += 1) {
      ownedPlanes.push(
        copyFiniteFloat32Plane(
          planeValues[index],
          expectation.frameCount,
          `AAC decoder PCM plane ${index}`,
        ),
      );
      throwIfAborted(signal);
    }

    const planes = Object.freeze([...ownedPlanes]) as unknown as AacDecoderPcmPlanes;
    const result: Readonly<AacDecoderPcmBatch> = Object.freeze({
      firstAccessUnitOrdinal: expectation.firstAccessUnitOrdinal,
      accessUnitCount: expectation.accessUnitCount,
      frameCount: expectation.frameCount,
      sampleRateHz: expectation.sampleRateHz,
      channels: expectation.channels,
      planes,
    });
    throwIfAborted(signal);
    return result;
  } catch (cause) {
    clearOwnedPlanes(ownedPlanes);
    const abort = exactAbortState(signal);
    if (abort.aborted) throw abort.reason;
    throw cause;
  }
}
