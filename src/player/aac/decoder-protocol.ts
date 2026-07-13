import { isEncodedAudioSourceIdentity } from '../sources/encoded-audio-source.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  isPcmStreamGeneration,
  type PcmStreamGeneration,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.ts';
import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.ts';
import { adtsCoreSampleRateHzForIndex, type AdtsSampleRateIndex } from './adts-header.ts';
import type { AdtsCoreConfiguration } from './incremental-frame-reader.ts';
import type { AdtsSeekIndexPoint } from './seek-index.ts';
import { ADTS_CORE_FRAMES_PER_ACCESS_UNIT, type AdtsCoreTimeline } from './timeline.ts';

/** Worker-control version; PCM supply keeps its independent common version. */
export const AAC_DECODER_PROTOCOL_VERSION = 1 as const;
export const AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ = 1_000_000;
export const AAC_DECODER_MAX_ERROR_CODE_LENGTH = 256;
export const AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH = 1_024;

/** Small policy ceiling; the initial planner below currently defaults to one AU. */
export const AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS = 8;

const ADTS_MIN_ACCESS_UNIT_BYTES = 8;
const ADTS_MAX_ACCESS_UNIT_BYTES = 8_191;

export type AacSourceLifetimeGeneration = number;
/** One fresh Worker realm and one decoder incarnation. */
export type AacDecoderGeneration = PcmStreamGeneration;
export type AacDecoderBackendId = 'webcodecs' | 'symphonia-wasm';

/**
 * Exact scanner and decoder coordinates for one fresh AAC generation.
 *
 * The scanner anchor may be sparse and earlier than the decode start. The
 * Worker must scan forward from that verified byte boundary and begin feeding
 * its selected backend at `decodeStartAccessUnitOrdinal`.
 */
export interface AacDecoderStartPlan {
  readonly mediaFrame: number;
  readonly coreFrame: number;
  readonly accessUnitOrdinal: number;
  readonly coreFrameWithinAccessUnit: number;
  readonly scanAnchorByteOffset: number;
  readonly scanAnchorAccessUnitOrdinal: number;
  readonly decodeStartAccessUnitOrdinal: number;
  readonly discardCoreFrames: number;
}

export interface AacDecoderStartPlanOptions {
  /** Initial policy default: one transform access unit, bounded for future cohort policy. */
  readonly prerollAccessUnits?: number;
}

export interface AacDecoderDescriptor {
  readonly format: 'aac-adts';
  /** Exact immutable encoded-source binding, repeated across fresh realms. */
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
  readonly coreSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly channels: 1 | 2;
  readonly frameCount: number;
  /** Raw ADTS has no admitted trailing metadata; this must equal physical EOF. */
  readonly audioEndByteOffset: number;
  readonly timeline: Readonly<AdtsCoreTimeline>;
  /** Exclusive media EOF is deliberately not a valid decoder start. */
  readonly startPlan: Readonly<AacDecoderStartPlan>;
}

export const AAC_CORE_CONFIGURATION_KEYS = [
  'mpegId',
  'profile',
  'coreAudioObjectType',
  'sampleRateIndex',
  'channelConfiguration',
  'protectionAbsent',
  'rawDataBlocks',
] as const satisfies readonly (keyof AdtsCoreConfiguration)[];

export const AAC_CORE_TIMELINE_KEYS = [
  'frameCount',
  'coreFramesPerAccessUnit',
  'totalMediaFrames',
] as const satisfies readonly (keyof AdtsCoreTimeline)[];

export const AAC_DECODER_START_PLAN_KEYS = [
  'mediaFrame',
  'coreFrame',
  'accessUnitOrdinal',
  'coreFrameWithinAccessUnit',
  'scanAnchorByteOffset',
  'scanAnchorAccessUnitOrdinal',
  'decodeStartAccessUnitOrdinal',
  'discardCoreFrames',
] as const satisfies readonly (keyof AacDecoderStartPlan)[];

export const AAC_DECODER_DESCRIPTOR_KEYS = [
  'format',
  'sourceSize',
  'sourceIdentity',
  'coreConfiguration',
  'coreSampleRateHz',
  'outputSampleRateHz',
  'channels',
  'frameCount',
  'audioEndByteOffset',
  'timeline',
  'startPlan',
] as const satisfies readonly (keyof AacDecoderDescriptor)[];

