import { isEncodedAudioSourceIdentity } from '../sources/encoded-audio-source.ts';
import { adtsCoreSampleRateHzForIndex, type AdtsSampleRateIndex } from './adts-header.ts';
import type {
  AdtsManifestEndpointChecks,
  AdtsManifestStructuralReconstruction,
} from './adts-manifest-structural-reconstruction.ts';
import {
  ADTS_CORE_SAMPLES_PER_FRAME,
  isScannerIssuedAdtsFrameScanResult,
  type AdtsFrameScanResult,
} from './frame-scanner.ts';
import type { AdtsCoreConfiguration } from './incremental-frame-reader.ts';
import { ADTS_SEEK_INDEX_MAX_POINTS, type AdtsSeekIndexPoint } from './seek-index.ts';
import { createAdtsCoreTimeline, type AdtsCoreTimeline } from './timeline.ts';

const ADTS_MIN_ACCESS_UNIT_BYTES = 8;
const ADTS_MAX_ACCESS_UNIT_BYTES = 8_191;

const EVIDENCE_KEYS = Object.freeze([
  'format',
  'authority',
  'sourceIdentity',
  'sourceSize',
  'audioStartByte',
  'coreConfiguration',
  'coreSampleRateHz',
  'coreChannelCount',
  'samplesPerFrame',
  'frameCount',
  'audioEndByteOffset',
  'timeline',
  'seekPoints',
] as const satisfies readonly (keyof AdtsDecoderTimelineEvidence)[]);

const CORE_CONFIGURATION_KEYS = Object.freeze([
  'mpegId',
  'profile',
  'coreAudioObjectType',
  'sampleRateIndex',
  'channelConfiguration',
  'protectionAbsent',
  'rawDataBlocks',
] as const satisfies readonly (keyof AdtsCoreConfiguration)[]);

const TIMELINE_KEYS = Object.freeze([
  'frameCount',
  'coreFramesPerAccessUnit',
  'totalMediaFrames',
] as const satisfies readonly (keyof AdtsCoreTimeline)[]);

const SEEK_POINT_KEYS = Object.freeze([
  'frameOrdinal',
  'byteOffset',
] as const satisfies readonly (keyof AdtsSeekIndexPoint)[]);

const MANIFEST_RECONSTRUCTION_KEYS = Object.freeze([
  'evidenceKind',
  'authority',
  'sourceIdentity',
  'sourceSize',
  'audioStartByte',
  'coreConfiguration',
  'coreSampleRateHz',
  'coreChannelCount',
  'samplesPerFrame',
  'frameCount',
  'totalCoreSamples',
  'audioEndByteOffset',
  'seekPoints',
  'endpointChecks',
] as const satisfies readonly (keyof AdtsManifestStructuralReconstruction)[]);

const MANIFEST_ENDPOINT_KEYS = Object.freeze([
  'firstFrameByteLength',
  'terminalFrameOrdinal',
  'terminalFrameByteOffset',
  'terminalFrameByteLength',
] as const satisfies readonly (keyof AdtsManifestEndpointChecks)[]);

type StrictRecord = Readonly<Record<string, unknown>>;

/**
 * Source-bound ADTS geometry used only to plan decoder generations.
 *
 * `authority: 'none'` is deliberate: neither an exact local scan nor a future
 * admitted-manifest bridge transfers its scanner/sealer authority into this
 * detached value. The owner that supplies it must separately bind it to the
 * live admitted source. No encoded access-unit body is retained here.
 */
export interface AdtsDecoderTimelineEvidence {
  readonly format: 'adts-decoder-timeline';
  readonly authority: 'none';
  readonly sourceIdentity: string;
  readonly sourceSize: number;
  readonly audioStartByte: number;
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
  readonly coreSampleRateHz: number;
  readonly coreChannelCount: 1 | 2;
  readonly samplesPerFrame: typeof ADTS_CORE_SAMPLES_PER_FRAME;
  readonly frameCount: number;
  readonly audioEndByteOffset: number;
  readonly timeline: Readonly<AdtsCoreTimeline>;
  readonly seekPoints: readonly Readonly<AdtsSeekIndexPoint>[];
}

export class AdtsDecoderTimelineEvidenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AdtsDecoderTimelineEvidenceError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

