import { isEncodedAudioSourceIdentity } from '../sources/encoded-audio-source.ts';
import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.ts';
import {
  AAC_CORE_CONFIGURATION_KEYS,
  AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS,
  createAacDecoderStartPlan,
  snapshotAacDecoderDescriptor,
  type AacDecoderDescriptor,
} from './decoder-protocol.ts';
import {
  createAdtsDecoderTimelineEvidence,
  type AdtsDecoderTimelineEvidence,
} from './decoder-timeline-evidence.ts';
import { ADTS_CORE_SAMPLES_PER_FRAME, type AdtsFrameScanResult } from './frame-scanner.ts';
import { adtsCoreSampleRateHzForIndex, type AdtsSampleRateIndex } from './adts-header.ts';
import type { AdtsCoreConfiguration } from './incremental-frame-reader.ts';
import { ADTS_SEEK_INDEX_MAX_POINTS, type AdtsSeekIndexPoint } from './seek-index.ts';
import { createAdtsCoreTimeline, type AdtsCoreTimeline } from './timeline.ts';

/** Initial transform-continuity policy; the wire protocol permits 0..8 AUs. */
export const AAC_DECODER_DEFAULT_TRANSFORM_PREROLL_ACCESS_UNITS = 1;

const ADTS_MIN_ACCESS_UNIT_BYTES = 8;
const ADTS_MAX_ACCESS_UNIT_BYTES = 8_191;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const SCAN_RESULT_KEYS = [
  'sourceIdentity',
  'sourceSize',
  'coreConfiguration',
  'coreSampleRateHz',
  'coreChannelCount',
  'samplesPerFrame',
  'frameCount',
  'totalCoreSamples',
  'audioEndByteOffset',
  'seekPoints',
  'fullyVerifiedFrameSpan',
] as const satisfies readonly (keyof AdtsFrameScanResult)[];

const SEEK_POINT_KEYS = [
  'frameOrdinal',
  'byteOffset',
] as const satisfies readonly (keyof AdtsSeekIndexPoint)[];

const CREATE_DESCRIPTOR_REQUIRED_KEYS = ['scan', 'outputSampleRateHz', 'mediaFrame'] as const;
const CREATE_DESCRIPTOR_OPTION_KEYS = [
  ...CREATE_DESCRIPTOR_REQUIRED_KEYS,
  'prerollAccessUnits',
] as const;
const CREATE_TIMELINE_DESCRIPTOR_REQUIRED_KEYS = [
  'timelineEvidence',
  'outputSampleRateHz',
  'mediaFrame',
] as const;
const CREATE_TIMELINE_DESCRIPTOR_OPTION_KEYS = [
  ...CREATE_TIMELINE_DESCRIPTOR_REQUIRED_KEYS,
  'prerollAccessUnits',
] as const;

type StrictRecord = Readonly<Record<string, unknown>>;

export interface AacDecoderPlanningState {
  /** Detached scanner evidence; contains metadata and coordinates, never encoded bodies. */
  readonly scan: Readonly<AdtsFrameScanResult>;
  readonly timeline: Readonly<AdtsCoreTimeline>;
  readonly seekPoints: readonly Readonly<AdtsSeekIndexPoint>[];
}

export interface AacDecoderTimelinePlanningState {
  /** Detached planning data with no scanner or manifest-sealer authority. */
  readonly evidence: Readonly<AdtsDecoderTimelineEvidence>;
  readonly timeline: Readonly<AdtsCoreTimeline>;
  readonly seekPoints: readonly Readonly<AdtsSeekIndexPoint>[];
}

export interface CreateAacDecoderDescriptorOptions {
  readonly scan: Readonly<AdtsFrameScanResult>;
  readonly outputSampleRateHz: number;
  /** Exact media/core coordinate. Exclusive EOF cannot open a fresh generation. */
  readonly mediaFrame: number;
  /** Defaults to one AU and may not exceed the protocol's bounded ceiling. */
  readonly prerollAccessUnits?: number;
}

