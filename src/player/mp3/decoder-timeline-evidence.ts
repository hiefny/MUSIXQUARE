import { isEncodedAudioSourceIdentity } from '../sources/encoded-audio-source.ts';
import type { MpegLayer3Version } from './frame-header.ts';
import { MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES } from './manifest-structural-reconstruction.ts';
import type { Mp3FrameCountEvidence } from './metadata.ts';
import {
  MP3_SEEK_INDEX_MAX_POINTS,
  MpegLayer3SeekIndex,
  type MpegLayer3SeekIndexPoint,
} from './seek-index.ts';
import { createMp3SampleTimeline, type Mp3SampleTimeline } from './timeline.ts';
import type { LameEncoderFamily, Mp3GaplessMetadata } from './vbr-metadata.ts';

export type Mp3DecoderTagDeclarationKind = 'xing' | 'info' | 'vbri';
export type Mp3DecoderTimelineProvenanceKind = 'scanner' | 'admitted-manifest';
export type Mp3DecoderFrameCountEvidence = Mp3FrameCountEvidence | 'admitted-manifest';

export interface Mp3DecoderTagDeclaration {
  readonly kind: Mp3DecoderTagDeclarationKind;
  readonly frameCount: number | null;
  readonly streamBytes: number | null;
  /** CRC-backed encoder proof copied from scanner-issued metadata. */
  readonly gapless: Readonly<Mp3GaplessMetadata> | null;
}

export interface Mp3DecoderTagFrameEvidence {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly declaration: Readonly<Mp3DecoderTagDeclaration>;
}

/**
 * Exact endpoint observations retained by the bounded no-count manifest
 * reconstruction. The contiguous prefix and terminal frame were read from the
 * source; sparse points between them remain outer-admission planning anchors.
 */
export interface Mp3DecoderManifestEndpointEvidence {
  readonly tagDeclaration: Readonly<Mp3DecoderTagDeclaration> | null;
  readonly verifiedPrefixFrameCount: number;
  readonly verifiedPrefixByteEnd: number;
  readonly terminalFrameOrdinal: number;
  readonly terminalFrameByteOffset: number;
  readonly terminalFrameByteLength: number;
  readonly terminalMainDataCapacityBytes: number;
  readonly terminalMainDataBeginBytes: number;
}

/**
 * Canonical, source-bound decoder geometry after container metadata has been
 * validated. This is planning data, not transport or manifest authority.
 */
export interface Mp3DecoderTimelineEvidence {
  readonly format: 'mp3-decoder-timeline';
  /** Detached decoder evidence never grants scanner or admission authority. */
  readonly authority: 'none';
  readonly provenanceKind: Mp3DecoderTimelineProvenanceKind;
  readonly sourceIdentity: string;
  readonly sourceSize: number;
  readonly version: MpegLayer3Version;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  readonly audioFrameCount: number;
  /**
   * Normalized structural proof only. Encoded-byte and CRC authenticity still
   * comes from the scanner or admitted-manifest issuer.
   */
  readonly tagFrame: Readonly<Mp3DecoderTagFrameEvidence> | null;
  readonly frameCountEvidence: Mp3DecoderFrameCountEvidence;
  readonly fullyVerifiedFrameSpan: boolean;
  /** Actual contiguous source prefix only; a separately checked terminal is excluded. */
  readonly verifiedAudioFrameCount: number;
  readonly verifiedAudioBytes: number;
  readonly timeline: Readonly<Mp3SampleTimeline>;
  readonly manifestEndpointEvidence: Readonly<Mp3DecoderManifestEndpointEvidence> | null;
  readonly seekPoints: readonly Readonly<MpegLayer3SeekIndexPoint>[];
}

export class Mp3DecoderTimelineEvidenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'Mp3DecoderTimelineEvidenceError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

const EVIDENCE_KEYS = Object.freeze([
  'format',
  'authority',
  'provenanceKind',
  'sourceIdentity',
  'sourceSize',
  'version',
  'sampleRateHz',
  'channels',
  'samplesPerFrame',
  'firstAudioFrameOffset',
  'audioEndByteOffset',
  'audioFrameCount',
  'tagFrame',
  'frameCountEvidence',
  'fullyVerifiedFrameSpan',
  'verifiedAudioFrameCount',
  'verifiedAudioBytes',
  'timeline',
  'manifestEndpointEvidence',
  'seekPoints',
] as const satisfies readonly (keyof Mp3DecoderTimelineEvidence)[]);

