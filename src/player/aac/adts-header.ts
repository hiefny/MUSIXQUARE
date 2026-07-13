export type AdtsMpegId = 0 | 1;

export type AdtsMpegVersion = 'MPEG-4' | 'MPEG-2';

export type AdtsProfile = 0 | 1 | 2 | 3;

export type AacAudioObjectType = 1 | 2 | 3 | 4;

export type AdtsProfileName =
  | 'main'
  | 'low-complexity'
  | 'scalable-sample-rate'
  | 'long-term-prediction';

export type AdtsSampleRateIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type AdtsChannelConfiguration = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type AdtsCoreChannelCount = 1 | 2 | 3 | 4 | 5 | 6 | 8;

export type AdtsCoreChannelLayout =
  | 'mono'
  | 'stereo'
  | '3.0-front'
  | '4.0-back-center'
  | '5.0-back'
  | '5.1-back'
  | '7.1-wide-back';

export interface AdtsHeader {
  readonly mpegId: AdtsMpegId;
  readonly mpegVersion: AdtsMpegVersion;
  readonly layer: 0;
  readonly protectionAbsent: boolean;
  readonly hasCrc: boolean;
  /** The transmitted big-endian CRC check, or null when protection is absent. */
  readonly crcCheck: number | null;
  /** The two-bit ADTS profile_ObjectType value. */
  readonly profile: AdtsProfile;
  /**
   * The core Audio Object Type represented by profile + 1. This header field
   * alone does not exclude implicit SBR/PS signaled inside the AAC payload.
   */
  readonly coreAudioObjectType: AacAudioObjectType;
  readonly profileName: AdtsProfileName;
  readonly sampleRateIndex: AdtsSampleRateIndex;
  /** Core rate from the header; an SBR payload may decode at a different output rate. */
  readonly coreSampleRateHz: number;
  readonly privateBit: boolean;
  readonly channelConfiguration: AdtsChannelConfiguration;
  /** Core geometry; implicit PS may decode to a different output geometry. */
  readonly coreChannelCount: AdtsCoreChannelCount;
  readonly coreChannelLayout: AdtsCoreChannelLayout;
  readonly originalCopy: boolean;
  readonly home: boolean;
  readonly copyrightIdentificationBit: boolean;
  readonly copyrightIdentificationStart: boolean;
  readonly frameLengthBytes: number;
  readonly headerLengthBytes: 7 | 9;
  readonly payloadLengthBytes: number;
  /** The raw 11-bit value; 0x7ff is the ADTS variable-bitrate sentinel. */
  readonly bufferFullness: number;
  /** Actual raw_data_block count. This engine admits exactly one per ADTS frame. */
  readonly rawDataBlocks: 1;
}

export class AdtsHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdtsHeaderError';
  }
}

export class UnsupportedAdtsProgramConfigElementError extends AdtsHeaderError {
  constructor() {
    super('ADTS channel_configuration 0 requires an in-band Program Config Element');
    this.name = 'UnsupportedAdtsProgramConfigElementError';
  }
}

export class UnsupportedAdtsRawDataBlocksError extends AdtsHeaderError {
  readonly rawDataBlocks: number;

  constructor(rawDataBlocks: number) {
    super(`ADTS frames with ${rawDataBlocks} raw_data_blocks are not supported`);
    this.name = 'UnsupportedAdtsRawDataBlocksError';
    this.rawDataBlocks = rawDataBlocks;
  }
}

const SAMPLE_RATES_HZ = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
] as const;

const PROFILE_NAMES = [
  'main',
  'low-complexity',
  'scalable-sample-rate',
  'long-term-prediction',
] as const;

interface ChannelGeometry {
  readonly count: AdtsCoreChannelCount;
  readonly layout: AdtsCoreChannelLayout;
}

const CHANNEL_GEOMETRIES: ReadonlyArray<ChannelGeometry | null> = Object.freeze([
  null,
  Object.freeze({ count: 1, layout: 'mono' }),
  Object.freeze({ count: 2, layout: 'stereo' }),
  Object.freeze({ count: 3, layout: '3.0-front' }),
  Object.freeze({ count: 4, layout: '4.0-back-center' }),
  Object.freeze({ count: 5, layout: '5.0-back' }),
  Object.freeze({ count: 6, layout: '5.1-back' }),
  Object.freeze({ count: 8, layout: '7.1-wide-back' }),
]);

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

/** Copy an exact header without consulting caller-controlled properties or iterators. */
function snapshotHeaderBytes(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value) ||
    typedArrayTagGetter.call(value) !== 'Uint8Array'
  ) {
    throw new TypeError('ADTS header must be a Uint8Array');
  }

  let byteLength: number;
  try {
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // An ArrayBuffer cannot change from another agent while it is copied.
    // Reject SharedArrayBuffer views because copying one is not a coherent
    // snapshot: concurrent writes could synthesize a header that never
    // existed as a whole in the caller's storage.
    arrayBufferByteLengthGetter.call(buffer);
  } catch {
    throw new TypeError('ADTS header must be a readable non-shared Uint8Array');
  }
  if (byteLength !== 7 && byteLength !== 9) {
    throw new RangeError('ADTS header must contain exactly 7 or 9 bytes');
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new TypeError('ADTS header bytes could not be copied', { cause: error });
  }
  return owned;
}