export interface CreateAacDecoderDescriptorFromTimelineEvidenceOptions {
  readonly timelineEvidence: Readonly<AdtsDecoderTimelineEvidence>;
  readonly outputSampleRateHz: number;
  /** Exact media/core coordinate. Exclusive EOF cannot open a fresh generation. */
  readonly mediaFrame: number;
  /** Defaults to one AU and may not exceed the protocol's bounded ceiling. */
  readonly prerollAccessUnits?: number;
}

export class AacDecoderHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AacDecoderHelperError';
  }
}

/**
 * Capture one exact data-only record in one reflection pass.
 *
 * Accessors are never invoked. Proxy traps may re-enter while the descriptor
 * map is created, but every later decision uses only this detached snapshot.
 */
function snapshotRecord(value: unknown): StrictRecord | null {
  if (typeof value !== 'object' || value === null) return null;

  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== null && prototype !== Object.prototype) return null;

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || Object.hasOwn(snapshot, key)) return null;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function requireExactRecord(value: unknown, keys: readonly string[], label: string): StrictRecord {
  const record = snapshotRecord(value);
  if (
    !record ||
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  ) {
    throw new TypeError(`${label} must be a canonical exact-key record`);
  }
  return record;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = BigInt(left) * BigInt(right);
  if (result < 0n || result > MAX_SAFE_BIGINT) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(result);
}

function spanCanContainAccessUnits(byteSpan: number, accessUnitCount: number): boolean {
  if (
    !Number.isSafeInteger(byteSpan) ||
    byteSpan < 0 ||
    !Number.isSafeInteger(accessUnitCount) ||
    accessUnitCount < 0
  ) {
    return false;
  }
  const span = BigInt(byteSpan);
  const count = BigInt(accessUnitCount);
  return (
    span >= count * BigInt(ADTS_MIN_ACCESS_UNIT_BYTES) &&
    span <= count * BigInt(ADTS_MAX_ACCESS_UNIT_BYTES)
  );
}