const TAG_FRAME_KEYS = Object.freeze([
  'byteOffset',
  'byteLength',
  'declaration',
] as const satisfies readonly (keyof Mp3DecoderTagFrameEvidence)[]);

const DECLARATION_KEYS = Object.freeze([
  'kind',
  'frameCount',
  'streamBytes',
  'gapless',
] as const satisfies readonly (keyof Mp3DecoderTagDeclaration)[]);

const MANIFEST_ENDPOINT_KEYS = Object.freeze([
  'tagDeclaration',
  'verifiedPrefixFrameCount',
  'verifiedPrefixByteEnd',
  'terminalFrameOrdinal',
  'terminalFrameByteOffset',
  'terminalFrameByteLength',
  'terminalMainDataCapacityBytes',
  'terminalMainDataBeginBytes',
] as const satisfies readonly (keyof Mp3DecoderManifestEndpointEvidence)[]);

const GAPLESS_KEYS = Object.freeze([
  'encoderFamily',
  'encoderTag',
  'encoderDelaySamples',
  'endPaddingSamples',
] as const satisfies readonly (keyof Mp3GaplessMetadata)[]);

const TIMELINE_KEYS = Object.freeze([
  'totalRawSamples',
  'samplesPerFrame',
  'headTrimSamples',
  'tailTrimSamples',
  'rawEofSampleExclusive',
  'totalMediaFrames',
] as const satisfies readonly (keyof Mp3SampleTimeline)[]);

const SEEK_POINT_KEYS = Object.freeze([
  'rawSample',
  'byteOffset',
  'frameOrdinal',
  'mainDataCapacityBytes',
  'mainDataBeginBytes',
] as const satisfies readonly (keyof MpegLayer3SeekIndexPoint)[]);

const MPEG_1_SAMPLE_RATES = Object.freeze([32_000, 44_100, 48_000] as const);
const MPEG_2_SAMPLE_RATES = Object.freeze([16_000, 22_050, 24_000] as const);
const MPEG_2_5_SAMPLE_RATES = Object.freeze([8_000, 11_025, 12_000] as const);
const MAX_LAYER_3_FRAME_BYTES = 1_441;
type StrictRecord = Readonly<Record<string, unknown>>;

function exactDataRecord(value: unknown, keys: readonly string[], label: string): StrictRecord {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError(`${label} must be an exact data-only record`);
  }

  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must use a plain or null prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<PropertyKey>(keys);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => !expected.has(key))) {
      throw new TypeError(`${label} has missing or unsupported fields`);
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} ${key} must be an enumerable data property`);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} could not be snapshotted`, { cause: error });
  }
}

function denseDataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a dense data-only array`);
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${label} must use the intrinsic Array prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
      throw new TypeError(`${label} length must be a data property`);
    }
    const length = lengthDescriptor.value;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MP3_SEEK_INDEX_MAX_POINTS
    ) {
      throw new RangeError(`${label} must contain 1 through ${MP3_SEEK_INDEX_MAX_POINTS} entries`);
    }
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key === 'symbol')) {
      throw new TypeError(`${label} must be dense and cannot contain extra fields`);
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} entry ${index} must be an enumerable data property`);
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError(`${label} could not be snapshotted`, { cause: error });
  }
}

function safeInteger(
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
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Mp3DecoderTimelineEvidenceError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Mp3DecoderTimelineEvidenceError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function minimumFrameBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 1_152 ? 96 : 24;
}

function spanCanContainFrames(
  byteSpan: number,
  frameCount: number,
  minimumBytesPerFrame: number,
): boolean {
  if (frameCount > Math.floor(Number.MAX_SAFE_INTEGER / minimumBytesPerFrame)) return false;
  if (byteSpan < frameCount * minimumBytesPerFrame) return false;
  return (
    frameCount > Math.floor(Number.MAX_SAFE_INTEGER / MAX_LAYER_3_FRAME_BYTES) ||
    byteSpan <= frameCount * MAX_LAYER_3_FRAME_BYTES
  );
}

