import { createMp3SampleTimeline } from '../mp3/timeline.ts';

/**
 * Canonical, bounded timeline evidence for codecs whose container does not
 * provide an exact random-access timeline.
 *
 * The format is deliberately fixed-width and big-endian. It is suitable for a
 * small sidecar range in front of encoded media, but this module owns only the
 * pure codec: it does not select a transport or trust a manifest producer.
 */

export const CODEC_TIMELINE_MANIFEST_VERSION = 1 as const;
export const CODEC_TIMELINE_MANIFEST_HEADER_BYTES = 128;
export const CODEC_TIMELINE_MANIFEST_MAX_BYTES = 256 * 1_024;
export const CODEC_TIMELINE_MANIFEST_MAX_POINTS = 8_192;
export const CODEC_TIMELINE_MANIFEST_SOURCE_BINDING_BYTES = 32;
export const ADTS_AAC_LC_TIMELINE_POINT_BYTES = 16;
export const MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES = 24;

const MAGIC = Object.freeze([0x4d, 0x58, 0x51, 0x52, 0x43, 0x54, 0x4d, 0x31] as const);
const CODEC_ADTS_AAC_LC = 1;
const CODEC_MP3_NO_FRAME_COUNT = 2;

const OFFSET_VERSION = 8;
const OFFSET_CODEC = 10;
const OFFSET_FLAGS = 11;
const OFFSET_HEADER_BYTES = 12;
const OFFSET_RECORD_BYTES = 14;
const OFFSET_POINT_COUNT = 16;
const OFFSET_COMMON_RESERVED = 20;
const OFFSET_SOURCE_BINDING = 24;
const OFFSET_SOURCE_SIZE = 56;
const OFFSET_AUDIO_START = 64;
const OFFSET_AUDIO_END = 72;
const OFFSET_FRAME_COUNT = 80;
const OFFSET_SAMPLE_RATE = 88;
const OFFSET_SAMPLES_PER_FRAME = 92;
const OFFSET_CHANNELS = 94;
const OFFSET_COMMON_RESERVED_BYTE = 95;
const OFFSET_CODEC_CONFIGURATION = 96;

const ADTS_MPEG_ID_OFFSET = OFFSET_CODEC_CONFIGURATION;
const ADTS_PROFILE_OFFSET = OFFSET_CODEC_CONFIGURATION + 1;
const ADTS_AUDIO_OBJECT_TYPE_OFFSET = OFFSET_CODEC_CONFIGURATION + 2;
const ADTS_SAMPLE_RATE_INDEX_OFFSET = OFFSET_CODEC_CONFIGURATION + 3;
const ADTS_CHANNEL_CONFIGURATION_OFFSET = OFFSET_CODEC_CONFIGURATION + 4;
const ADTS_PROTECTION_ABSENT_OFFSET = OFFSET_CODEC_CONFIGURATION + 5;
const ADTS_RAW_DATA_BLOCKS_OFFSET = OFFSET_CODEC_CONFIGURATION + 6;
const ADTS_RESERVED_START = OFFSET_CODEC_CONFIGURATION + 7;

const MP3_MPEG_VERSION_OFFSET = OFFSET_CODEC_CONFIGURATION;
const MP3_LAYER_OFFSET = OFFSET_CODEC_CONFIGURATION + 1;
const MP3_NO_FRAME_COUNT_OFFSET = OFFSET_CODEC_CONFIGURATION + 2;
const MP3_TIMELINE_FLAGS_OFFSET = OFFSET_CODEC_CONFIGURATION + 3;
const MP3_TAG_FRAME_BYTES_OFFSET = OFFSET_CODEC_CONFIGURATION + 4;
const MP3_ENCODER_DELAY_SAMPLES_OFFSET = OFFSET_CODEC_CONFIGURATION + 6;
const MP3_END_PADDING_SAMPLES_OFFSET = OFFSET_CODEC_CONFIGURATION + 8;
const MP3_RESERVED_START = OFFSET_CODEC_CONFIGURATION + 10;

const MP3_TIMELINE_FLAG_HAS_TAG_FRAME = 1 << 0;
const MP3_TIMELINE_FLAG_HAS_GAPLESS = 1 << 1;
const MP3_TIMELINE_KNOWN_FLAGS = MP3_TIMELINE_FLAG_HAS_TAG_FRAME | MP3_TIMELINE_FLAG_HAS_GAPLESS;
const MP3_MAX_GAPLESS_FIELD_SAMPLES = 0x0ffe;

const ADTS_MIN_FRAME_BYTES = 8;
const ADTS_MAX_FRAME_BYTES = 8_191;
const MP3_MAX_FRAME_BYTES = 1_441;
const MPEG_1_MIN_FRAME_BYTES = 96;
const MPEG_2_MIN_FRAME_BYTES = 24;

const ADTS_SAMPLE_RATES_HZ = Object.freeze([
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
] as const);

const MPEG_1_SAMPLE_RATES_HZ = Object.freeze([32_000, 44_100, 48_000] as const);
const MPEG_2_SAMPLE_RATES_HZ = Object.freeze([16_000, 22_050, 24_000] as const);
const MPEG_2_5_SAMPLE_RATES_HZ = Object.freeze([8_000, 11_025, 12_000] as const);