const ADTS_SEEK_POINT_KEYS = [
  'frameOrdinal',
  'byteOffset',
] as const satisfies readonly (keyof AdtsSeekIndexPoint)[];

const START_PLAN_OPTION_KEYS = ['prerollAccessUnits'] as const;

export interface AacDecoderOpenCommand {
  readonly protocolVersion: typeof AAC_DECODER_PROTOCOL_VERSION;
  readonly type: 'open-decoder';
  readonly sourceLifetimeGeneration: AacSourceLifetimeGeneration;
  readonly decoderGeneration: AacDecoderGeneration;
  /** Exact cohort choice; the Worker must fail instead of silently substituting. */
  readonly backendId: AacDecoderBackendId;
  readonly descriptor: Readonly<AacDecoderDescriptor>;
  readonly sourcePort: MessagePort;
  readonly pcmPort: MessagePort;
}

export interface AacDecoderStopCommand {
  readonly protocolVersion: typeof AAC_DECODER_PROTOCOL_VERSION;
  readonly type: 'stop-decoder';
  readonly sourceLifetimeGeneration: AacSourceLifetimeGeneration;
  readonly decoderGeneration: AacDecoderGeneration;
}

export type AacDecoderCommand = AacDecoderOpenCommand | AacDecoderStopCommand;

interface AacDecoderEventIdentity {
  readonly protocolVersion: typeof AAC_DECODER_PROTOCOL_VERSION;
  readonly sourceLifetimeGeneration: AacSourceLifetimeGeneration;
  readonly decoderGeneration: AacDecoderGeneration;
}

export type AacDecoderEvent =
  | (AacDecoderEventIdentity & {
      readonly type: 'decoder-ready';
      /** Exact echo; the adapter compares it with the command descriptor. */
      readonly descriptor: Readonly<AacDecoderDescriptor>;
      /** Cohort-visible backend identity for later room-consistency policy. */
      readonly backendId: AacDecoderBackendId;
    })
  | (AacDecoderEventIdentity & {
      readonly type: 'decode-progress' | 'decoder-eof';
      /** Absolute next-read byte cursor in the verified ADTS source. */
      readonly decodedInputBytes: number;
      /** Absolute decoded core-frame cursor, including generation preroll. */
      readonly decodedCoreFrames: number;
      /** Generation-local resampled frames emitted after target discard. */
      readonly producedOutputFrames: number;
    })
  | (AacDecoderEventIdentity & {
      readonly type: 'decoder-stopped';
    })
  | (AacDecoderEventIdentity & {
      readonly type: 'decoder-error';
      readonly code: string;
      readonly message: string;
    });

export type { PcmSupplyMessage };
export { PCM_STREAM_PROTOCOL_VERSION };

type WorkerRecord = Readonly<Record<string, unknown>>;

/**
 * Capture one data-only structured-clone record before validation.
 *
 * Accessors are never invoked. Proxy reflection can re-enter application code,
 * but validation after this point consults only the detached descriptor-value
 * snapshot, so a later mutation cannot change any accepted coordinate.
 */