function versionGeometry(
  version: unknown,
  sampleRateHz: number,
  samplesPerFrame: number,
): { readonly version: MpegLayer3Version; readonly samplesPerFrame: 576 | 1_152 } {
  if (version !== '1' && version !== '2' && version !== '2.5') {
    throw new RangeError('MP3 timeline evidence version must be 1, 2, or 2.5');
  }
  const expectedSamplesPerFrame = version === '1' ? 1_152 : 576;
  const allowedRates =
    version === '1'
      ? MPEG_1_SAMPLE_RATES
      : version === '2'
        ? MPEG_2_SAMPLE_RATES
        : MPEG_2_5_SAMPLE_RATES;
  if (
    samplesPerFrame !== expectedSamplesPerFrame ||
    !(allowedRates as readonly number[]).includes(sampleRateHz)
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 timeline evidence version, rate, and samples-per-frame disagree',
    );
  }
  return Object.freeze({ version, samplesPerFrame: expectedSamplesPerFrame });
}

function encoderFamilyForTag(value: string): LameEncoderFamily | null {
  if (value.startsWith('LAME')) return 'LAME';
  if (value.startsWith('L3.99')) return 'L3.99';
  if (value.startsWith('Lavf')) return 'Lavf';
  if (value.startsWith('Lavc')) return 'Lavc';
  return null;
}

function canonicalGapless(
  value: unknown,
  totalRawSamples: number,
): Readonly<Mp3GaplessMetadata> | null {
  if (value === null) return null;
  const record = exactDataRecord(value, GAPLESS_KEYS, 'MP3 decoder gapless timing');
  if (
    typeof record.encoderTag !== 'string' ||
    record.encoderTag.length < 4 ||
    record.encoderTag.length > 9 ||
    Array.from(record.encoderTag).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code > 0x7e;
    })
  ) {
    throw new TypeError('MP3 decoder gapless encoder tag is not canonical ASCII');
  }
  const encoderFamily = encoderFamilyForTag(record.encoderTag);
  if (encoderFamily === null || record.encoderFamily !== encoderFamily) {
    throw new TypeError('MP3 decoder gapless encoder family contradicts its tag');
  }
  const encoderDelaySamples = safeInteger(
    record.encoderDelaySamples,
    'MP3 encoder delay',
    0,
    0xffe,
  );
  const endPaddingSamples = safeInteger(record.endPaddingSamples, 'MP3 end padding', 0, 0xffe);
  if (encoderDelaySamples + endPaddingSamples >= totalRawSamples) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 gapless proof removes the complete coded sample span',
    );
  }
  return Object.freeze({
    encoderFamily,
    encoderTag: record.encoderTag,
    encoderDelaySamples,
    endPaddingSamples,
  });
}

function canonicalTagDeclaration(
  value: unknown,
  tagFrameByteOffset: number,
  audioEndByteOffset: number,
  audioFrameCount: number,
  totalRawSamples: number,
  label: string,
): Readonly<Mp3DecoderTagDeclaration> {
  const declarationRecord = exactDataRecord(value, DECLARATION_KEYS, label);
  if (
    declarationRecord.kind !== 'xing' &&
    declarationRecord.kind !== 'info' &&
    declarationRecord.kind !== 'vbri'
  ) {
    throw new TypeError('MP3 decoder tag declaration kind is invalid');
  }
  const frameCount =
    declarationRecord.frameCount === null
      ? null
      : safeInteger(declarationRecord.frameCount, 'MP3 declared frame count', 1);
  const streamBytes =
    declarationRecord.streamBytes === null
      ? null
      : safeInteger(declarationRecord.streamBytes, 'MP3 declared stream bytes', 1);
  if (frameCount !== null && frameCount !== audioFrameCount) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 tag declaration frame count contradicts the audio timeline',
    );
  }
  if (streamBytes !== null && streamBytes !== audioEndByteOffset - tagFrameByteOffset) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 tag declaration stream bytes contradict the physical MPEG span',
    );
  }
  const gapless = canonicalGapless(declarationRecord.gapless, totalRawSamples);
  if (declarationRecord.kind === 'vbri') {
    if (frameCount === null || streamBytes === null || gapless !== null) {
      throw new Mp3DecoderTimelineEvidenceError(
        'MP3 VBRI declaration requires counts and cannot carry Xing gapless proof',
      );
    }
  } else if (gapless !== null && frameCount === null) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 Xing/Info gapless proof requires a declared frame count',
    );
  }
  const declaration = Object.freeze({
    kind: declarationRecord.kind,
    frameCount,
    streamBytes,
    gapless,
  });
  return declaration;
}