export type CodecTimelineManifestCodec = 'adts-aac-lc' | 'mp3-no-frame-count';
export type Mp3TimelineMpegVersion = '1' | '2' | '2.5';

export interface AdtsAacLcTimelinePoint {
  readonly frameOrdinal: number;
  readonly byteOffset: number;
}

export interface Mp3NoFrameCountTimelinePoint extends AdtsAacLcTimelinePoint {
  readonly mainDataCapacityBytes: number;
  readonly mainDataBeginBytes: number;
}

export interface Mp3TimelineGaplessMetadata {
  readonly encoderDelaySamples: number;
  readonly endPaddingSamples: number;
}

interface CodecTimelineManifestCommon {
  readonly manifestVersion: typeof CODEC_TIMELINE_MANIFEST_VERSION;
  readonly codec: CodecTimelineManifestCodec;
  /** Frozen, detached byte values rather than a mutable typed-array view. */
  readonly sourceBindingSha256: readonly number[];
  readonly sourceSize: number;
  readonly audioStartByte: number;
  readonly audioEndByte: number;
  readonly frameCount: number;
  readonly sampleRateHz: number;
  readonly samplesPerFrame: number;
  readonly channels: 1 | 2;
}

export interface AdtsAacLcTimelineManifest extends CodecTimelineManifestCommon {
  readonly codec: 'adts-aac-lc';
  readonly mpegId: 0;
  readonly profile: 1;
  readonly audioObjectType: 2;
  readonly sampleRateIndex: number;
  readonly channelConfiguration: 1 | 2;
  readonly protectionAbsent: true;
  /** Exactly one raw_data_block per ADTS access unit. */
  readonly rawDataBlocks: 1;
  readonly points: readonly AdtsAacLcTimelinePoint[];
}

export interface Mp3NoFrameCountTimelineManifest extends CodecTimelineManifestCommon {
  readonly codec: 'mp3-no-frame-count';
  readonly mpegVersion: Mp3TimelineMpegVersion;
  readonly layer: 3;
  readonly hasFrameCountDeclaration: false;
  readonly hasTagFrame: boolean;
  readonly tagFrameBytes: number;
  readonly gapless: Readonly<Mp3TimelineGaplessMetadata> | null;
  /** Exact audible PCM-frame count after mpg123's 529-sample delay rule. */
  readonly totalMediaFrames: number;
  readonly points: readonly Mp3NoFrameCountTimelinePoint[];
}

export type CodecTimelineManifest = AdtsAacLcTimelineManifest | Mp3NoFrameCountTimelineManifest;

export class CodecTimelineManifestError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CodecTimelineManifestError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

interface ExactDataSnapshot {
  readonly [key: string]: unknown;
}

const COMMON_KEYS = Object.freeze([
  'manifestVersion',
  'codec',
  'sourceBindingSha256',
  'sourceSize',
  'audioStartByte',
  'audioEndByte',
  'frameCount',
  'sampleRateHz',
  'samplesPerFrame',
  'channels',
] as const);

const ADTS_MANIFEST_KEYS = Object.freeze([
  ...COMMON_KEYS,
  'mpegId',
  'profile',
  'audioObjectType',
  'sampleRateIndex',
  'channelConfiguration',
  'protectionAbsent',
  'rawDataBlocks',
  'points',
] as const);

const MP3_MANIFEST_KEYS = Object.freeze([
  ...COMMON_KEYS,
  'mpegVersion',
  'layer',
  'hasFrameCountDeclaration',
  'hasTagFrame',
  'tagFrameBytes',
  'gapless',
  'totalMediaFrames',
  'points',
] as const);

const MP3_GAPLESS_KEYS = Object.freeze(['encoderDelaySamples', 'endPaddingSamples'] as const);

const ADTS_POINT_KEYS = Object.freeze(['frameOrdinal', 'byteOffset'] as const);
const MP3_POINT_KEYS = Object.freeze([
  'frameOrdinal',
  'byteOffset',
  'mainDataCapacityBytes',
  'mainDataBeginBytes',
] as const);

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

function fail(message: string, cause?: unknown): never {
  throw new CodecTimelineManifestError(message, cause);
}

function snapshotManifestBytes(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new TypeError('Codec timeline manifest bytes must be a Uint8Array');
  }

  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('Codec timeline manifest bytes must be a Uint8Array');
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('must be a Uint8Array')) throw error;
    throw new TypeError('Codec timeline manifest bytes must be a Uint8Array', { cause: error });
  }

  let byteLength: number;
  try {
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // This intrinsic excludes SharedArrayBuffer and detached storage. A shared
    // view cannot provide a coherent, single-time security-boundary snapshot.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new TypeError(
      'Codec timeline manifest bytes must use readable, local, non-shared storage',
      { cause: error },
    );
  }

  if (byteLength > CODEC_TIMELINE_MANIFEST_MAX_BYTES) {
    fail('Codec timeline manifest exceeds the bounded parser limit');
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new TypeError('Codec timeline manifest bytes could not be copied exactly', {
      cause: error,
    });
  }
  return owned;
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ExactDataSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError(`${label} must be an exact data-only record`);
  }

  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch (error) {
    throw new TypeError(`${label} could not be snapshotted`, { cause: error });
  }

  const allowed = new Set<PropertyKey>(expectedKeys);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has missing or extra fields`);
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotDenseArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);

  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch (error) {
    throw new TypeError(`${label} could not be snapshotted`, { cause: error });
  }

  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !('value' in lengthDescriptor)) {
    throw new TypeError(`${label}.length must be a data property`);
  }
  const length: unknown = lengthDescriptor.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > maxLength
  ) {
    throw new RangeError(`${label} must contain between 1 and ${maxLength} entries`);
  }

  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1) throw new TypeError(`${label} must be dense and data-only`);

  const output = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`${label} must be dense and data-only`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} is outside its canonical safe-integer range`);
  }
  return value;
}