function snapshotWorkerRecord(value: unknown): WorkerRecord | null {
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

function hasExactKeys(record: WorkerRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function requireCanonicalRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): WorkerRecord {
  const record = snapshotWorkerRecord(value);
  if (!record || !hasExactKeys(record, keys)) {
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
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
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

function requireCoreConfiguration(value: unknown): Readonly<AdtsCoreConfiguration> {
  const record = requireCanonicalRecord(
    value,
    AAC_CORE_CONFIGURATION_KEYS,
    'AAC core configuration',
  );
  if (
    record.mpegId !== 0 ||
    record.profile !== 1 ||
    record.coreAudioObjectType !== 2 ||
    record.protectionAbsent !== true ||
    record.rawDataBlocks !== 1
  ) {
    throw new RangeError('AAC core configuration must be MPEG-4 AAC-LC without CRC');
  }
  requireSafeInteger(record.sampleRateIndex, 'AAC sampleRateIndex', 0, 12);
  if (record.channelConfiguration !== 1 && record.channelConfiguration !== 2) {
    throw new RangeError('AAC core configuration must be mono or stereo');
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

function requireTimeline(value: unknown): Readonly<AdtsCoreTimeline> {
  const record = requireCanonicalRecord(value, AAC_CORE_TIMELINE_KEYS, 'ADTS core timeline');
  requireSafeInteger(record.frameCount, 'timeline frameCount', 1);
  if (record.coreFramesPerAccessUnit !== ADTS_CORE_FRAMES_PER_ACCESS_UNIT) {
    throw new RangeError('timeline coreFramesPerAccessUnit must be exactly 1024');
  }
  requireSafeInteger(record.totalMediaFrames, 'timeline totalMediaFrames', 1);
  if (
    record.totalMediaFrames !==
    safeMultiply(record.frameCount, ADTS_CORE_FRAMES_PER_ACCESS_UNIT, 'ADTS core timeline geometry')
  ) {
    throw new RangeError('ADTS core timeline geometry is inconsistent');
  }
  return Object.freeze({
    frameCount: record.frameCount,
    coreFramesPerAccessUnit: ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
    totalMediaFrames: record.totalMediaFrames,
  });
}

function requireSeekPoint(value: unknown, label: string): Readonly<AdtsSeekIndexPoint> {
  const record = requireCanonicalRecord(value, ADTS_SEEK_POINT_KEYS, label);
  requireSafeInteger(record.frameOrdinal, `${label} frameOrdinal`, 0);
  requireSafeInteger(record.byteOffset, `${label} byteOffset`, 0);
  if (!spanCanContainAccessUnits(record.byteOffset, record.frameOrdinal)) {
    throw new RangeError(`${label} byte offset contradicts its access-unit ordinal`);
  }
  return Object.freeze({
    frameOrdinal: record.frameOrdinal,
    byteOffset: record.byteOffset,
  });
}

function requireStartPlan(value: unknown): Readonly<AacDecoderStartPlan> {
  const record = requireCanonicalRecord(
    value,
    AAC_DECODER_START_PLAN_KEYS,
    'AAC decoder start plan',
  );
  for (const key of AAC_DECODER_START_PLAN_KEYS) {
    requireSafeInteger(record[key], `startPlan ${key}`, 0);
  }
  return Object.freeze({ ...record }) as unknown as Readonly<AacDecoderStartPlan>;
}

function locateTarget(
  timeline: Readonly<AdtsCoreTimeline>,
  mediaFrame: number,
): Pick<
  AacDecoderStartPlan,
  'mediaFrame' | 'coreFrame' | 'accessUnitOrdinal' | 'coreFrameWithinAccessUnit'
> {
  requireSafeInteger(mediaFrame, 'AAC target mediaFrame', 0);
  if (mediaFrame >= timeline.totalMediaFrames) {
    throw new RangeError('AAC exclusive media EOF cannot open a decoder Worker');
  }
  return Object.freeze({
    mediaFrame,
    coreFrame: mediaFrame,
    accessUnitOrdinal: Math.floor(mediaFrame / ADTS_CORE_FRAMES_PER_ACCESS_UNIT),
    coreFrameWithinAccessUnit: mediaFrame % ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
  });
}

function requireDescriptor(value: unknown): Readonly<AacDecoderDescriptor> {
  const record = requireCanonicalRecord(
    value,
    AAC_DECODER_DESCRIPTOR_KEYS,
    'AAC decoder descriptor',
  );
  if (record.format !== 'aac-adts') {
    throw new TypeError('AAC decoder descriptor format is invalid');
  }
  requireSafeInteger(record.sourceSize, 'AAC sourceSize', ADTS_MIN_ACCESS_UNIT_BYTES);
  if (!isEncodedAudioSourceIdentity(record.sourceIdentity)) {
    throw new TypeError('AAC source identity is invalid');
  }
  const coreConfiguration = requireCoreConfiguration(record.coreConfiguration);
  requireSafeInteger(record.coreSampleRateHz, 'AAC coreSampleRateHz', 1);
  requireSafeInteger(
    record.outputSampleRateHz,
    'AAC outputSampleRateHz',
    1,
    AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  );
  if (record.channels !== 1 && record.channels !== 2) {
    throw new RangeError('AAC channels must be one or two');
  }
  if (
    adtsCoreSampleRateHzForIndex(coreConfiguration.sampleRateIndex) !== record.coreSampleRateHz ||
    coreConfiguration.channelConfiguration !== record.channels
  ) {
    throw new RangeError('AAC rate or channel geometry contradicts its core configuration');
  }
  requireSafeInteger(record.frameCount, 'AAC frameCount', 1);
  requireSafeInteger(
    record.audioEndByteOffset,
    'AAC audioEndByteOffset',
    ADTS_MIN_ACCESS_UNIT_BYTES,
    record.sourceSize,
  );
  if (record.audioEndByteOffset !== record.sourceSize) {
    throw new RangeError('AAC verified audio span must reach physical EOF');
  }
  if (!spanCanContainAccessUnits(record.sourceSize, record.frameCount)) {
    throw new RangeError('AAC source byte span contradicts its access-unit count');
  }

  const timeline = requireTimeline(record.timeline);
  if (timeline.frameCount !== record.frameCount) {
    throw new RangeError('AAC timeline contradicts its verified access-unit count');
  }

  const startPlan = requireStartPlan(record.startPlan);
  const target = locateTarget(timeline, startPlan.mediaFrame);
  if (
    startPlan.coreFrame !== target.coreFrame ||
    startPlan.accessUnitOrdinal !== target.accessUnitOrdinal ||
    startPlan.coreFrameWithinAccessUnit !== target.coreFrameWithinAccessUnit
  ) {
    throw new RangeError('AAC start target contradicts its core timeline');
  }
  if (
    startPlan.scanAnchorAccessUnitOrdinal > startPlan.decodeStartAccessUnitOrdinal ||
    startPlan.decodeStartAccessUnitOrdinal > startPlan.accessUnitOrdinal
  ) {
    throw new RangeError('AAC scan anchor, decode start, and target ordinals are out of order');
  }
  if (
    startPlan.accessUnitOrdinal - startPlan.decodeStartAccessUnitOrdinal >
    AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS
  ) {
    throw new RangeError('AAC decoder transform preroll exceeds the bounded protocol ceiling');
  }
  const decodeStartCoreFrame = safeMultiply(
    startPlan.decodeStartAccessUnitOrdinal,
    ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
    'AAC decode-start core coordinate',
  );
  if (startPlan.discardCoreFrames !== startPlan.coreFrame - decodeStartCoreFrame) {
    throw new RangeError('AAC discardCoreFrames contradicts its exact decode-start coordinate');
  }

  const bytesBeforeAnchor = startPlan.scanAnchorByteOffset;
  const accessUnitsAfterAnchor = record.frameCount - startPlan.scanAnchorAccessUnitOrdinal;
  const bytesAfterAnchor = record.sourceSize - startPlan.scanAnchorByteOffset;
  if (
    !spanCanContainAccessUnits(bytesBeforeAnchor, startPlan.scanAnchorAccessUnitOrdinal) ||
    !spanCanContainAccessUnits(bytesAfterAnchor, accessUnitsAfterAnchor)
  ) {
    throw new RangeError('AAC scanner anchor contradicts the verified source geometry');
  }

  expectedLanczosOutputFrames({
    inputSampleRate: record.coreSampleRateHz,
    outputSampleRate: record.outputSampleRateHz,
    totalSourceFrames: timeline.totalMediaFrames,
    startSourceFrame: startPlan.mediaFrame,
  });

  return Object.freeze({
    format: 'aac-adts',
    sourceSize: record.sourceSize,
    sourceIdentity: record.sourceIdentity,
    coreConfiguration,
    coreSampleRateHz: record.coreSampleRateHz,
    outputSampleRateHz: record.outputSampleRateHz,
    channels: record.channels,
    frameCount: record.frameCount,
    audioEndByteOffset: record.audioEndByteOffset,
    timeline,
    startPlan,
  });
}

/** Strict worker-bound validation, including exact nested key sets. */
export function validateAacDecoderDescriptor(
  value: unknown,
): asserts value is AacDecoderDescriptor {
  requireDescriptor(value);
}

/** Snapshot an untrusted descriptor so later mutation cannot cross the boundary. */
export function snapshotAacDecoderDescriptor(
  value: unknown,
): Readonly<AacDecoderDescriptor> | null {
  try {
    return requireDescriptor(value);
  } catch {
    return null;
  }
}

export function isAacSourceLifetimeGeneration(
  value: unknown,
): value is AacSourceLifetimeGeneration {
  return isPcmStreamGeneration(value);
}

export function isAacDecoderGeneration(value: unknown): value is AacDecoderGeneration {
  return isPcmStreamGeneration(value);
}

function snapshotStartPlanOptions(value: unknown): number {
  if (value === undefined) return 1;
  const record = snapshotWorkerRecord(value);
  if (
    !record ||
    Object.keys(record).some((key) => !START_PLAN_OPTION_KEYS.includes(key as 'prerollAccessUnits'))
  ) {
    throw new TypeError('AAC start-plan options must contain only prerollAccessUnits');
  }
  const prerollAccessUnits = Object.hasOwn(record, 'prerollAccessUnits')
    ? record.prerollAccessUnits
    : 1;
  requireSafeInteger(
    prerollAccessUnits,
    'AAC prerollAccessUnits',
    0,
    AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS,
  );
  return prerollAccessUnits;
}

/**
 * Build the initial bounded transform-preroll policy from a scanner-verified
 * index point. The default one-AU preroll helps decoder transform continuity;
 * it deliberately does not claim PNS bitwise convergence across backends.
 */
export function createAacDecoderStartPlan(
  timelineValue: AdtsCoreTimeline,
  mediaFrame: number,
  verifiedAnchorValue: AdtsSeekIndexPoint,
  options?: AacDecoderStartPlanOptions,
): Readonly<AacDecoderStartPlan> {
  const timeline = requireTimeline(timelineValue);
  const target = locateTarget(timeline, mediaFrame);
  const anchor = requireSeekPoint(verifiedAnchorValue, 'AAC scanner-verified anchor');
  const prerollAccessUnits = snapshotStartPlanOptions(options);
  const decodeStartAccessUnitOrdinal = Math.max(target.accessUnitOrdinal - prerollAccessUnits, 0);
  if (
    anchor.frameOrdinal >= timeline.frameCount ||
    anchor.frameOrdinal > decodeStartAccessUnitOrdinal
  ) {
    throw new RangeError('AAC scanner anchor begins after the selected decode start');
  }
  const decodeStartCoreFrame = safeMultiply(
    decodeStartAccessUnitOrdinal,
    ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
    'AAC decode-start core coordinate',
  );
  const plan: AacDecoderStartPlan = Object.freeze({
    ...target,
    scanAnchorByteOffset: anchor.byteOffset,
    scanAnchorAccessUnitOrdinal: anchor.frameOrdinal,
    decodeStartAccessUnitOrdinal,
    discardCoreFrames: target.coreFrame - decodeStartCoreFrame,
  });
  return requireStartPlan(plan);
}

function isMessagePort(value: unknown): value is MessagePort {
  return typeof MessagePort !== 'undefined' && value instanceof MessagePort;
}

function hasGenerationPair(record: WorkerRecord): record is WorkerRecord & {
  readonly sourceLifetimeGeneration: AacSourceLifetimeGeneration;
  readonly decoderGeneration: AacDecoderGeneration;
} {
  return (
    isAacSourceLifetimeGeneration(record.sourceLifetimeGeneration) &&
    isAacDecoderGeneration(record.decoderGeneration)
  );
}

export function parseAacDecoderCommand(value: unknown): Readonly<AacDecoderCommand> | null {
  const record = snapshotWorkerRecord(value);
  if (
    !record ||
    record.protocolVersion !== AAC_DECODER_PROTOCOL_VERSION ||
    typeof record.type !== 'string' ||
    !hasGenerationPair(record)
  ) {
    return null;
  }
  if (record.type === 'open-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
        'backendId',
        'descriptor',
        'sourcePort',
        'pcmPort',
      ]) ||
      !isBackendId(record.backendId) ||
      !isMessagePort(record.sourcePort) ||
      !isMessagePort(record.pcmPort) ||
      record.sourcePort === record.pcmPort
    ) {
      return null;
    }
    const descriptor = snapshotAacDecoderDescriptor(record.descriptor);
    if (!descriptor) return null;
    return Object.freeze({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
      type: 'open-decoder',
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
      backendId: record.backendId,
      descriptor,
      sourcePort: record.sourcePort,
      pcmPort: record.pcmPort,
    });
  }
  if (record.type === 'stop-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
      ])
    ) {
      return null;
    }
    return Object.freeze({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
    });
  }
  return null;
}