function canonicalTagFrame(
  value: unknown,
  firstAudioFrameOffset: number,
  audioEndByteOffset: number,
  audioFrameCount: number,
  totalRawSamples: number,
  samplesPerFrame: 576 | 1_152,
): Readonly<Mp3DecoderTagFrameEvidence> | null {
  if (value === null) return null;
  const record = exactDataRecord(value, TAG_FRAME_KEYS, 'MP3 decoder tag frame');
  const byteOffset = safeInteger(record.byteOffset, 'MP3 tag frame offset', 0);
  const byteLength = safeInteger(
    record.byteLength,
    'MP3 tag frame length',
    minimumFrameBytes(samplesPerFrame),
    MAX_LAYER_3_FRAME_BYTES,
  );
  if (safeAdd(byteOffset, byteLength, 'MP3 tag frame end') !== firstAudioFrameOffset) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 tag frame must end exactly at the first audio frame',
    );
  }
  const declaration = canonicalTagDeclaration(
    record.declaration,
    byteOffset,
    audioEndByteOffset,
    audioFrameCount,
    totalRawSamples,
    'MP3 decoder tag declaration',
  );
  return Object.freeze({ byteOffset, byteLength, declaration });
}

function canonicalTimeline(
  value: unknown,
  expectedRawSamples: number,
  expectedSamplesPerFrame: 576 | 1_152,
  gapless: Readonly<Mp3GaplessMetadata> | null,
): Readonly<Mp3SampleTimeline> {
  const record = exactDataRecord(value, TIMELINE_KEYS, 'MP3 decoder sample timeline');
  const totalRawSamples = safeInteger(record.totalRawSamples, 'MP3 total raw samples', 1);
  const samplesPerFrame = safeInteger(
    record.samplesPerFrame,
    'MP3 timeline samples per frame',
    576,
    1_152,
  );
  if (samplesPerFrame !== 576 && samplesPerFrame !== 1_152) {
    throw new RangeError('MP3 timeline samples per frame must be 576 or 1,152');
  }
  const headTrimSamples = safeInteger(record.headTrimSamples, 'MP3 head trim', 0);
  const tailTrimSamples = safeInteger(record.tailTrimSamples, 'MP3 tail trim', 0);
  const rawEofSampleExclusive = safeInteger(record.rawEofSampleExclusive, 'MP3 raw EOF sample', 1);
  const totalMediaFrames = safeInteger(record.totalMediaFrames, 'MP3 total media frames', 1);
  const supplied = Object.freeze({
    totalRawSamples,
    samplesPerFrame,
    headTrimSamples,
    tailTrimSamples,
    rawEofSampleExclusive,
    totalMediaFrames,
  });
  let expected: Readonly<Mp3SampleTimeline>;
  try {
    expected = createMp3SampleTimeline({
      totalRawSamples: expectedRawSamples,
      samplesPerFrame: expectedSamplesPerFrame,
      gapless,
    });
  } catch (error) {
    throw new Mp3DecoderTimelineEvidenceError('MP3 decoder gapless timeline is invalid', error);
  }
  if (TIMELINE_KEYS.some((key) => supplied[key] !== expected[key])) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 decoder sample timeline contradicts its source-frame and gapless geometry',
    );
  }
  return expected;
}

function pointsEqual(
  left: Readonly<MpegLayer3SeekIndexPoint>,
  right: Readonly<MpegLayer3SeekIndexPoint>,
): boolean {
  return SEEK_POINT_KEYS.every((key) => left[key] === right[key]);
}