function exactDataRecord(value: unknown, keys: readonly string[], label: string): StrictRecord {
  if (typeof value !== 'object' || value === null) {
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
    const expectedKeys = new Set<PropertyKey>(keys);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => !expectedKeys.has(key))) {
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
      length > ADTS_SEEK_INDEX_MAX_POINTS
    ) {
      throw new RangeError(`${label} must contain 1 through ${ADTS_SEEK_INDEX_MAX_POINTS} entries`);
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
    return Object.freeze(snapshot);
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
    throw new AdtsDecoderTimelineEvidenceError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AdtsDecoderTimelineEvidenceError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function spanCanContainAccessUnits(byteSpan: number, accessUnitCount: number): boolean {
  if (
    byteSpan < 0 ||
    accessUnitCount < 0 ||
    accessUnitCount > Math.floor(Number.MAX_SAFE_INTEGER / ADTS_MIN_ACCESS_UNIT_BYTES)
  ) {
    return false;
  }
  const minimumBytes = accessUnitCount * ADTS_MIN_ACCESS_UNIT_BYTES;
  if (byteSpan < minimumBytes) return false;
  return (
    accessUnitCount > Math.floor(Number.MAX_SAFE_INTEGER / ADTS_MAX_ACCESS_UNIT_BYTES) ||
    byteSpan <= accessUnitCount * ADTS_MAX_ACCESS_UNIT_BYTES
  );
}

function snapshotCoreConfiguration(value: unknown): Readonly<AdtsCoreConfiguration> {
  const record = exactDataRecord(
    value,
    CORE_CONFIGURATION_KEYS,
    'ADTS decoder evidence core configuration',
  );
  if (
    record.mpegId !== 0 ||
    record.profile !== 1 ||
    record.coreAudioObjectType !== 2 ||
    record.protectionAbsent !== true ||
    record.rawDataBlocks !== 1
  ) {
    throw new RangeError('ADTS decoder evidence must describe MPEG-4 AAC-LC without CRC');
  }
  const sampleRateIndex = safeInteger(
    record.sampleRateIndex,
    'ADTS decoder evidence sampleRateIndex',
    0,
    12,
  ) as AdtsSampleRateIndex;
  if (record.channelConfiguration !== 1 && record.channelConfiguration !== 2) {
    throw new RangeError('ADTS decoder evidence core configuration must be mono or stereo');
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

function snapshotTimeline(value: unknown, frameCount: number): Readonly<AdtsCoreTimeline> {
  const record = exactDataRecord(value, TIMELINE_KEYS, 'ADTS decoder evidence timeline');
  if (record.frameCount !== frameCount || record.coreFramesPerAccessUnit !== 1_024) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence timeline contradicts its access-unit geometry',
    );
  }
  const expectedTotalMediaFrames = safeMultiply(
    frameCount,
    ADTS_CORE_SAMPLES_PER_FRAME,
    'ADTS decoder evidence total media frames',
  );
  if (record.totalMediaFrames !== expectedTotalMediaFrames) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence timeline has an inconsistent media-frame total',
    );
  }
  return createAdtsCoreTimeline(frameCount);
}

interface EvidenceGeometry {
  readonly sourceSize: number;
  readonly audioStartByte: number;
  readonly frameCount: number;
}

function snapshotSeekPoint(
  value: unknown,
  geometry: EvidenceGeometry,
  index: number,
): Readonly<AdtsSeekIndexPoint> {
  const label = `ADTS decoder evidence seek point ${index}`;
  const record = exactDataRecord(value, SEEK_POINT_KEYS, label);
  const frameOrdinal = safeInteger(
    record.frameOrdinal,
    `${label} frameOrdinal`,
    0,
    geometry.frameCount - 1,
  );
  const byteOffset = safeInteger(
    record.byteOffset,
    `${label} byteOffset`,
    geometry.audioStartByte,
    geometry.sourceSize - 1,
  );
  if (
    !spanCanContainAccessUnits(byteOffset - geometry.audioStartByte, frameOrdinal) ||
    !spanCanContainAccessUnits(geometry.sourceSize - byteOffset, geometry.frameCount - frameOrdinal)
  ) {
    throw new AdtsDecoderTimelineEvidenceError(
      `${label} contradicts the declared ADTS access-unit geometry`,
    );
  }
  return Object.freeze({ frameOrdinal, byteOffset });
}

function snapshotSeekPoints(
  value: unknown,
  geometry: EvidenceGeometry,
): readonly Readonly<AdtsSeekIndexPoint>[] {
  const values = denseDataArray(value, 'ADTS decoder evidence seek points');
  if (values.length > geometry.frameCount) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence retains more anchors than declared access units',
    );
  }

  const points: Readonly<AdtsSeekIndexPoint>[] = [];
  for (let index = 0; index < values.length; index += 1) {
    points.push(snapshotSeekPoint(values[index], geometry, index));
  }
  const origin = points[0];
  if (!origin || origin.frameOrdinal !== 0 || origin.byteOffset !== geometry.audioStartByte) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence must retain its exact audio origin',
    );
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !previous ||
      !current ||
      current.frameOrdinal <= previous.frameOrdinal ||
      current.byteOffset <= previous.byteOffset ||
      !spanCanContainAccessUnits(
        current.byteOffset - previous.byteOffset,
        current.frameOrdinal - previous.frameOrdinal,
      )
    ) {
      throw new AdtsDecoderTimelineEvidenceError(
        'ADTS decoder evidence seek anchors must be strictly monotonic exact boundaries',
      );
    }
  }
  const terminal = points[points.length - 1];
  if (!terminal || terminal.frameOrdinal !== geometry.frameCount - 1) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence must retain its terminal access-unit boundary',
    );
  }
  return Object.freeze(points);
}