/** Exact transfer list for the atomic fresh-realm handoff. */
export function aacDecoderCommandTransferables(
  command: Readonly<AacDecoderCommand>,
): Transferable[] {
  return command.type === 'open-decoder' ? [command.sourcePort, command.pcmPort] : [];
}

const EVENT_IDENTITY_KEYS = [
  'protocolVersion',
  'type',
  'sourceLifetimeGeneration',
  'decoderGeneration',
] as const;

function hasEventIdentity(record: WorkerRecord): record is WorkerRecord & {
  readonly sourceLifetimeGeneration: AacSourceLifetimeGeneration;
  readonly decoderGeneration: AacDecoderGeneration;
} {
  return record.protocolVersion === AAC_DECODER_PROTOCOL_VERSION && hasGenerationPair(record);
}

function validCounter(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0
  );
}

function isBackendId(value: unknown): value is AacDecoderBackendId {
  return value === 'webcodecs' || value === 'symphonia-wasm';
}

/**
 * Strict structural parser for control events from the fresh Worker realm.
 * The adapter must additionally enforce descriptor-relative monotonic bounds,
 * requested-backend equality, input/core/output ceilings, whole-AU core
 * progress, and exact input/core/output EOF counters for its active generation.
 */
export function parseAacDecoderEvent(value: unknown): Readonly<AacDecoderEvent> | null {
  const record = snapshotWorkerRecord(value);
  if (!record || typeof record.type !== 'string' || !hasEventIdentity(record)) return null;

  if (record.type === 'decoder-ready') {
    if (
      !hasExactKeys(record, [...EVENT_IDENTITY_KEYS, 'descriptor', 'backendId']) ||
      !isBackendId(record.backendId)
    ) {
      return null;
    }
    const descriptor = snapshotAacDecoderDescriptor(record.descriptor);
    return descriptor
      ? Object.freeze({
          protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
          type: 'decoder-ready',
          sourceLifetimeGeneration: record.sourceLifetimeGeneration,
          decoderGeneration: record.decoderGeneration,
          descriptor,
          backendId: record.backendId,
        })
      : null;
  }
  if (record.type === 'decode-progress' || record.type === 'decoder-eof') {
    if (
      !hasExactKeys(record, [
        ...EVENT_IDENTITY_KEYS,
        'decodedInputBytes',
        'decodedCoreFrames',
        'producedOutputFrames',
      ]) ||
      !validCounter(record.decodedInputBytes) ||
      !validCounter(record.decodedCoreFrames) ||
      !validCounter(record.producedOutputFrames)
    ) {
      return null;
    }
    return Object.freeze({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
      type: record.type,
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
      decodedInputBytes: record.decodedInputBytes,
      decodedCoreFrames: record.decodedCoreFrames,
      producedOutputFrames: record.producedOutputFrames,
    });
  }
  if (record.type === 'decoder-stopped') {
    return hasExactKeys(record, EVENT_IDENTITY_KEYS)
      ? Object.freeze({
          protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
          type: 'decoder-stopped',
          sourceLifetimeGeneration: record.sourceLifetimeGeneration,
          decoderGeneration: record.decoderGeneration,
        })
      : null;
  }
  if (record.type === 'decoder-error') {
    if (
      !hasExactKeys(record, [...EVENT_IDENTITY_KEYS, 'code', 'message']) ||
      typeof record.code !== 'string' ||
      record.code.length === 0 ||
      record.code.length > AAC_DECODER_MAX_ERROR_CODE_LENGTH ||
      typeof record.message !== 'string' ||
      record.message.length === 0 ||
      record.message.length > AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH
    ) {
      return null;
    }
    return Object.freeze({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
      code: record.code,
      message: record.message,
    });
  }
  return null;
}

export function sameAacDecoderDescriptor(left: unknown, right: unknown): boolean {
  const first = snapshotAacDecoderDescriptor(left);
  const second = snapshotAacDecoderDescriptor(right);
  if (!first || !second) return false;
  for (const key of AAC_DECODER_DESCRIPTOR_KEYS) {
    if (key === 'coreConfiguration' || key === 'timeline' || key === 'startPlan') continue;
    if (first[key] !== second[key]) return false;
  }
  for (const key of AAC_CORE_CONFIGURATION_KEYS) {
    if (first.coreConfiguration[key] !== second.coreConfiguration[key]) return false;
  }
  for (const key of AAC_CORE_TIMELINE_KEYS) {
    if (first.timeline[key] !== second.timeline[key]) return false;
  }
  for (const key of AAC_DECODER_START_PLAN_KEYS) {
    if (first.startPlan[key] !== second.startPlan[key]) return false;
  }
  return true;
}