function canonicalSeekPoint(
  value: unknown,
  index: number,
  samplesPerFrame: 576 | 1_152,
): Readonly<MpegLayer3SeekIndexPoint> {
  const record = exactDataRecord(value, SEEK_POINT_KEYS, `MP3 decoder seek point ${index}`);
  const frameOrdinal = safeInteger(record.frameOrdinal, `MP3 seek point ${index} ordinal`, 0);
  const rawSample = safeInteger(record.rawSample, `MP3 seek point ${index} raw sample`, 0);
  if (rawSample !== safeMultiply(frameOrdinal, samplesPerFrame, 'MP3 seek raw sample')) {
    throw new Mp3DecoderTimelineEvidenceError(
      `MP3 seek point ${index} raw sample contradicts its frame ordinal`,
    );
  }
  return Object.freeze({
    rawSample,
    byteOffset: safeInteger(record.byteOffset, `MP3 seek point ${index} offset`, 0),
    frameOrdinal,
    mainDataCapacityBytes: safeInteger(
      record.mainDataCapacityBytes,
      `MP3 seek point ${index} main-data capacity`,
      1,
      MAX_LAYER_3_FRAME_BYTES - 1,
    ),
    mainDataBeginBytes: safeInteger(
      record.mainDataBeginBytes,
      `MP3 seek point ${index} main-data begin`,
      0,
      samplesPerFrame === 1_152 ? 511 : 255,
    ),
  });
}

function declarationsEqual(
  left: Readonly<Mp3DecoderTagDeclaration> | null,
  right: Readonly<Mp3DecoderTagDeclaration> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.frameCount === right.frameCount &&
    left.streamBytes === right.streamBytes &&
    ((left.gapless === null && right.gapless === null) ||
      (left.gapless !== null &&
        right.gapless !== null &&
        GAPLESS_KEYS.every((key) => left.gapless?.[key] === right.gapless?.[key])))
  );
}

function canonicalManifestEndpointEvidence(
  value: unknown,
  options: {
    readonly sourceSize: number;
    readonly firstAudioFrameOffset: number;
    readonly audioEndByteOffset: number;
    readonly audioFrameCount: number;
    readonly totalRawSamples: number;
    readonly samplesPerFrame: 576 | 1_152;
    readonly tagFrame: Readonly<Mp3DecoderTagFrameEvidence> | null;
    readonly verifiedAudioFrameCount: number;
    readonly verifiedAudioBytes: number;
    readonly points: readonly Readonly<MpegLayer3SeekIndexPoint>[];
  },
): Readonly<Mp3DecoderManifestEndpointEvidence> {
  const record = exactDataRecord(
    value,
    MANIFEST_ENDPOINT_KEYS,
    'MP3 admitted-manifest endpoint evidence',
  );
  const expectedDeclaration = options.tagFrame?.declaration ?? null;
  const tagDeclaration =
    record.tagDeclaration === null
      ? null
      : canonicalTagDeclaration(
          record.tagDeclaration,
          options.tagFrame?.byteOffset ?? options.firstAudioFrameOffset,
          options.audioEndByteOffset,
          options.audioFrameCount,
          options.totalRawSamples,
          'MP3 admitted-manifest tag declaration',
        );
  if (!declarationsEqual(tagDeclaration, expectedDeclaration)) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 admitted-manifest endpoint declaration contradicts its tag frame',
    );
  }
  if (
    tagDeclaration !== null &&
    (tagDeclaration.kind === 'vbri' ||
      tagDeclaration.frameCount !== null ||
      tagDeclaration.gapless !== null)
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 admitted no-count manifest cannot carry VBRI, a declared frame count, or gapless proof',
    );
  }

  const verifiedPrefixFrameCount = safeInteger(
    record.verifiedPrefixFrameCount,
    'MP3 admitted verified-prefix frame count',
    1,
    options.audioFrameCount,
  );
  const expectedPrefixFrames = Math.min(
    options.audioFrameCount,
    MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES,
  );
  if (
    verifiedPrefixFrameCount !== expectedPrefixFrames ||
    verifiedPrefixFrameCount !== options.verifiedAudioFrameCount
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 admitted-manifest endpoint contradicts its actual contiguous prefix frame count',
    );
  }
  const verifiedPrefixByteEnd = safeInteger(
    record.verifiedPrefixByteEnd,
    'MP3 admitted verified-prefix byte end',
    options.firstAudioFrameOffset + 1,
    options.audioEndByteOffset,
  );
  if (
    verifiedPrefixByteEnd - options.firstAudioFrameOffset !== options.verifiedAudioBytes ||
    (verifiedPrefixFrameCount === options.audioFrameCount) !==
      (verifiedPrefixByteEnd === options.audioEndByteOffset)
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 admitted-manifest endpoint contradicts its actual contiguous prefix byte span',
    );
  }

  for (const point of options.points) {
    if (
      (point.frameOrdinal < verifiedPrefixFrameCount &&
        point.byteOffset >= verifiedPrefixByteEnd) ||
      (point.frameOrdinal === verifiedPrefixFrameCount &&
        point.byteOffset !== verifiedPrefixByteEnd) ||
      (point.frameOrdinal > verifiedPrefixFrameCount && point.byteOffset <= verifiedPrefixByteEnd)
    ) {
      throw new Mp3DecoderTimelineEvidenceError(
        'MP3 admitted-manifest seek anchor contradicts the exact verified-prefix boundary',
      );
    }
  }

  const terminalFrameOrdinal = safeInteger(
    record.terminalFrameOrdinal,
    'MP3 admitted terminal frame ordinal',
    0,
    options.audioFrameCount - 1,
  );
  const terminalFrameByteOffset = safeInteger(
    record.terminalFrameByteOffset,
    'MP3 admitted terminal frame offset',
    options.firstAudioFrameOffset,
    options.audioEndByteOffset - 1,
  );
  const terminalFrameByteLength = safeInteger(
    record.terminalFrameByteLength,
    'MP3 admitted terminal frame length',
    minimumFrameBytes(options.samplesPerFrame),
    MAX_LAYER_3_FRAME_BYTES,
  );
  const terminalMainDataCapacityBytes = safeInteger(
    record.terminalMainDataCapacityBytes,
    'MP3 admitted terminal main-data capacity',
    1,
    MAX_LAYER_3_FRAME_BYTES - 1,
  );
  const terminalMainDataBeginBytes = safeInteger(
    record.terminalMainDataBeginBytes,
    'MP3 admitted terminal main-data begin',
    0,
    options.samplesPerFrame === 1_152 ? 511 : 255,
  );
  const terminalPoint = options.points[options.points.length - 1];
  if (
    !terminalPoint ||
    terminalFrameOrdinal !== options.audioFrameCount - 1 ||
    terminalPoint.frameOrdinal !== terminalFrameOrdinal ||
    terminalPoint.byteOffset !== terminalFrameByteOffset ||
    terminalPoint.mainDataCapacityBytes !== terminalMainDataCapacityBytes ||
    terminalPoint.mainDataBeginBytes !== terminalMainDataBeginBytes ||
    safeAdd(terminalFrameByteOffset, terminalFrameByteLength, 'MP3 admitted terminal frame end') !==
      options.audioEndByteOffset ||
    options.audioEndByteOffset > options.sourceSize
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 admitted-manifest terminal endpoint contradicts its retained terminal anchor or EOF',
    );
  }

  return Object.freeze({
    tagDeclaration,
    verifiedPrefixFrameCount,
    verifiedPrefixByteEnd,
    terminalFrameOrdinal,
    terminalFrameByteOffset,
    terminalFrameByteLength,
    terminalMainDataCapacityBytes,
    terminalMainDataBeginBytes,
  });
}