function snapshotDigest(value: unknown): readonly number[] {
  const bytes = snapshotDenseArray(
    value,
    CODEC_TIMELINE_MANIFEST_SOURCE_BINDING_BYTES,
    'sourceBindingSha256',
  );
  if (bytes.length !== CODEC_TIMELINE_MANIFEST_SOURCE_BINDING_BYTES) {
    throw new RangeError('sourceBindingSha256 must contain exactly 32 bytes');
  }
  return Object.freeze(
    bytes.map((byte, index) => requireSafeInteger(byte, `sourceBindingSha256[${index}]`, 0, 255)),
  );
}

function canonicalAdtsPoint(value: unknown, index: number): AdtsAacLcTimelinePoint {
  const record = snapshotExactDataRecord(value, ADTS_POINT_KEYS, `ADTS point ${index}`);
  return Object.freeze({
    frameOrdinal: requireSafeInteger(record.frameOrdinal, `ADTS point ${index} ordinal`, 0),
    byteOffset: requireSafeInteger(record.byteOffset, `ADTS point ${index} offset`, 0),
  });
}

function canonicalMp3Point(value: unknown, index: number): Mp3NoFrameCountTimelinePoint {
  const record = snapshotExactDataRecord(value, MP3_POINT_KEYS, `MP3 point ${index}`);
  return Object.freeze({
    frameOrdinal: requireSafeInteger(record.frameOrdinal, `MP3 point ${index} ordinal`, 0),
    byteOffset: requireSafeInteger(record.byteOffset, `MP3 point ${index} offset`, 0),
    mainDataCapacityBytes: requireSafeInteger(
      record.mainDataCapacityBytes,
      `MP3 point ${index} main-data capacity`,
      1,
      MP3_MAX_FRAME_BYTES - 1,
    ),
    mainDataBeginBytes: requireSafeInteger(
      record.mainDataBeginBytes,
      `MP3 point ${index} main_data_begin`,
      0,
      511,
    ),
  });
}

function spanCanContainUnits(
  byteSpan: number,
  unitCount: number,
  minimumBytes: number,
  maximumBytes: number,
): boolean {
  if (!Number.isSafeInteger(byteSpan) || byteSpan < 0 || !Number.isSafeInteger(unitCount)) {
    return false;
  }
  if (unitCount > Math.floor(Number.MAX_SAFE_INTEGER / minimumBytes)) return false;
  if (byteSpan < unitCount * minimumBytes) return false;
  return (
    unitCount > Math.floor(Number.MAX_SAFE_INTEGER / maximumBytes) ||
    byteSpan <= unitCount * maximumBytes
  );
}

function mainDataCapacityCanFitFrame(
  samplesPerFrame: number,
  frameBytes: number,
  mainDataCapacityBytes: number,
): boolean {
  const structuralBytes = frameBytes - mainDataCapacityBytes;
  return samplesPerFrame === 1_152
    ? structuralBytes === 21 ||
        structuralBytes === 23 ||
        structuralBytes === 36 ||
        structuralBytes === 38
    : structuralBytes === 13 ||
        structuralBytes === 15 ||
        structuralBytes === 21 ||
        structuralBytes === 23;
}

function validatePointCoordinates(
  points: readonly AdtsAacLcTimelinePoint[],
  audioStartByte: number,
  audioEndByte: number,
  frameCount: number,
  minimumFrameBytes: number,
  maximumFrameBytes: number,
): void {
  const first = points[0];
  const last = points.at(-1);
  if (!first || first.frameOrdinal !== 0 || first.byteOffset !== audioStartByte) {
    throw new RangeError('Timeline points must begin at frame zero and audioStartByte');
  }
  if (!last || last.frameOrdinal !== frameCount - 1) {
    throw new RangeError('Timeline points must retain the terminal frame boundary');
  }

  let previous: AdtsAacLcTimelinePoint | undefined;
  for (const point of points) {
    if (point.frameOrdinal >= frameCount || point.byteOffset >= audioEndByte) {
      throw new RangeError('Timeline point lies outside the declared frame or audio span');
    }
    if (
      previous &&
      (point.frameOrdinal <= previous.frameOrdinal || point.byteOffset <= previous.byteOffset)
    ) {
      throw new RangeError('Timeline point coordinates must be strictly increasing');
    }

    if (
      !spanCanContainUnits(
        point.byteOffset - audioStartByte,
        point.frameOrdinal,
        minimumFrameBytes,
        maximumFrameBytes,
      ) ||
      !spanCanContainUnits(
        audioEndByte - point.byteOffset,
        frameCount - point.frameOrdinal,
        minimumFrameBytes,
        maximumFrameBytes,
      )
    ) {
      throw new RangeError('Timeline point geometry is inconsistent with the declared span');
    }
    if (
      previous &&
      !spanCanContainUnits(
        point.byteOffset - previous.byteOffset,
        point.frameOrdinal - previous.frameOrdinal,
        minimumFrameBytes,
        maximumFrameBytes,
      )
    ) {
      throw new RangeError('Adjacent timeline anchors have impossible frame geometry');
    }
    previous = point;
  }
}