function snapshotBoundedDenseArray(
  value: unknown,
  label: string,
  maximumLength: number,
): readonly unknown[] {
  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    if (!isArray || typeof value !== 'object' || value === null) {
      throw new TypeError(`${label} must be an array`);
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
  } catch (error) {
    if (error instanceof TypeError && error.message === `${label} must be an array`) throw error;
    throw new TypeError(`${label} could not be snapshotted safely`, { cause: error });
  }
  if (prototype !== Array.prototype) {
    throw new TypeError(`${label} must use the intrinsic Array prototype`);
  }

  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > maximumLength
  ) {
    throw new RangeError(`${label} must contain from 1 through ${maximumLength} entries`);
  }

  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' &&
          (!/^(0|[1-9]\d*)$/.test(key) ||
            Number(key) >= length ||
            !Number.isSafeInteger(Number(key)))),
    )
  ) {
    throw new TypeError(`${label} must be a dense array without extra properties`);
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain only enumerable data properties`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function snapshotCoreConfiguration(value: unknown): Readonly<AdtsCoreConfiguration> {
  const record = requireExactRecord(
    value,
    AAC_CORE_CONFIGURATION_KEYS,
    'AAC scan core configuration',
  );
  if (
    record.mpegId !== 0 ||
    record.profile !== 1 ||
    record.coreAudioObjectType !== 2 ||
    record.protectionAbsent !== true ||
    record.rawDataBlocks !== 1
  ) {
    throw new RangeError('AAC scan must describe MPEG-4 AAC-LC without CRC');
  }
  requireSafeInteger(record.sampleRateIndex, 'AAC scan sampleRateIndex', 0, 12);
  if (record.channelConfiguration !== 1 && record.channelConfiguration !== 2) {
    throw new RangeError('AAC scan core configuration must be mono or stereo');
  }
  return Object.freeze({
    mpegId: 0,
    profile: 1,
    coreAudioObjectType: 2,
    sampleRateIndex: record.sampleRateIndex as AdtsSampleRateIndex,
    channelConfiguration: record.channelConfiguration,
    protectionAbsent: true,
    rawDataBlocks: 1,
  });
}

interface ScanGeometry {
  readonly sourceSize: number;
  readonly frameCount: number;
}

function snapshotSeekPoint(
  value: unknown,
  geometry: ScanGeometry,
  label: string,
): Readonly<AdtsSeekIndexPoint> {
  const record = requireExactRecord(value, SEEK_POINT_KEYS, label);
  requireSafeInteger(record.frameOrdinal, `${label} frameOrdinal`, 0, geometry.frameCount - 1);
  requireSafeInteger(record.byteOffset, `${label} byteOffset`, 0, geometry.sourceSize - 1);
  if (
    !spanCanContainAccessUnits(record.byteOffset, record.frameOrdinal) ||
    !spanCanContainAccessUnits(
      geometry.sourceSize - record.byteOffset,
      geometry.frameCount - record.frameOrdinal,
    )
  ) {
    throw new AacDecoderHelperError(`${label} contradicts the verified ADTS frame geometry`);
  }
  return Object.freeze({
    frameOrdinal: record.frameOrdinal,
    byteOffset: record.byteOffset,
  });
}

function snapshotSeekPoints(
  value: unknown,
  geometry: ScanGeometry,
): readonly Readonly<AdtsSeekIndexPoint>[] {
  const values = snapshotBoundedDenseArray(
    value,
    'AAC scan seek points',
    ADTS_SEEK_INDEX_MAX_POINTS,
  );
  if (values.length > geometry.frameCount) {
    throw new AacDecoderHelperError('AAC scan retains more seek points than verified frames');
  }

  const points = values.map((point, index) =>
    snapshotSeekPoint(point, geometry, `AAC scan seek point ${index}`),
  );
  const origin = points[0];
  if (!origin || origin.frameOrdinal !== 0 || origin.byteOffset !== 0) {
    throw new AacDecoderHelperError('AAC scan seek index must retain the physical frame origin');
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !previous ||
      !current ||
      current.frameOrdinal <= previous.frameOrdinal ||
      current.byteOffset <= previous.byteOffset
    ) {
      throw new AacDecoderHelperError(
        'AAC scan seek points must be strictly monotonic without duplicates',
      );
    }
    if (
      !spanCanContainAccessUnits(
        current.byteOffset - previous.byteOffset,
        current.frameOrdinal - previous.frameOrdinal,
      )
    ) {
      throw new AacDecoderHelperError('AAC scan seek-point span contradicts its frame ordinals');
    }
  }
  const terminal = points.at(-1);
  if (!terminal || terminal.frameOrdinal !== geometry.frameCount - 1) {
    throw new AacDecoderHelperError('AAC scan seek index must retain its terminal frame boundary');
  }
  return Object.freeze(points);
}

function snapshotScanResult(value: unknown): Readonly<AdtsFrameScanResult> {
  const record = requireExactRecord(value, SCAN_RESULT_KEYS, 'AAC frame scan result');
  if (record.fullyVerifiedFrameSpan !== true) {
    throw new AacDecoderHelperError('AAC frame scan must verify the complete physical frame span');
  }
  if (!isEncodedAudioSourceIdentity(record.sourceIdentity)) {
    throw new TypeError('AAC frame scan source identity is invalid');
  }
  requireSafeInteger(record.sourceSize, 'AAC frame scan sourceSize', ADTS_MIN_ACCESS_UNIT_BYTES);
  requireSafeInteger(record.frameCount, 'AAC frame scan frameCount', 1);
  requireSafeInteger(record.totalCoreSamples, 'AAC frame scan totalCoreSamples', 1);
  requireSafeInteger(
    record.audioEndByteOffset,
    'AAC frame scan audioEndByteOffset',
    ADTS_MIN_ACCESS_UNIT_BYTES,
    record.sourceSize,
  );
  if (record.audioEndByteOffset !== record.sourceSize) {
    throw new AacDecoderHelperError('AAC verified audio span must reach physical EOF');
  }
  if (!spanCanContainAccessUnits(record.sourceSize, record.frameCount)) {
    throw new AacDecoderHelperError('AAC source byte span contradicts its verified frame count');
  }
  if (record.samplesPerFrame !== ADTS_CORE_SAMPLES_PER_FRAME) {
    throw new RangeError('AAC scan samplesPerFrame must be exactly 1024');
  }
  const expectedTotalCoreSamples = safeMultiply(
    record.frameCount,
    ADTS_CORE_SAMPLES_PER_FRAME,
    'AAC scan total core samples',
  );
  if (record.totalCoreSamples !== expectedTotalCoreSamples) {
    throw new AacDecoderHelperError('AAC scan total core samples contradict its frame count');
  }

  const coreConfiguration = snapshotCoreConfiguration(record.coreConfiguration);
  requireSafeInteger(record.coreSampleRateHz, 'AAC frame scan coreSampleRateHz', 1);
  if (record.coreChannelCount !== 1 && record.coreChannelCount !== 2) {
    throw new RangeError('AAC frame scan coreChannelCount must be mono or stereo');
  }
  if (
    adtsCoreSampleRateHzForIndex(coreConfiguration.sampleRateIndex) !== record.coreSampleRateHz ||
    coreConfiguration.channelConfiguration !== record.coreChannelCount
  ) {
    throw new AacDecoderHelperError(
      'AAC frame scan rate or channel geometry contradicts its core configuration',
    );
  }

  const seekPoints = snapshotSeekPoints(record.seekPoints, {
    sourceSize: record.sourceSize,
    frameCount: record.frameCount,
  });
  return Object.freeze({
    sourceIdentity: record.sourceIdentity,
    sourceSize: record.sourceSize,
    coreConfiguration,
    coreSampleRateHz: record.coreSampleRateHz,
    coreChannelCount: record.coreChannelCount,
    samplesPerFrame: ADTS_CORE_SAMPLES_PER_FRAME,
    frameCount: record.frameCount,
    totalCoreSamples: record.totalCoreSamples,
    audioEndByteOffset: record.audioEndByteOffset,
    seekPoints,
    fullyVerifiedFrameSpan: true,
  });
}

/**
 * Rebuild detached decoder-planning evidence from the same-realm full scanner.
 * Retained work is capped at the scanner's 8,192-point contract; arbitrary
 * Proxy reflection itself is not treated as a network or Worker trust boundary.
 */
export function rebuildAacDecoderPlanningState(
  scanValue: AdtsFrameScanResult,
): Readonly<AacDecoderPlanningState> {
  const scan = snapshotScanResult(scanValue);
  const timeline = createAdtsCoreTimeline(scan.frameCount);
  if (timeline.totalMediaFrames !== scan.totalCoreSamples) {
    throw new AacDecoderHelperError('AAC scanner and timeline core totals disagree');
  }
  return Object.freeze({
    scan,
    timeline,
    seekPoints: scan.seekPoints,
  });
}

/** Rebuild decoder planning from normalized, externally admitted ADTS evidence. */
export function rebuildAacDecoderTimelinePlanningState(
  evidenceValue: Readonly<AdtsDecoderTimelineEvidence>,
): Readonly<AacDecoderTimelinePlanningState> {
  const evidence = createAdtsDecoderTimelineEvidence(evidenceValue);
  return Object.freeze({
    evidence,
    timeline: evidence.timeline,
    seekPoints: evidence.seekPoints,
  });
}

interface DescriptorOptionsSnapshot {
  readonly planningEvidence: unknown;
  readonly outputSampleRateHz: number;
  readonly mediaFrame: number;
  readonly prerollAccessUnits: number;
}

function snapshotDescriptorOptions(
  value: unknown,
  evidenceKey: 'scan' | 'timelineEvidence',
): DescriptorOptionsSnapshot {
  const record = snapshotRecord(value);
  const requiredKeys =
    evidenceKey === 'scan'
      ? CREATE_DESCRIPTOR_REQUIRED_KEYS
      : CREATE_TIMELINE_DESCRIPTOR_REQUIRED_KEYS;
  const optionKeys =
    evidenceKey === 'scan' ? CREATE_DESCRIPTOR_OPTION_KEYS : CREATE_TIMELINE_DESCRIPTOR_OPTION_KEYS;
  const optionKeySet: ReadonlySet<string> = new Set(optionKeys);
  if (
    !record ||
    Object.keys(record).some((key) => !optionKeySet.has(key)) ||
    !requiredKeys.every((key) => Object.hasOwn(record, key))
  ) {
    throw new TypeError('AAC decoder descriptor options must be an exact data-only record');
  }
  requireSafeInteger(
    record.outputSampleRateHz,
    'AAC outputSampleRateHz',
    1,
    AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  );
  requireSafeInteger(record.mediaFrame, 'AAC target mediaFrame', 0);
  const prerollAccessUnits = Object.hasOwn(record, 'prerollAccessUnits')
    ? record.prerollAccessUnits
    : AAC_DECODER_DEFAULT_TRANSFORM_PREROLL_ACCESS_UNITS;
  requireSafeInteger(
    prerollAccessUnits,
    'AAC prerollAccessUnits',
    0,
    AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS,
  );
  return Object.freeze({
    planningEvidence: record[evidenceKey],
    outputSampleRateHz: record.outputSampleRateHz,
    mediaFrame: record.mediaFrame,
    prerollAccessUnits,
  });
}

function floorSeekAnchor(
  points: readonly Readonly<AdtsSeekIndexPoint>[],
  decodeStartAccessUnitOrdinal: number,
): Readonly<AdtsSeekIndexPoint> {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const point = points[middle];
    if (point && point.frameOrdinal <= decodeStartAccessUnitOrdinal) low = middle + 1;
    else high = middle;
  }
  const anchor = points[Math.max(0, low - 1)];
  if (!anchor || anchor.frameOrdinal > decodeStartAccessUnitOrdinal) {
    throw new AacDecoderHelperError('AAC scan lacks a floor anchor for the selected decode start');
  }
  return anchor;
}

interface AacDecoderDescriptorPlanningView {
  readonly sourceIdentity: string;
  readonly sourceSize: number;
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
  readonly coreSampleRateHz: number;
  readonly coreChannelCount: 1 | 2;
  readonly frameCount: number;
  readonly audioEndByteOffset: number;
  readonly timeline: Readonly<AdtsCoreTimeline>;
  readonly seekPoints: readonly Readonly<AdtsSeekIndexPoint>[];
}

interface AacDecoderDescriptorTargetOptions {
  readonly outputSampleRateHz: number;
  readonly mediaFrame: number;
  readonly prerollAccessUnits: number;
}

function createDescriptorFromPlanningView(
  planning: AacDecoderDescriptorPlanningView,
  options: AacDecoderDescriptorTargetOptions,
): Readonly<AacDecoderDescriptor> {
  if (options.mediaFrame >= planning.timeline.totalMediaFrames) {
    throw new RangeError('AAC exclusive media EOF cannot create a decoder descriptor');
  }

  const targetAccessUnitOrdinal = Math.floor(options.mediaFrame / ADTS_CORE_SAMPLES_PER_FRAME);
  const decodeStartAccessUnitOrdinal = Math.max(
    targetAccessUnitOrdinal - options.prerollAccessUnits,
    0,
  );
  const anchor = floorSeekAnchor(planning.seekPoints, decodeStartAccessUnitOrdinal);
  const startPlan = createAacDecoderStartPlan(
    planning.timeline,
    options.mediaFrame,
    anchor,
    Object.freeze({ prerollAccessUnits: options.prerollAccessUnits }),
  );

  // Prove the complete resampled remainder fits every browser counter before
  // constructing a descriptor that could otherwise fail with a generic error.
  expectedLanczosOutputFrames({
    inputSampleRate: planning.coreSampleRateHz,
    outputSampleRate: options.outputSampleRateHz,
    totalSourceFrames: planning.timeline.totalMediaFrames,
    startSourceFrame: options.mediaFrame,
  });

  const descriptor: AacDecoderDescriptor = Object.freeze({
    format: 'aac-adts',
    sourceSize: planning.sourceSize,
    sourceIdentity: planning.sourceIdentity,
    coreConfiguration: planning.coreConfiguration,
    coreSampleRateHz: planning.coreSampleRateHz,
    outputSampleRateHz: options.outputSampleRateHz,
    channels: planning.coreChannelCount,
    frameCount: planning.frameCount,
    audioEndByteOffset: planning.audioEndByteOffset,
    timeline: planning.timeline,
    startPlan,
  });
  const snapshot = snapshotAacDecoderDescriptor(descriptor);
  if (!snapshot) throw new AacDecoderHelperError('AAC decoder descriptor failed validation');
  return snapshot;
}

/**
 * Create one fully validated, deeply detached descriptor for a fresh Worker.
 *
 * The floor anchor is selected for the bounded decode start, not for the later
 * media target. This remains correct when deterministic index compaction has
 * retained a target-near point that lies after the chosen transform preroll.
 */
export function createAacDecoderDescriptor(
  optionsValue: CreateAacDecoderDescriptorOptions,
): Readonly<AacDecoderDescriptor> {
  const options = snapshotDescriptorOptions(optionsValue, 'scan');
  const planning = rebuildAacDecoderPlanningState(options.planningEvidence as AdtsFrameScanResult);
  return createDescriptorFromPlanningView(
    {
      sourceIdentity: planning.scan.sourceIdentity,
      sourceSize: planning.scan.sourceSize,
      coreConfiguration: planning.scan.coreConfiguration,
      coreSampleRateHz: planning.scan.coreSampleRateHz,
      coreChannelCount: planning.scan.coreChannelCount,
      frameCount: planning.scan.frameCount,
      audioEndByteOffset: planning.scan.audioEndByteOffset,
      timeline: planning.timeline,
      seekPoints: planning.seekPoints,
    },
    options,
  );
}

/** Create the same canonical descriptor from normalized decoder-only evidence. */
export function createAacDecoderDescriptorFromTimelineEvidence(
  optionsValue: CreateAacDecoderDescriptorFromTimelineEvidenceOptions,
): Readonly<AacDecoderDescriptor> {
  const options = snapshotDescriptorOptions(optionsValue, 'timelineEvidence');
  const planning = rebuildAacDecoderTimelinePlanningState(
    options.planningEvidence as AdtsDecoderTimelineEvidence,
  );
  return createDescriptorFromPlanningView(
    {
      sourceIdentity: planning.evidence.sourceIdentity,
      sourceSize: planning.evidence.sourceSize,
      coreConfiguration: planning.evidence.coreConfiguration,
      coreSampleRateHz: planning.evidence.coreSampleRateHz,
      coreChannelCount: planning.evidence.coreChannelCount,
      frameCount: planning.evidence.frameCount,
      audioEndByteOffset: planning.evidence.audioEndByteOffset,
      timeline: planning.timeline,
      seekPoints: planning.seekPoints,
    },
    options,
  );
}

function requireDescriptor(value: unknown): Readonly<AacDecoderDescriptor> {
  const descriptor = snapshotAacDecoderDescriptor(value);
  if (!descriptor) throw new TypeError('A valid AAC decoder descriptor is required');
  return descriptor;
}

/** Exact core-rate frames after the media target; preroll is deliberately excluded. */
export function remainingAacCoreFrames(descriptorValue: AacDecoderDescriptor): number {
  const descriptor = requireDescriptor(descriptorValue);
  return descriptor.timeline.totalMediaFrames - descriptor.startPlan.mediaFrame;
}

/** Exact pinned-Lanczos output length for the generation after target discard. */
export function expectedAacOutputFrames(descriptorValue: AacDecoderDescriptor): number {
  const descriptor = requireDescriptor(descriptorValue);
  if (descriptor.coreSampleRateHz === descriptor.outputSampleRateHz) {
    return descriptor.timeline.totalMediaFrames - descriptor.startPlan.mediaFrame;
  }
  return expectedLanczosOutputFrames({
    inputSampleRate: descriptor.coreSampleRateHz,
    outputSampleRate: descriptor.outputSampleRateHz,
    totalSourceFrames: descriptor.timeline.totalMediaFrames,
    startSourceFrame: descriptor.startPlan.mediaFrame,
  });
}