/**
 * Snapshot and validate decoder timeline planning data without reading its
 * encoded source. The result is detached and deeply immutable.
 */
export function createMp3DecoderTimelineEvidence(
  value: unknown,
): Readonly<Mp3DecoderTimelineEvidence> {
  const record = exactDataRecord(value, EVIDENCE_KEYS, 'MP3 decoder timeline evidence');
  if (record.format !== 'mp3-decoder-timeline') {
    throw new TypeError('MP3 decoder timeline evidence format is invalid');
  }
  if (record.authority !== 'none') {
    throw new TypeError('MP3 decoder timeline evidence cannot grant admission authority');
  }
  if (record.provenanceKind !== 'scanner' && record.provenanceKind !== 'admitted-manifest') {
    throw new TypeError('MP3 decoder timeline evidence provenance is invalid');
  }
  if (!isEncodedAudioSourceIdentity(record.sourceIdentity)) {
    throw new TypeError('MP3 decoder timeline evidence source identity is invalid');
  }
  const sourceSize = safeInteger(record.sourceSize, 'MP3 evidence source size', 1);
  const sampleRateHz = safeInteger(record.sampleRateHz, 'MP3 evidence sample rate', 1);
  const rawSamplesPerFrame = safeInteger(
    record.samplesPerFrame,
    'MP3 evidence samples per frame',
    576,
    1_152,
  );
  const fixed = versionGeometry(record.version, sampleRateHz, rawSamplesPerFrame);
  if (record.channels !== 1 && record.channels !== 2) {
    throw new RangeError('MP3 decoder timeline evidence channels must be one or two');
  }
  const firstAudioFrameOffset = safeInteger(
    record.firstAudioFrameOffset,
    'MP3 evidence first audio offset',
    0,
  );
  const audioEndByteOffset = safeInteger(
    record.audioEndByteOffset,
    'MP3 evidence audio end',
    1,
    sourceSize,
  );
  const audioFrameCount = safeInteger(record.audioFrameCount, 'MP3 evidence frame count', 1);
  if (firstAudioFrameOffset >= audioEndByteOffset) {
    throw new Mp3DecoderTimelineEvidenceError('MP3 evidence audio span must be non-empty');
  }
  const audioBytes = audioEndByteOffset - firstAudioFrameOffset;
  if (
    !spanCanContainFrames(audioBytes, audioFrameCount, minimumFrameBytes(fixed.samplesPerFrame))
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 evidence audio span contradicts its frame count',
    );
  }
  const totalRawSamples = safeMultiply(
    audioFrameCount,
    fixed.samplesPerFrame,
    'MP3 evidence total raw samples',
  );
  if (
    record.frameCountEvidence !== 'verified-scan' &&
    record.frameCountEvidence !== 'xing' &&
    record.frameCountEvidence !== 'info' &&
    record.frameCountEvidence !== 'vbri' &&
    record.frameCountEvidence !== 'admitted-manifest'
  ) {
    throw new TypeError('MP3 decoder frame-count evidence is invalid');
  }
  if (typeof record.fullyVerifiedFrameSpan !== 'boolean') {
    throw new TypeError('MP3 decoder fully-verified flag must be boolean');
  }
  if (record.provenanceKind === 'scanner') {
    if (
      record.frameCountEvidence === 'admitted-manifest' ||
      (record.frameCountEvidence === 'verified-scan') !== record.fullyVerifiedFrameSpan ||
      record.manifestEndpointEvidence !== null
    ) {
      throw new Mp3DecoderTimelineEvidenceError(
        'MP3 scanner provenance contradicts its frame-count or endpoint evidence',
      );
    }
  } else if (
    record.frameCountEvidence !== 'admitted-manifest' ||
    record.fullyVerifiedFrameSpan ||
    record.manifestEndpointEvidence === null
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 admitted-manifest provenance requires non-authoritative endpoint evidence',
    );
  }
  const tagFrame = canonicalTagFrame(
    record.tagFrame,
    firstAudioFrameOffset,
    audioEndByteOffset,
    audioFrameCount,
    totalRawSamples,
    fixed.samplesPerFrame,
  );
  if (
    record.provenanceKind === 'scanner' &&
    record.frameCountEvidence !== 'verified-scan' &&
    (tagFrame?.declaration.kind !== record.frameCountEvidence ||
      tagFrame.declaration.frameCount !== audioFrameCount)
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 declared frame-count evidence lacks its matching tag declaration',
    );
  }
  const timeline = canonicalTimeline(
    record.timeline,
    totalRawSamples,
    fixed.samplesPerFrame,
    tagFrame?.declaration.gapless ?? null,
  );
  const verifiedAudioFrameCount = safeInteger(
    record.verifiedAudioFrameCount,
    'MP3 verified audio frame count',
    1,
    audioFrameCount,
  );
  const verifiedAudioBytes = safeInteger(
    record.verifiedAudioBytes,
    'MP3 verified audio bytes',
    1,
    audioBytes,
  );
  if (
    record.fullyVerifiedFrameSpan &&
    (verifiedAudioFrameCount !== audioFrameCount || verifiedAudioBytes !== audioBytes)
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 fully verified evidence must cover the complete audio span',
    );
  }
  const verifiedAudioEnd = safeAdd(
    firstAudioFrameOffset,
    verifiedAudioBytes,
    'MP3 verified audio end',
  );
  const remainingVerifiedFrames = audioFrameCount - verifiedAudioFrameCount;
  const remainingVerifiedBytes = audioBytes - verifiedAudioBytes;
  if (
    verifiedAudioEnd > audioEndByteOffset ||
    !spanCanContainFrames(
      verifiedAudioBytes,
      verifiedAudioFrameCount,
      minimumFrameBytes(fixed.samplesPerFrame),
    ) ||
    !spanCanContainFrames(
      remainingVerifiedBytes,
      remainingVerifiedFrames,
      minimumFrameBytes(fixed.samplesPerFrame),
    )
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 verified prefix contradicts the declared audio geometry',
    );
  }

  const rawPoints = denseDataArray(record.seekPoints, 'MP3 decoder seek points');
  const points = rawPoints.map((point, index) =>
    canonicalSeekPoint(point, index, fixed.samplesPerFrame),
  );
  const origin = points[0];
  if (!origin) throw new Mp3DecoderTimelineEvidenceError('MP3 evidence lost its seek origin');
  if (
    origin.rawSample !== 0 ||
    origin.frameOrdinal !== 0 ||
    origin.byteOffset !== firstAudioFrameOffset ||
    origin.mainDataBeginBytes !== 0
  ) {
    throw new Mp3DecoderTimelineEvidenceError('MP3 evidence seek index has an invalid origin');
  }
  if (
    record.provenanceKind === 'scanner' &&
    points.some(
      (point) =>
        point.frameOrdinal >= verifiedAudioFrameCount || point.byteOffset >= verifiedAudioEnd,
    )
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 evidence seek point exceeds its verified prefix',
    );
  }
  if (
    record.fullyVerifiedFrameSpan &&
    points[points.length - 1]?.frameOrdinal !== audioFrameCount - 1
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 fully verified evidence must retain its terminal audio frame point',
    );
  }
  const manifestEndpointEvidence =
    record.provenanceKind === 'admitted-manifest'
      ? canonicalManifestEndpointEvidence(record.manifestEndpointEvidence, {
          sourceSize,
          firstAudioFrameOffset,
          audioEndByteOffset,
          audioFrameCount,
          totalRawSamples,
          samplesPerFrame: fixed.samplesPerFrame,
          tagFrame,
          verifiedAudioFrameCount,
          verifiedAudioBytes,
          points,
        })
      : null;
  let index: MpegLayer3SeekIndex;
  try {
    index = new MpegLayer3SeekIndex({
      sourceSize,
      firstAudioFrameOffset,
      audioEndByteOffset,
      totalRawSamples,
      samplesPerFrame: fixed.samplesPerFrame,
      firstFrameMainDataCapacityBytes: origin.mainDataCapacityBytes,
      firstFrameMainDataBeginBytes: origin.mainDataBeginBytes,
      maxPoints: MP3_SEEK_INDEX_MAX_POINTS,
    });
    for (const point of points.slice(1)) {
      if (
        !index.addVerifiedFrame(
          point.rawSample,
          point.byteOffset,
          point.frameOrdinal,
          point.mainDataCapacityBytes,
          point.mainDataBeginBytes,
        )
      ) {
        throw new Mp3DecoderTimelineEvidenceError(
          'MP3 evidence seek point contradicts its source geometry',
        );
      }
    }
  } catch (error) {
    if (error instanceof Mp3DecoderTimelineEvidenceError) throw error;
    throw new Mp3DecoderTimelineEvidenceError('MP3 evidence seek index is invalid', error);
  }
  const seekPoints = index.snapshot();
  if (
    seekPoints.length !== points.length ||
    seekPoints.some((point, pointIndex) => !pointsEqual(point, points[pointIndex]!))
  ) {
    throw new Mp3DecoderTimelineEvidenceError(
      'MP3 evidence seek index did not reconstruct exactly',
    );
  }

  return Object.freeze({
    format: 'mp3-decoder-timeline' as const,
    authority: 'none' as const,
    provenanceKind: record.provenanceKind,
    sourceIdentity: record.sourceIdentity,
    sourceSize,
    version: fixed.version,
    sampleRateHz,
    channels: record.channels,
    samplesPerFrame: fixed.samplesPerFrame,
    firstAudioFrameOffset,
    audioEndByteOffset,
    audioFrameCount,
    tagFrame,
    frameCountEvidence: record.frameCountEvidence,
    fullyVerifiedFrameSpan: record.fullyVerifiedFrameSpan,
    verifiedAudioFrameCount,
    verifiedAudioBytes,
    timeline,
    manifestEndpointEvidence,
    seekPoints,
  });
}