/** Canonicalize and deeply detach decoder-only ADTS timeline evidence. */
export function createAdtsDecoderTimelineEvidence(
  value: unknown,
): Readonly<AdtsDecoderTimelineEvidence> {
  const record = exactDataRecord(value, EVIDENCE_KEYS, 'ADTS decoder timeline evidence');
  if (record.format !== 'adts-decoder-timeline' || record.authority !== 'none') {
    throw new TypeError('ADTS decoder timeline evidence format or authority is invalid');
  }
  if (!isEncodedAudioSourceIdentity(record.sourceIdentity)) {
    throw new TypeError('ADTS decoder timeline evidence source identity is invalid');
  }
  const sourceSize = safeInteger(
    record.sourceSize,
    'ADTS decoder timeline evidence sourceSize',
    ADTS_MIN_ACCESS_UNIT_BYTES,
  );
  const audioStartByte = safeInteger(
    record.audioStartByte,
    'ADTS decoder timeline evidence audioStartByte',
    0,
    sourceSize - ADTS_MIN_ACCESS_UNIT_BYTES,
  );
  const frameCount = safeInteger(record.frameCount, 'ADTS decoder timeline evidence frameCount', 1);
  if (!spanCanContainAccessUnits(sourceSize - audioStartByte, frameCount)) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence byte span contradicts its access-unit count',
    );
  }
  const audioEndByteOffset = safeInteger(
    record.audioEndByteOffset,
    'ADTS decoder timeline evidence audioEndByteOffset',
    ADTS_MIN_ACCESS_UNIT_BYTES,
    sourceSize,
  );
  if (audioEndByteOffset !== sourceSize) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence audio span must reach physical EOF',
    );
  }
  if (record.samplesPerFrame !== ADTS_CORE_SAMPLES_PER_FRAME) {
    throw new RangeError('ADTS decoder evidence samplesPerFrame must be exactly 1024');
  }

  const coreConfiguration = snapshotCoreConfiguration(record.coreConfiguration);
  const coreSampleRateHz = safeInteger(
    record.coreSampleRateHz,
    'ADTS decoder timeline evidence coreSampleRateHz',
    1,
  );
  if (record.coreChannelCount !== 1 && record.coreChannelCount !== 2) {
    throw new RangeError('ADTS decoder evidence coreChannelCount must be mono or stereo');
  }
  if (
    adtsCoreSampleRateHzForIndex(coreConfiguration.sampleRateIndex) !== coreSampleRateHz ||
    coreConfiguration.channelConfiguration !== record.coreChannelCount
  ) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS decoder evidence rate or channel geometry contradicts its core configuration',
    );
  }

  const timeline = snapshotTimeline(record.timeline, frameCount);
  const seekPoints = snapshotSeekPoints(record.seekPoints, {
    sourceSize,
    audioStartByte,
    frameCount,
  });
  return Object.freeze({
    format: 'adts-decoder-timeline',
    authority: 'none',
    sourceIdentity: record.sourceIdentity,
    sourceSize,
    audioStartByte,
    coreConfiguration,
    coreSampleRateHz,
    coreChannelCount: record.coreChannelCount,
    samplesPerFrame: ADTS_CORE_SAMPLES_PER_FRAME,
    frameCount,
    audioEndByteOffset,
    timeline,
    seekPoints,
  });
}

/**
 * Convert the exact same-realm result of `scanAdtsFrames` without reading the
 * source again. Clones and deserialized lookalikes cannot cross this boundary.
 */
export function createAdtsDecoderTimelineEvidenceFromScanResult(
  scan: Readonly<AdtsFrameScanResult>,
): Readonly<AdtsDecoderTimelineEvidence> {
  if (!isScannerIssuedAdtsFrameScanResult(scan)) {
    throw new TypeError('ADTS timeline evidence requires the exact scanner-issued result');
  }
  return createAdtsDecoderTimelineEvidence({
    format: 'adts-decoder-timeline',
    authority: 'none',
    sourceIdentity: scan.sourceIdentity,
    sourceSize: scan.sourceSize,
    audioStartByte: scan.audioStartByte,
    coreConfiguration: scan.coreConfiguration,
    coreSampleRateHz: scan.coreSampleRateHz,
    coreChannelCount: scan.coreChannelCount,
    samplesPerFrame: scan.samplesPerFrame,
    frameCount: scan.frameCount,
    audioEndByteOffset: scan.audioEndByteOffset,
    timeline: createAdtsCoreTimeline(scan.frameCount),
    seekPoints: scan.seekPoints,
  });
}