function readProfile(mpegId: AdtsMpegId, value: number): AdtsProfile {
  if (value < 0 || value > 3 || !Number.isSafeInteger(value)) {
    throw new AdtsHeaderError('ADTS profile is invalid');
  }
  if (mpegId === 1 && value === 3) {
    throw new AdtsHeaderError('MPEG-2 ADTS profile value 3 is reserved');
  }
  return value as AdtsProfile;
}

function readSampleRateIndex(value: number): AdtsSampleRateIndex {
  if (value >= SAMPLE_RATES_HZ.length) {
    throw new AdtsHeaderError('ADTS header uses a reserved or forbidden sample-rate index');
  }
  return value as AdtsSampleRateIndex;
}

function readChannelConfiguration(value: number): {
  readonly configuration: AdtsChannelConfiguration;
  readonly geometry: ChannelGeometry;
} {
  if (value === 0) throw new UnsupportedAdtsProgramConfigElementError();
  const geometry = CHANNEL_GEOMETRIES[value];
  if (!geometry) throw new AdtsHeaderError('ADTS channel_configuration is invalid');
  return Object.freeze({
    configuration: value as AdtsChannelConfiguration,
    geometry,
  });
}

/** Parse one complete, byte-aligned ADTS fixed + variable header. */
export function parseAdtsHeader(input: Uint8Array): AdtsHeader {
  const bytes = snapshotHeaderBytes(input);
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;
  const fifth = bytes[4] ?? 0;
  const sixth = bytes[5] ?? 0;
  const seventh = bytes[6] ?? 0;

  if (first !== 0xff || (second & 0xf0) !== 0xf0) {
    throw new AdtsHeaderError('ADTS syncword is invalid');
  }

  const mpegId = ((second >>> 3) & 1) as AdtsMpegId;
  const layer = (second >>> 1) & 0b11;
  if (layer !== 0) throw new AdtsHeaderError('ADTS layer must be zero');

  const protectionAbsent = (second & 1) === 1;
  const headerLengthBytes: 7 | 9 = protectionAbsent ? 7 : 9;
  if (bytes.byteLength !== headerLengthBytes) {
    throw new RangeError(
      protectionAbsent
        ? 'ADTS header without CRC must contain exactly 7 bytes'
        : 'ADTS CRC header is truncated and must contain exactly 9 bytes',
    );
  }

  const profile = readProfile(mpegId, third >>> 6);
  const coreAudioObjectType = (profile + 1) as AacAudioObjectType;
  const profileName = PROFILE_NAMES[profile];
  const sampleRateIndex = readSampleRateIndex((third >>> 2) & 0b1111);
  const coreSampleRateHz = SAMPLE_RATES_HZ[sampleRateIndex];
  const privateBit = ((third >>> 1) & 1) === 1;
  const channel = readChannelConfiguration(((third & 1) << 2) | (fourth >>> 6));

  const originalCopy = ((fourth >>> 5) & 1) === 1;
  const home = ((fourth >>> 4) & 1) === 1;
  const copyrightIdentificationBit = ((fourth >>> 3) & 1) === 1;
  const copyrightIdentificationStart = ((fourth >>> 2) & 1) === 1;
  const frameLengthBytes = ((fourth & 0b11) << 11) | (fifth << 3) | (sixth >>> 5);
  const payloadLengthBytes = frameLengthBytes - headerLengthBytes;
  if (
    !Number.isSafeInteger(frameLengthBytes) ||
    !Number.isSafeInteger(payloadLengthBytes) ||
    payloadLengthBytes < 1
  ) {
    throw new AdtsHeaderError('ADTS frame length cannot contain its header and AAC payload');
  }

  const bufferFullness = ((sixth & 0b11111) << 6) | (seventh >>> 2);
  const rawDataBlocks = (seventh & 0b11) + 1;
  if (rawDataBlocks !== 1) throw new UnsupportedAdtsRawDataBlocksError(rawDataBlocks);

  const crcCheck = protectionAbsent ? null : ((bytes[7] ?? 0) << 8) | (bytes[8] ?? 0);

  return Object.freeze({
    mpegId,
    mpegVersion: mpegId === 0 ? 'MPEG-4' : 'MPEG-2',
    layer: 0,
    protectionAbsent,
    hasCrc: !protectionAbsent,
    crcCheck,
    profile,
    coreAudioObjectType,
    profileName,
    sampleRateIndex,
    coreSampleRateHz,
    privateBit,
    channelConfiguration: channel.configuration,
    coreChannelCount: channel.geometry.count,
    coreChannelLayout: channel.geometry.layout,
    originalCopy,
    home,
    copyrightIdentificationBit,
    copyrightIdentificationStart,
    frameLengthBytes,
    headerLengthBytes,
    payloadLengthBytes,
    bufferFullness,
    rawDataBlocks: 1,
  });
}
