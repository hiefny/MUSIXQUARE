import { adtsCoreSampleRateHzForIndex, type AdtsSampleRateIndex } from './adts-header.ts';

export const AAC_LC_ASC_CORE_FRAMES_PER_ACCESS_UNIT = 1_024;

export type AacLcAscChannelConfiguration = 1 | 2;
export type AacLcAudioSpecificConfigDescription =
  | readonly [number, number]
  | readonly [number, number, number, number, number];

/**
 * Common FFmpeg/iTunes AAC-LC files append this exact sync extension. It says
 * extension AOT 5 is understood but SBR is absent; the final seven bits are
 * byte-alignment padding. This is not an HE-AAC signal.
 */
const AAC_LC_NO_SBR_SYNC_EXTENSION = Object.freeze([0x56, 0xe5, 0x00] as const);

/**
 * The initial M4A admission contract: direct MPEG-4 AAC-LC, indexed rate,
 * mono/stereo channel configuration, and the canonical 1,024-frame GASpecificConfig.
 */
export interface CanonicalAacLcAudioSpecificConfig {
  readonly audioObjectType: 2;
  readonly sampleRateIndex: AdtsSampleRateIndex;
  readonly sampleRateHz: number;
  readonly channelConfiguration: AacLcAscChannelConfiguration;
  readonly channelCount: AacLcAscChannelConfiguration;
  readonly coreFramesPerAccessUnit: typeof AAC_LC_ASC_CORE_FRAMES_PER_ACCESS_UNIT;
  readonly frameLengthFlag: 0;
  readonly dependsOnCoreCoder: 0;
  readonly extensionFlag: 0;
  /** Immutable numeric representation; obtain transferable bytes with the helper below. */
  readonly description: AacLcAudioSpecificConfigDescription;
}

const CANONICAL_KEYS = Object.freeze([
  'audioObjectType',
  'sampleRateIndex',
  'sampleRateHz',
  'channelConfiguration',
  'channelCount',
  'coreFramesPerAccessUnit',
  'frameLengthFlag',
  'dependsOnCoreCoder',
  'extensionFlag',
  'description',
] as const satisfies readonly (keyof CanonicalAacLcAudioSpecificConfig)[]);

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

type DataRecord = Readonly<Record<string, unknown>>;

/** Snapshot one admitted ASC without consulting caller-controlled properties or iterators. */
function snapshotDescriptionBytes(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value) ||
    typedArrayTagGetter.call(value) !== 'Uint8Array'
  ) {
    throw new TypeError('AAC AudioSpecificConfig must be a Uint8Array');
  }

  let byteLength: number;
  try {
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // Shared storage can change concurrently, so it cannot yield one coherent
    // configuration snapshot. The ArrayBuffer intrinsic rejects SAB receivers.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (cause) {
    throw new TypeError('AAC AudioSpecificConfig must be a readable non-shared Uint8Array', {
      cause,
    });
  }
  if (byteLength !== 2 && byteLength !== 5) {
    throw new RangeError(
      'Canonical AAC AudioSpecificConfig must contain exactly two or five bytes',
    );
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (cause) {
    throw new TypeError('AAC AudioSpecificConfig bytes could not be copied', { cause });
  }
  return owned;
}

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

function snapshotDescriptionTuple(value: unknown): Uint8Array {
  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value as object);
    prototype = Reflect.getPrototypeOf(value as object);
  } catch (cause) {
    throw new TypeError('AAC canonical description could not be inspected safely', { cause });
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new TypeError('AAC canonical description must be an exact numeric tuple');
  }

  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    (length !== 2 && length !== 5)
  ) {
    throw new TypeError('AAC canonical description must contain exactly two or five elements');
  }
  const expectedKeys = Array.from({ length }, (_unused, index) => String(index));
  expectedKeys.push('length');
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError('AAC canonical description must be an exact dense tuple');
  }

  const bytes = new Uint8ArrayIntrinsic(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    const element = descriptor?.value;
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof element !== 'number' ||
      !Number.isSafeInteger(element) ||
      element < 0 ||
      element > 0xff
    ) {
      throw new RangeError('AAC canonical description elements must be byte data values');
    }
    bytes[index] = element;
  }
  return bytes;
}