function immutableCommon(record: ExactDataSnapshot): Omit<CodecTimelineManifestCommon, 'codec'> {
  const manifestVersion = requireSafeInteger(record.manifestVersion, 'manifestVersion', 1, 1);
  const sourceBindingSha256 = snapshotDigest(record.sourceBindingSha256);
  const sourceSize = requireSafeInteger(record.sourceSize, 'sourceSize', 1);
  const audioStartByte = requireSafeInteger(record.audioStartByte, 'audioStartByte', 0);
  const audioEndByte = requireSafeInteger(record.audioEndByte, 'audioEndByte', 1);
  const frameCount = requireSafeInteger(record.frameCount, 'frameCount', 1);
  const sampleRateHz = requireSafeInteger(record.sampleRateHz, 'sampleRateHz', 1, 0xffff_ffff);
  const samplesPerFrame = requireSafeInteger(record.samplesPerFrame, 'samplesPerFrame', 1, 0xffff);
  const channels = requireSafeInteger(record.channels, 'channels', 1, 2) as 1 | 2;

  if (audioStartByte >= audioEndByte || audioEndByte > sourceSize) {
    throw new RangeError('audio span must be non-empty and contained by sourceSize');
  }
  if (frameCount > Math.floor(Number.MAX_SAFE_INTEGER / samplesPerFrame)) {
    throw new RangeError('frameCount and samplesPerFrame exceed the safe raw-sample timeline');
  }

  return {
    manifestVersion: manifestVersion as 1,
    sourceBindingSha256,
    sourceSize,
    audioStartByte,
    audioEndByte,
    frameCount,
    sampleRateHz,
    samplesPerFrame,
    channels,
  };
}

function canonicalAdtsManifest(record: ExactDataSnapshot): AdtsAacLcTimelineManifest {
  const common = immutableCommon(record);
  const sampleRateIndex = requireSafeInteger(
    record.sampleRateIndex,
    'ADTS sampleRateIndex',
    0,
    ADTS_SAMPLE_RATES_HZ.length - 1,
  );
  const channelConfiguration = requireSafeInteger(
    record.channelConfiguration,
    'ADTS channelConfiguration',
    1,
    2,
  ) as 1 | 2;
  if (
    record.codec !== 'adts-aac-lc' ||
    record.mpegId !== 0 ||
    record.profile !== 1 ||
    record.audioObjectType !== 2 ||
    record.protectionAbsent !== true ||
    record.rawDataBlocks !== 1 ||
    common.samplesPerFrame !== 1_024 ||
    common.sampleRateHz !== ADTS_SAMPLE_RATES_HZ[sampleRateIndex] ||
    common.channels !== channelConfiguration ||
    common.audioStartByte !== 0 ||
    common.audioEndByte !== common.sourceSize
  ) {
    throw new RangeError('ADTS manifest is not canonical MPEG-4 AAC-LC mono/stereo evidence');
  }

  const rawPoints = snapshotDenseArray(
    record.points,
    CODEC_TIMELINE_MANIFEST_MAX_POINTS,
    'ADTS points',
  );
  const points = Object.freeze(rawPoints.map(canonicalAdtsPoint));
  if (points.length > common.frameCount) {
    throw new RangeError('ADTS point count cannot exceed frameCount');
  }
  if (
    !spanCanContainUnits(
      common.audioEndByte - common.audioStartByte,
      common.frameCount,
      ADTS_MIN_FRAME_BYTES,
      ADTS_MAX_FRAME_BYTES,
    )
  ) {
    throw new RangeError('ADTS audio span is inconsistent with frameCount');
  }
  validatePointCoordinates(
    points,
    common.audioStartByte,
    common.audioEndByte,
    common.frameCount,
    ADTS_MIN_FRAME_BYTES,
    ADTS_MAX_FRAME_BYTES,
  );

  return Object.freeze({
    ...common,
    codec: 'adts-aac-lc',
    mpegId: 0,
    profile: 1,
    audioObjectType: 2,
    sampleRateIndex,
    channelConfiguration,
    protectionAbsent: true,
    rawDataBlocks: 1,
    points,
  });
}

function mpegVersionCode(version: Mp3TimelineMpegVersion): number {
  return version === '1' ? 1 : version === '2' ? 2 : 3;
}

function mpegVersionFromCode(code: number): Mp3TimelineMpegVersion {
  if (code === 1) return '1';
  if (code === 2) return '2';
  if (code === 3) return '2.5';
  fail('MP3 manifest has an unknown MPEG version code');
}