/**
 * Convert bounded endpoint reconstruction into detached decoder planning data.
 *
 * The reconstruction and returned evidence both carry `authority: 'none'`.
 * A caller must first own the exact live manifest admission and registry lease;
 * this helper deliberately cannot mint, retain, or substitute that authority.
 */
export function createAdtsDecoderTimelineEvidenceFromManifestReconstruction(
  value: Readonly<AdtsManifestStructuralReconstruction>,
): Readonly<AdtsDecoderTimelineEvidence> {
  const record = exactDataRecord(
    value,
    MANIFEST_RECONSTRUCTION_KEYS,
    'ADTS manifest structural reconstruction',
  );
  if (
    record.evidenceKind !== 'adts-manifest-structural-reconstruction' ||
    record.authority !== 'none'
  ) {
    throw new TypeError('ADTS manifest structural reconstruction kind or authority is invalid');
  }

  const evidence = createAdtsDecoderTimelineEvidence({
    format: 'adts-decoder-timeline',
    authority: 'none',
    sourceIdentity: record.sourceIdentity,
    sourceSize: record.sourceSize,
    audioStartByte: record.audioStartByte,
    coreConfiguration: record.coreConfiguration,
    coreSampleRateHz: record.coreSampleRateHz,
    coreChannelCount: record.coreChannelCount,
    samplesPerFrame: record.samplesPerFrame,
    frameCount: record.frameCount,
    audioEndByteOffset: record.audioEndByteOffset,
    timeline: createAdtsCoreTimeline(
      safeInteger(record.frameCount, 'ADTS manifest reconstruction frameCount', 1),
    ),
    seekPoints: record.seekPoints,
  });
  const totalCoreSamples = safeInteger(
    record.totalCoreSamples,
    'ADTS manifest reconstruction totalCoreSamples',
    ADTS_CORE_SAMPLES_PER_FRAME,
  );
  if (totalCoreSamples !== evidence.timeline.totalMediaFrames) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS manifest reconstruction sample total contradicts its frame count',
    );
  }

  const endpoints = exactDataRecord(
    record.endpointChecks,
    MANIFEST_ENDPOINT_KEYS,
    'ADTS manifest reconstruction endpoint checks',
  );
  const firstFrameByteLength = safeInteger(
    endpoints.firstFrameByteLength,
    'ADTS manifest reconstruction first frame length',
    ADTS_MIN_ACCESS_UNIT_BYTES,
    ADTS_MAX_ACCESS_UNIT_BYTES,
  );
  const terminalFrameOrdinal = safeInteger(
    endpoints.terminalFrameOrdinal,
    'ADTS manifest reconstruction terminal frame ordinal',
    0,
    evidence.frameCount - 1,
  );
  const terminalFrameByteOffset = safeInteger(
    endpoints.terminalFrameByteOffset,
    'ADTS manifest reconstruction terminal frame offset',
    0,
    evidence.sourceSize - 1,
  );
  const terminalFrameByteLength = safeInteger(
    endpoints.terminalFrameByteLength,
    'ADTS manifest reconstruction terminal frame length',
    ADTS_MIN_ACCESS_UNIT_BYTES,
    ADTS_MAX_ACCESS_UNIT_BYTES,
  );
  const terminalPoint = evidence.seekPoints[evidence.seekPoints.length - 1];
  if (
    !terminalPoint ||
    terminalFrameOrdinal !== evidence.frameCount - 1 ||
    terminalFrameOrdinal !== terminalPoint.frameOrdinal ||
    terminalFrameByteOffset !== terminalPoint.byteOffset ||
    safeAdd(
      terminalFrameByteOffset,
      terminalFrameByteLength,
      'ADTS manifest reconstruction terminal frame end',
    ) !== evidence.audioEndByteOffset
  ) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS manifest reconstruction terminal endpoint contradicts its timeline or EOF',
    );
  }
  const secondPoint = evidence.seekPoints.find((point) => point.frameOrdinal === 1);
  if (
    (evidence.frameCount === 1 &&
      (terminalFrameByteOffset !== evidence.audioStartByte ||
        firstFrameByteLength !== terminalFrameByteLength)) ||
    (evidence.frameCount > 1 &&
      evidence.audioStartByte + firstFrameByteLength > terminalFrameByteOffset) ||
    (secondPoint !== undefined &&
      secondPoint.byteOffset !== evidence.audioStartByte + firstFrameByteLength)
  ) {
    throw new AdtsDecoderTimelineEvidenceError(
      'ADTS manifest reconstruction first endpoint contradicts its retained timeline',
    );
  }
  return evidence;
}
