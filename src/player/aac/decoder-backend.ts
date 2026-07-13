import { adtsCoreSampleRateHzForIndex } from './adts-header.ts';
import type { AdtsCoreConfiguration } from './incremental-frame-reader.ts';
import type { AacDecoderBackendId } from './decoder-protocol.ts';

export type { AacDecoderBackendId } from './decoder-protocol.ts';

export const AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES = 1_024;
export const AAC_DECODER_BACKEND_MIN_ACCESS_UNIT_BYTES = 8;
export const AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES = 8_191;
export const AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS = 8;
export const AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES =
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS * AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES;

const GENERATION_OPTION_KEYS = Object.freeze([
  'coreConfiguration',
  'firstAccessUnitOrdinal',
] as const);
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
}

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

/** One stateful decoder incarnation. Callers create a fresh one for every seek generation. */
export interface AacDecoderBackend {
  readonly id: AacDecoderBackendId;
  readonly coreSampleRateHz: number;
  readonly channels: 1 | 2;
  readonly firstAccessUnitOrdinal: number;
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
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
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
    throw new RangeError('AAC backend requires raw MPEG-4 ADTS AAC-LC without CRC and one RDB');
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

/** Snapshot a fresh-generation contract before any native decoder allocation. */
export function snapshotAacDecoderBackendGenerationOptions(
  value: unknown,
): Readonly<AacDecoderBackendGenerationOptions> {
  const record = snapshotExactDataRecord(
    value,
    GENERATION_OPTION_KEYS,
    'AAC decoder generation options',
  );
  return Object.freeze({
    coreConfiguration: snapshotCoreConfiguration(record.coreConfiguration),
    firstAccessUnitOrdinal: requireSafeOrdinal(
      record.firstAccessUnitOrdinal,
      'AAC first access-unit ordinal',
    ),
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