function canonicalMp3Gapless(value: unknown): Readonly<Mp3TimelineGaplessMetadata> | null {
  if (value === null) return null;
  const record = snapshotExactDataRecord(value, MP3_GAPLESS_KEYS, 'MP3 gapless metadata');
  return Object.freeze({
    encoderDelaySamples: requireSafeInteger(
      record.encoderDelaySamples,
      'MP3 encoderDelaySamples',
      0,
      MP3_MAX_GAPLESS_FIELD_SAMPLES,
    ),
    endPaddingSamples: requireSafeInteger(
      record.endPaddingSamples,
      'MP3 endPaddingSamples',
      0,
      MP3_MAX_GAPLESS_FIELD_SAMPLES,
    ),
  });
}

function deriveMp3TotalMediaFrames(
  frameCount: number,
  samplesPerFrame: 576 | 1_152,
  gapless: Readonly<Mp3TimelineGaplessMetadata> | null,
): number {
  if (frameCount > Math.floor(Number.MAX_SAFE_INTEGER / samplesPerFrame)) {
    throw new RangeError('MP3 raw-sample timeline exceeds Number.MAX_SAFE_INTEGER');
  }
  return createMp3SampleTimeline({
    totalRawSamples: frameCount * samplesPerFrame,
    samplesPerFrame,
    gapless,
  }).totalMediaFrames;
}

function canonicalMp3Manifest(record: ExactDataSnapshot): Mp3NoFrameCountTimelineManifest {
  const common = immutableCommon(record);
  const mpegVersion = record.mpegVersion;
  if (mpegVersion !== '1' && mpegVersion !== '2' && mpegVersion !== '2.5') {
    throw new RangeError('MP3 mpegVersion must be 1, 2, or 2.5');
  }
  const samplesPerFrame = mpegVersion === '1' ? 1_152 : 576;
  const allowedRates =
    mpegVersion === '1'
      ? MPEG_1_SAMPLE_RATES_HZ
      : mpegVersion === '2'
        ? MPEG_2_SAMPLE_RATES_HZ
        : MPEG_2_5_SAMPLE_RATES_HZ;
  if (
    record.codec !== 'mp3-no-frame-count' ||
    record.layer !== 3 ||
    record.hasFrameCountDeclaration !== false ||
    common.samplesPerFrame !== samplesPerFrame ||
    !(allowedRates as readonly number[]).includes(common.sampleRateHz)
  ) {
    throw new RangeError('MP3 manifest is not canonical Layer III no-frame-count evidence');
  }

  if (typeof record.hasTagFrame !== 'boolean') {
    throw new TypeError('MP3 hasTagFrame must be boolean');
  }
  const hasTagFrame = record.hasTagFrame;
  const tagFrameBytes = requireSafeInteger(
    record.tagFrameBytes,
    'MP3 tagFrameBytes',
    0,
    MP3_MAX_FRAME_BYTES,
  );
  const minimumFrameBytes = mpegVersion === '1' ? MPEG_1_MIN_FRAME_BYTES : MPEG_2_MIN_FRAME_BYTES;
  const gapless = canonicalMp3Gapless(record.gapless);
  if (
    (hasTagFrame && (tagFrameBytes < minimumFrameBytes || tagFrameBytes > common.audioStartByte)) ||
    (!hasTagFrame && tagFrameBytes !== 0) ||
    (gapless !== null && !hasTagFrame)
  ) {
    throw new RangeError('MP3 tag-frame and gapless flags contradict their canonical fields');
  }
  const expectedTotalMediaFrames = deriveMp3TotalMediaFrames(
    common.frameCount,
    samplesPerFrame,
    gapless,
  );
  const totalMediaFrames = requireSafeInteger(record.totalMediaFrames, 'MP3 totalMediaFrames', 1);
  if (totalMediaFrames !== expectedTotalMediaFrames) {
    throw new RangeError('MP3 totalMediaFrames contradicts its exact mpg123 sample timeline');
  }

  const rawPoints = snapshotDenseArray(
    record.points,
    CODEC_TIMELINE_MANIFEST_MAX_POINTS,
    'MP3 points',
  );
  const points = Object.freeze(rawPoints.map(canonicalMp3Point));
  if (points.length > common.frameCount) {
    throw new RangeError('MP3 point count cannot exceed frameCount');
  }
  const maximumMainDataBeginBytes = mpegVersion === '1' ? 511 : 255;
  if (points.some((point) => point.mainDataBeginBytes > maximumMainDataBeginBytes)) {
    throw new RangeError('MP3 main_data_begin exceeds its MPEG-version bound');
  }
  if (points[0]?.mainDataBeginBytes !== 0) {
    throw new RangeError('MP3 frame zero must begin with an empty bit reservoir');
  }

  if (
    !spanCanContainUnits(
      common.audioEndByte - common.audioStartByte,
      common.frameCount,
      minimumFrameBytes,
      MP3_MAX_FRAME_BYTES,
    )
  ) {
    throw new RangeError('MP3 audio span is inconsistent with frameCount');
  }
  validatePointCoordinates(
    points,
    common.audioStartByte,
    common.audioEndByte,
    common.frameCount,
    minimumFrameBytes,
    MP3_MAX_FRAME_BYTES,
  );

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const next = points[index + 1];
    if (
      (!next || next.frameOrdinal === point.frameOrdinal + 1) &&
      !mainDataCapacityCanFitFrame(
        common.samplesPerFrame,
        (next?.byteOffset ?? common.audioEndByte) - point.byteOffset,
        point.mainDataCapacityBytes,
      )
    ) {
      throw new RangeError('MP3 main-data capacity is incompatible with its verified frame span');
    }
  }

  return Object.freeze({
    ...common,
    codec: 'mp3-no-frame-count',
    mpegVersion,
    layer: 3,
    hasFrameCountDeclaration: false,
    hasTagFrame,
    tagFrameBytes,
    gapless,
    totalMediaFrames,
    points,
  });
}