/** Parse an exact canonical AAC-LC AudioSpecificConfig admitted by the M4A engine. */
export function parseCanonicalAacLcAudioSpecificConfig(
  input: unknown,
): Readonly<CanonicalAacLcAudioSpecificConfig> {
  const bytes = snapshotDescriptionBytes(input);
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const audioObjectType = first >>> 3;

  if (audioObjectType !== 2) {
    if (audioObjectType === 5 || audioObjectType === 29) {
      throw new RangeError('AAC SBR or Parametric Stereo AudioSpecificConfig is not supported');
    }
    throw new RangeError('AAC AudioSpecificConfig must use direct Audio Object Type 2 AAC-LC');
  }

  const sampleRateIndex = ((first & 0b111) << 1) | (second >>> 7);
  if (sampleRateIndex === 15) {
    throw new RangeError('AAC explicit sampling frequency is not supported');
  }
  let sampleRateHz: number;
  try {
    sampleRateHz = adtsCoreSampleRateHzForIndex(sampleRateIndex);
  } catch (cause) {
    throw new RangeError('AAC AudioSpecificConfig sample-rate index is reserved', { cause });
  }

  const channelConfiguration = (second >>> 3) & 0b1111;
  if (channelConfiguration === 0) {
    throw new RangeError('AAC Program Config Element channel geometry is not supported');
  }
  if (channelConfiguration !== 1 && channelConfiguration !== 2) {
    throw new RangeError('AAC AudioSpecificConfig supports exact mono or stereo geometry');
  }

  const frameLengthFlag = (second >>> 2) & 1;
  const dependsOnCoreCoder = (second >>> 1) & 1;
  const extensionFlag = second & 1;
  if (frameLengthFlag !== 0) {
    throw new RangeError('AAC 960-frame GASpecificConfig is not supported');
  }
  if (dependsOnCoreCoder !== 0) {
    throw new RangeError('AAC core-coder dependency is not supported');
  }
  if (extensionFlag !== 0) {
    throw new RangeError('AAC GASpecificConfig extensions are not supported');
  }

  if (bytes.byteLength === 5) {
    for (let index = 0; index < AAC_LC_NO_SBR_SYNC_EXTENSION.length; index += 1) {
      if (bytes[index + 2] !== AAC_LC_NO_SBR_SYNC_EXTENSION[index]) {
        throw new RangeError(
          'AAC sync extension must be the canonical no-SBR Audio Object Type 5 signal',
        );
      }
    }
  }

  const description = Object.freeze(Array.from(bytes)) as AacLcAudioSpecificConfigDescription;
  return Object.freeze({
    audioObjectType: 2,
    sampleRateIndex: sampleRateIndex as AdtsSampleRateIndex,
    sampleRateHz,
    channelConfiguration,
    channelCount: channelConfiguration,
    coreFramesPerAccessUnit: AAC_LC_ASC_CORE_FRAMES_PER_ACCESS_UNIT,
    frameLengthFlag: 0,
    dependsOnCoreCoder: 0,
    extensionFlag: 0,
    description,
  });
}

/**
 * Revalidate an exact canonical record and return fresh caller-owned bytes.
 * No mutable typed-array storage is retained by the canonical configuration.
 */
export function createAacLcAudioSpecificConfigDescription(value: unknown): Uint8Array {
  const record = snapshotExactDataRecord(
    value,
    CANONICAL_KEYS,
    'Canonical AAC AudioSpecificConfig',
  );
  const bytes = snapshotDescriptionTuple(record.description);
  const reparsed = parseCanonicalAacLcAudioSpecificConfig(bytes);

  for (const key of CANONICAL_KEYS) {
    if (key !== 'description' && !Object.is(record[key], reparsed[key])) {
      throw new RangeError(`Canonical AAC AudioSpecificConfig ${key} does not match its bytes`);
    }
  }
  return bytes;
}