function canonicalManifest(value: unknown): CodecTimelineManifest {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('Codec timeline manifest must be an exact data-only record');
  }

  let outer: PropertyDescriptorMap;
  try {
    outer = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('Codec timeline manifest could not be snapshotted', { cause: error });
  }
  const codecDescriptor = outer.codec;
  if (!codecDescriptor || !('value' in codecDescriptor)) {
    throw new TypeError('Codec timeline manifest codec must be an own data property');
  }
  const codec = codecDescriptor.value;
  const keys =
    codec === 'adts-aac-lc'
      ? ADTS_MANIFEST_KEYS
      : codec === 'mp3-no-frame-count'
        ? MP3_MANIFEST_KEYS
        : null;
  if (!keys) throw new RangeError('Codec timeline manifest codec is unsupported');

  // Use the already captured descriptors so a Proxy cannot present one shape
  // for dispatch and a different shape for canonicalization.
  const allowed = new Set<PropertyKey>(keys);
  const ownKeys = Reflect.ownKeys(outer);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !allowed.has(key))) {
    throw new TypeError('Codec timeline manifest has missing or extra fields');
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = outer[key];
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`Codec timeline manifest ${key} must be an own data property`);
    }
    record[key] = descriptor.value;
  }
  return codec === 'adts-aac-lc' ? canonicalAdtsManifest(record) : canonicalMp3Manifest(record);
}

function setSafeUint64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(offset + 4, value >>> 0, false);
}

function getSafeUint64(view: DataView, offset: number, label: string): number {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  if (high > 0x1f_ffff) fail(`${label} exceeds Number.MAX_SAFE_INTEGER`);
  const value = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(value)) fail(`${label} exceeds Number.MAX_SAFE_INTEGER`);
  return value;
}

function writeCommonHeader(
  bytes: Uint8Array,
  manifest: CodecTimelineManifest,
  codecId: number,
  recordBytes: number,
): DataView {
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(OFFSET_VERSION, CODEC_TIMELINE_MANIFEST_VERSION, false);
  view.setUint8(OFFSET_CODEC, codecId);
  view.setUint16(OFFSET_HEADER_BYTES, CODEC_TIMELINE_MANIFEST_HEADER_BYTES, false);
  view.setUint16(OFFSET_RECORD_BYTES, recordBytes, false);
  view.setUint32(OFFSET_POINT_COUNT, manifest.points.length, false);
  bytes.set(manifest.sourceBindingSha256, OFFSET_SOURCE_BINDING);
  setSafeUint64(view, OFFSET_SOURCE_SIZE, manifest.sourceSize);
  setSafeUint64(view, OFFSET_AUDIO_START, manifest.audioStartByte);
  setSafeUint64(view, OFFSET_AUDIO_END, manifest.audioEndByte);
  setSafeUint64(view, OFFSET_FRAME_COUNT, manifest.frameCount);
  view.setUint32(OFFSET_SAMPLE_RATE, manifest.sampleRateHz, false);
  view.setUint16(OFFSET_SAMPLES_PER_FRAME, manifest.samplesPerFrame, false);
  view.setUint8(OFFSET_CHANNELS, manifest.channels);
  return view;
}

/** Encode one exact data-only manifest into canonical, owned binary bytes. */
export function encodeCodecTimelineManifest(value: unknown): Uint8Array {
  const manifest = canonicalManifest(value);
  const recordBytes =
    manifest.codec === 'adts-aac-lc'
      ? ADTS_AAC_LC_TIMELINE_POINT_BYTES
      : MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES;
  const byteLength = CODEC_TIMELINE_MANIFEST_HEADER_BYTES + manifest.points.length * recordBytes;
  if (byteLength > CODEC_TIMELINE_MANIFEST_MAX_BYTES) {
    fail('Codec timeline manifest exceeds the bounded encoder limit');
  }

  const bytes = new Uint8ArrayIntrinsic(byteLength);
  const view = writeCommonHeader(
    bytes,
    manifest,
    manifest.codec === 'adts-aac-lc' ? CODEC_ADTS_AAC_LC : CODEC_MP3_NO_FRAME_COUNT,
    recordBytes,
  );

  if (manifest.codec === 'adts-aac-lc') {
    view.setUint8(ADTS_MPEG_ID_OFFSET, manifest.mpegId);
    view.setUint8(ADTS_PROFILE_OFFSET, manifest.profile);
    view.setUint8(ADTS_AUDIO_OBJECT_TYPE_OFFSET, manifest.audioObjectType);
    view.setUint8(ADTS_SAMPLE_RATE_INDEX_OFFSET, manifest.sampleRateIndex);
    view.setUint8(ADTS_CHANNEL_CONFIGURATION_OFFSET, manifest.channelConfiguration);
    view.setUint8(ADTS_PROTECTION_ABSENT_OFFSET, 1);
    view.setUint8(ADTS_RAW_DATA_BLOCKS_OFFSET, manifest.rawDataBlocks);
    manifest.points.forEach((point, index) => {
      const offset = CODEC_TIMELINE_MANIFEST_HEADER_BYTES + index * recordBytes;
      setSafeUint64(view, offset, point.frameOrdinal);
      setSafeUint64(view, offset + 8, point.byteOffset);
    });
  } else {
    view.setUint8(MP3_MPEG_VERSION_OFFSET, mpegVersionCode(manifest.mpegVersion));
    view.setUint8(MP3_LAYER_OFFSET, manifest.layer);
    view.setUint8(MP3_NO_FRAME_COUNT_OFFSET, 1);
    view.setUint8(
      MP3_TIMELINE_FLAGS_OFFSET,
      (manifest.hasTagFrame ? MP3_TIMELINE_FLAG_HAS_TAG_FRAME : 0) |
        (manifest.gapless === null ? 0 : MP3_TIMELINE_FLAG_HAS_GAPLESS),
    );
    view.setUint16(MP3_TAG_FRAME_BYTES_OFFSET, manifest.tagFrameBytes, false);
    view.setUint16(
      MP3_ENCODER_DELAY_SAMPLES_OFFSET,
      manifest.gapless?.encoderDelaySamples ?? 0,
      false,
    );
    view.setUint16(MP3_END_PADDING_SAMPLES_OFFSET, manifest.gapless?.endPaddingSamples ?? 0, false);
    manifest.points.forEach((point, index) => {
      const offset = CODEC_TIMELINE_MANIFEST_HEADER_BYTES + index * recordBytes;
      setSafeUint64(view, offset, point.frameOrdinal);
      setSafeUint64(view, offset + 8, point.byteOffset);
      view.setUint16(offset + 16, point.mainDataCapacityBytes, false);
      view.setUint16(offset + 18, point.mainDataBeginBytes, false);
    });
  }
  return bytes;
}

function requireZeroRange(bytes: Uint8Array, start: number, end: number, label: string): void {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) fail(`${label} must be zero`);
  }
}

function parseCommonRecord(
  bytes: Uint8Array,
  view: DataView,
  codec: CodecTimelineManifestCodec,
): Record<string, unknown> {
  const digest = Object.freeze(
    Array.from(bytes.subarray(OFFSET_SOURCE_BINDING, OFFSET_SOURCE_BINDING + 32)),
  );
  return {
    manifestVersion: CODEC_TIMELINE_MANIFEST_VERSION,
    codec,
    sourceBindingSha256: digest,
    sourceSize: getSafeUint64(view, OFFSET_SOURCE_SIZE, 'sourceSize'),
    audioStartByte: getSafeUint64(view, OFFSET_AUDIO_START, 'audioStartByte'),
    audioEndByte: getSafeUint64(view, OFFSET_AUDIO_END, 'audioEndByte'),
    frameCount: getSafeUint64(view, OFFSET_FRAME_COUNT, 'frameCount'),
    sampleRateHz: view.getUint32(OFFSET_SAMPLE_RATE, false),
    samplesPerFrame: view.getUint16(OFFSET_SAMPLES_PER_FRAME, false),
    channels: view.getUint8(OFFSET_CHANNELS),
  };
}

/**
 * Parse and validate one canonical manifest. The returned graph is fresh,
 * detached from the caller's bytes, and deeply frozen.
 */
export function parseCodecTimelineManifest(value: unknown): CodecTimelineManifest {
  const bytes = snapshotManifestBytes(value);
  if (bytes.byteLength < CODEC_TIMELINE_MANIFEST_HEADER_BYTES) {
    fail('Codec timeline manifest header is truncated');
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) fail('Codec timeline manifest magic is invalid');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(OFFSET_VERSION, false) !== CODEC_TIMELINE_MANIFEST_VERSION) {
    fail('Codec timeline manifest version is unsupported');
  }
  const codecId = view.getUint8(OFFSET_CODEC);
  const codec =
    codecId === CODEC_ADTS_AAC_LC
      ? 'adts-aac-lc'
      : codecId === CODEC_MP3_NO_FRAME_COUNT
        ? 'mp3-no-frame-count'
        : null;
  if (!codec) fail('Codec timeline manifest codec id is unsupported');
  const expectedRecordBytes =
    codec === 'adts-aac-lc'
      ? ADTS_AAC_LC_TIMELINE_POINT_BYTES
      : MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES;
  if (
    view.getUint8(OFFSET_FLAGS) !== 0 ||
    view.getUint16(OFFSET_HEADER_BYTES, false) !== CODEC_TIMELINE_MANIFEST_HEADER_BYTES ||
    view.getUint16(OFFSET_RECORD_BYTES, false) !== expectedRecordBytes
  ) {
    fail('Codec timeline manifest layout is noncanonical');
  }
  requireZeroRange(bytes, OFFSET_COMMON_RESERVED, OFFSET_SOURCE_BINDING, 'common reserved fields');
  if (view.getUint8(OFFSET_COMMON_RESERVED_BYTE) !== 0) {
    fail('common reserved byte must be zero');
  }

  const pointCount = view.getUint32(OFFSET_POINT_COUNT, false);
  if (pointCount < 1 || pointCount > CODEC_TIMELINE_MANIFEST_MAX_POINTS) {
    fail('Codec timeline manifest point count exceeds its canonical bounds');
  }
  const expectedLength = CODEC_TIMELINE_MANIFEST_HEADER_BYTES + pointCount * expectedRecordBytes;
  if (bytes.byteLength !== expectedLength) {
    fail('Codec timeline manifest length does not exactly match its records');
  }

  const record = parseCommonRecord(bytes, view, codec);
  if (codec === 'adts-aac-lc') {
    requireZeroRange(
      bytes,
      ADTS_RESERVED_START,
      CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
      'ADTS reserved fields',
    );
    record.mpegId = view.getUint8(ADTS_MPEG_ID_OFFSET);
    record.profile = view.getUint8(ADTS_PROFILE_OFFSET);
    record.audioObjectType = view.getUint8(ADTS_AUDIO_OBJECT_TYPE_OFFSET);
    record.sampleRateIndex = view.getUint8(ADTS_SAMPLE_RATE_INDEX_OFFSET);
    record.channelConfiguration = view.getUint8(ADTS_CHANNEL_CONFIGURATION_OFFSET);
    record.protectionAbsent = view.getUint8(ADTS_PROTECTION_ABSENT_OFFSET) === 1;
    record.rawDataBlocks = view.getUint8(ADTS_RAW_DATA_BLOCKS_OFFSET);
    const points: AdtsAacLcTimelinePoint[] = [];
    for (let index = 0; index < pointCount; index += 1) {
      const offset = CODEC_TIMELINE_MANIFEST_HEADER_BYTES + index * expectedRecordBytes;
      points.push({
        frameOrdinal: getSafeUint64(view, offset, `ADTS point ${index} ordinal`),
        byteOffset: getSafeUint64(view, offset + 8, `ADTS point ${index} offset`),
      });
    }
    record.points = points;
    return canonicalAdtsManifest(record);
  }

  requireZeroRange(
    bytes,
    MP3_RESERVED_START,
    CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
    'MP3 reserved fields',
  );
  const mpegVersion = mpegVersionFromCode(view.getUint8(MP3_MPEG_VERSION_OFFSET));
  record.mpegVersion = mpegVersion;
  record.layer = view.getUint8(MP3_LAYER_OFFSET);
  record.hasFrameCountDeclaration = view.getUint8(MP3_NO_FRAME_COUNT_OFFSET) !== 1;
  const timelineFlags = view.getUint8(MP3_TIMELINE_FLAGS_OFFSET);
  if ((timelineFlags & ~MP3_TIMELINE_KNOWN_FLAGS) !== 0) {
    fail('MP3 timeline header uses unknown flag bits');
  }
  const hasTagFrame = (timelineFlags & MP3_TIMELINE_FLAG_HAS_TAG_FRAME) !== 0;
  const hasGapless = (timelineFlags & MP3_TIMELINE_FLAG_HAS_GAPLESS) !== 0;
  const tagFrameBytes = view.getUint16(MP3_TAG_FRAME_BYTES_OFFSET, false);
  const encoderDelaySamples = view.getUint16(MP3_ENCODER_DELAY_SAMPLES_OFFSET, false);
  const endPaddingSamples = view.getUint16(MP3_END_PADDING_SAMPLES_OFFSET, false);
  if (!hasGapless && (encoderDelaySamples !== 0 || endPaddingSamples !== 0)) {
    fail('MP3 non-gapless timeline must zero its delay and padding fields');
  }
  if (
    hasGapless &&
    (encoderDelaySamples > MP3_MAX_GAPLESS_FIELD_SAMPLES ||
      endPaddingSamples > MP3_MAX_GAPLESS_FIELD_SAMPLES)
  ) {
    fail('MP3 gapless delay and padding use the reserved 0xfff value');
  }
  record.hasTagFrame = hasTagFrame;
  record.tagFrameBytes = tagFrameBytes;
  record.gapless = hasGapless ? { encoderDelaySamples, endPaddingSamples } : null;
  record.totalMediaFrames = deriveMp3TotalMediaFrames(
    record.frameCount as number,
    record.samplesPerFrame as 576 | 1_152,
    record.gapless as Readonly<Mp3TimelineGaplessMetadata> | null,
  );
  const points: Mp3NoFrameCountTimelinePoint[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    const offset = CODEC_TIMELINE_MANIFEST_HEADER_BYTES + index * expectedRecordBytes;
    if (view.getUint32(offset + 20, false) !== 0)
      fail(`MP3 point ${index} reserved field must be zero`);
    points.push({
      frameOrdinal: getSafeUint64(view, offset, `MP3 point ${index} ordinal`),
      byteOffset: getSafeUint64(view, offset + 8, `MP3 point ${index} offset`),
      mainDataCapacityBytes: view.getUint16(offset + 16, false),
      mainDataBeginBytes: view.getUint16(offset + 18, false),
    });
  }
  record.points = points;
  return canonicalMp3Manifest(record);
}
