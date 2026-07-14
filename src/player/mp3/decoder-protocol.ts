import { isEncodedAudioSourceIdentity } from '../sources/encoded-audio-source.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  isPcmStreamGeneration,
  type PcmStreamGeneration,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.ts';
import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.ts';
import type { MpegLayer3Version } from './frame-header.ts';
import {
  MP3_SEEK_INDEX_MAX_POINTS,
  MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES,
  MP3_SEEK_MAX_RESERVOIR_HISTORY_FRAMES,
  MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES,
  type MpegLayer3ReservoirPrelude,
  type MpegLayer3SeekIndexPoint,
} from './seek-index.ts';
import {
  locateMp3MediaFrame,
  type Mp3MediaFrameLocation,
  type Mp3SampleTimeline,
} from './timeline.ts';

/** Worker-control version; PCM supply keeps its independent common version. */
export const MP3_DECODER_PROTOCOL_VERSION = 1 as const;
export const MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ = 1_000_000;
export const MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS = MP3_SEEK_INDEX_MAX_POINTS;
export const MP3_DECODER_MAX_ERROR_CODE_LENGTH = 256;
export const MP3_DECODER_MAX_ERROR_MESSAGE_LENGTH = 1_024;

const MAX_LAYER_3_FRAME_BYTES = 1_441;

export type Mp3SourceLifetimeGeneration = number;
/** One fresh Worker realm and one mpg123 incarnation. */
export type Mp3DecoderGeneration = PcmStreamGeneration;

/**
 * Worker-resolvable seek plan.
 *
 * The main thread supplies one exact planning anchor established by a scanner
 * or an outer admitted-manifest owner. The Worker scans from that coordinate to
 * the target frame, keeps only the declared rolling history, and resolves the
 * actual reservoir/synthesis prelude before constructing mpg123. This shape
 * itself carries no admission authority and works for sparse or enriched indexes.
 */
export interface Mp3DecoderStartPlan extends Mp3MediaFrameLocation {
  readonly scanAnchorByteOffset: number;
  readonly scanAnchorFrameOrdinal: number;
  readonly minimumWarmupFrames: number;
  readonly historyFrameLimit: number;
}

export interface Mp3DecoderDescriptor {
  readonly format: 'mp3';
  /** Exact immutable encoded-source binding, repeated across fresh realms. */
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly version: MpegLayer3Version;
  readonly sourceSampleRate: number;
  readonly outputSampleRate: number;
  readonly channels: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  readonly audioFrameCount: number;
  readonly timeline: Mp3SampleTimeline;
  /** Exclusive media EOF is deliberately not a valid decoder start. */
  readonly startPlan: Mp3DecoderStartPlan;
}

export const MP3_SAMPLE_TIMELINE_KEYS = [
  'totalRawSamples',
  'samplesPerFrame',
  'headTrimSamples',
  'tailTrimSamples',
  'rawEofSampleExclusive',
  'totalMediaFrames',
] as const satisfies readonly (keyof Mp3SampleTimeline)[];

export const MP3_DECODER_START_PLAN_KEYS = [
  'mediaFrame',
  'rawSample',
  'audioFrameOrdinal',
  'sampleWithinAudioFrame',
  'scanAnchorByteOffset',
  'scanAnchorFrameOrdinal',
  'minimumWarmupFrames',
  'historyFrameLimit',
] as const satisfies readonly (keyof Mp3DecoderStartPlan)[];

export const MP3_DECODER_DESCRIPTOR_KEYS = [
  'format',
  'sourceSize',
  'sourceIdentity',
  'version',
  'sourceSampleRate',
  'outputSampleRate',
  'channels',
  'samplesPerFrame',
  'firstAudioFrameOffset',
  'audioEndByteOffset',
  'audioFrameCount',
  'timeline',
  'startPlan',
] as const satisfies readonly (keyof Mp3DecoderDescriptor)[];

const MP3_INDEX_POINT_KEYS = [
  'rawSample',
  'byteOffset',
  'frameOrdinal',
  'mainDataCapacityBytes',
  'mainDataBeginBytes',
] as const satisfies readonly (keyof MpegLayer3SeekIndexPoint)[];

export interface Mp3DecoderOpenCommand {
  readonly protocolVersion: typeof MP3_DECODER_PROTOCOL_VERSION;
  readonly type: 'open-decoder';
  readonly sourceLifetimeGeneration: Mp3SourceLifetimeGeneration;
  readonly decoderGeneration: Mp3DecoderGeneration;
  readonly descriptor: Mp3DecoderDescriptor;
  readonly sourcePort: MessagePort;
  readonly pcmPort: MessagePort;
}

export interface Mp3DecoderStopCommand {
  readonly protocolVersion: typeof MP3_DECODER_PROTOCOL_VERSION;
  readonly type: 'stop-decoder';
  readonly sourceLifetimeGeneration: Mp3SourceLifetimeGeneration;
  readonly decoderGeneration: Mp3DecoderGeneration;
}

export type Mp3DecoderCommand = Mp3DecoderOpenCommand | Mp3DecoderStopCommand;

interface Mp3DecoderEventIdentity {
  readonly protocolVersion: typeof MP3_DECODER_PROTOCOL_VERSION;
  readonly sourceLifetimeGeneration: Mp3SourceLifetimeGeneration;
  readonly decoderGeneration: Mp3DecoderGeneration;
}

export type Mp3DecoderEvent =
  | (Mp3DecoderEventIdentity & {
      readonly type: 'decoder-ready';
      /** Exact echo; the adapter compares it with the command descriptor. */
      readonly descriptor: Mp3DecoderDescriptor;
    })
  | (Mp3DecoderEventIdentity & {
      readonly type: 'decode-progress' | 'decoder-eof';
      /** Absolute encoded cursor, including skipped metadata before the anchor. */
      readonly decodedInputBytes: number;
      /** Absolute raw decoder-domain sample cursor. */
      readonly decodedRawSamples: number;
      readonly producedOutputFrames: number;
    })
  | (Mp3DecoderEventIdentity & {
      readonly type: 'decoder-stopped';
    })
  | (Mp3DecoderEventIdentity &
      MpegLayer3SeekIndexPoint & {
        readonly type: 'frame-index-point';
      })
  | (Mp3DecoderEventIdentity & {
      readonly type: 'decoder-error';
      /** Non-empty bounded machine code. */
      readonly code: string;
      /** Non-empty bounded domain message; the adapter need not invent a fallback. */
      readonly message: string;
    });

export type { PcmSupplyMessage };
export { PCM_STREAM_PROTOCOL_VERSION };

type WorkerRecord = Readonly<Record<string, unknown>>;

function snapshotWorkerRecord(value: unknown): WorkerRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== null && prototype !== Object.prototype) return null;

  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || Object.hasOwn(record, key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
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

function requireSamplesPerFrame(value: unknown): asserts value is 576 | 1_152 {
  if (value !== 576 && value !== 1_152) {
    throw new RangeError('MP3 samplesPerFrame must be 576 or 1152');
  }
}

function maximumMainDataBeginBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 1_152 ? 511 : 255;
}

function minimumFrameBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 576 ? 24 : 96;
}

function spanCanContainFrames(
  byteSpan: number,
  frameCount: number,
  minimumBytesPerFrame: number,
): boolean {
  if (
    !Number.isSafeInteger(byteSpan) ||
    byteSpan < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 0
  ) {
    return false;
  }
  const minimumSpan = frameCount * minimumBytesPerFrame;
  if (!Number.isSafeInteger(minimumSpan) || byteSpan < minimumSpan) return false;
  const maximumSpanFits =
    frameCount <= Math.floor(Number.MAX_SAFE_INTEGER / MAX_LAYER_3_FRAME_BYTES);
  return !maximumSpanFits || byteSpan <= frameCount * MAX_LAYER_3_FRAME_BYTES;
}

function requireVersionGeometry(
  version: unknown,
  sourceSampleRate: number,
  samplesPerFrame: 576 | 1_152,
): asserts version is MpegLayer3Version {
  const rates: Readonly<Record<MpegLayer3Version, readonly number[]>> = Object.freeze({
    '1': Object.freeze([32_000, 44_100, 48_000]),
    '2': Object.freeze([16_000, 22_050, 24_000]),
    '2.5': Object.freeze([8_000, 11_025, 12_000]),
  });
  if (version !== '1' && version !== '2' && version !== '2.5') {
    throw new RangeError('MP3 version must be MPEG-1, MPEG-2, or MPEG-2.5');
  }
  if (!rates[version].includes(sourceSampleRate)) {
    throw new RangeError('MP3 source sample rate contradicts its MPEG version');
  }
  const expectedSamplesPerFrame = version === '1' ? 1_152 : 576;
  if (samplesPerFrame !== expectedSamplesPerFrame) {
    throw new RangeError('MP3 samples per frame contradict the MPEG version');
  }
}

function requireTimeline(value: unknown): Readonly<Mp3SampleTimeline> {
  const record = requireCanonicalRecord(value, MP3_SAMPLE_TIMELINE_KEYS, 'MP3 sample timeline');
  requireSafeInteger(record.totalRawSamples, 'timeline totalRawSamples', 1);
  requireSamplesPerFrame(record.samplesPerFrame);
  requireSafeInteger(record.headTrimSamples, 'timeline headTrimSamples', 0);
  requireSafeInteger(record.tailTrimSamples, 'timeline tailTrimSamples', 0);
  requireSafeInteger(record.rawEofSampleExclusive, 'timeline rawEofSampleExclusive', 0);
  requireSafeInteger(record.totalMediaFrames, 'timeline totalMediaFrames', 1);
  if (
    record.totalRawSamples % record.samplesPerFrame !== 0 ||
    record.tailTrimSamples > record.totalRawSamples ||
    record.rawEofSampleExclusive !== record.totalRawSamples - record.tailTrimSamples ||
    record.headTrimSamples > record.rawEofSampleExclusive ||
    record.totalMediaFrames !== record.rawEofSampleExclusive - record.headTrimSamples
  ) {
    throw new RangeError('MP3 sample timeline geometry is inconsistent');
  }
  return Object.freeze({ ...record }) as unknown as Readonly<Mp3SampleTimeline>;
}

function requireStartPlan(value: unknown): Readonly<Mp3DecoderStartPlan> {
  const record = requireCanonicalRecord(
    value,
    MP3_DECODER_START_PLAN_KEYS,
    'MP3 decoder start plan',
  );
  for (const key of MP3_DECODER_START_PLAN_KEYS) {
    requireSafeInteger(record[key], `startPlan ${key}`, 0);
  }
  const minimumWarmupFrames = record.minimumWarmupFrames as number;
  const historyFrameLimit = record.historyFrameLimit as number;
  if (minimumWarmupFrames > MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES) {
    throw new RangeError('MP3 minimum warmup exceeds its bounded maximum');
  }
  if (historyFrameLimit > MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES) {
    throw new RangeError('MP3 history frame limit exceeds its bounded maximum');
  }
  if (minimumWarmupFrames > historyFrameLimit) {
    throw new RangeError('MP3 history frame limit cannot satisfy its synthesis warmup');
  }
  return Object.freeze({ ...record }) as unknown as Readonly<Mp3DecoderStartPlan>;
}

function requireIndexPoint(
  value: unknown,
  samplesPerFrame: 576 | 1_152,
  label: string,
): Readonly<MpegLayer3SeekIndexPoint> {
  const record = requireCanonicalRecord(value, MP3_INDEX_POINT_KEYS, label);
  requireSafeInteger(record.rawSample, `${label} rawSample`, 0);
  requireSafeInteger(record.byteOffset, `${label} byteOffset`, 0);
  requireSafeInteger(record.frameOrdinal, `${label} frameOrdinal`, 0);
  requireSafeInteger(
    record.mainDataCapacityBytes,
    `${label} mainDataCapacityBytes`,
    1,
    MAX_LAYER_3_FRAME_BYTES - 1,
  );
  requireSafeInteger(
    record.mainDataBeginBytes,
    `${label} mainDataBeginBytes`,
    0,
    maximumMainDataBeginBytes(samplesPerFrame),
  );
  if (record.rawSample !== safeMultiply(record.frameOrdinal, samplesPerFrame, label)) {
    throw new RangeError(`${label} raw sample contradicts its frame ordinal`);
  }
  if (record.frameOrdinal === 0 && record.mainDataBeginBytes !== 0) {
    throw new RangeError(`${label} frame zero cannot reference earlier reservoir data`);
  }
  return Object.freeze({ ...record }) as unknown as Readonly<MpegLayer3SeekIndexPoint>;
}

function requireDescriptor(value: unknown): Readonly<Mp3DecoderDescriptor> {
  const record = requireCanonicalRecord(
    value,
    MP3_DECODER_DESCRIPTOR_KEYS,
    'MP3 decoder descriptor',
  );
  if (record.format !== 'mp3') throw new TypeError('MP3 decoder descriptor format is invalid');
  requireSafeInteger(record.sourceSize, 'MP3 sourceSize', 1);
  if (!isEncodedAudioSourceIdentity(record.sourceIdentity)) {
    throw new TypeError('MP3 source identity is invalid');
  }
  requireSafeInteger(record.sourceSampleRate, 'MP3 sourceSampleRate', 1);
  requireSafeInteger(
    record.outputSampleRate,
    'MP3 outputSampleRate',
    1,
    MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  );
  if (record.channels !== 1 && record.channels !== 2) {
    throw new RangeError('MP3 channels must be one or two');
  }
  requireSamplesPerFrame(record.samplesPerFrame);
  requireVersionGeometry(record.version, record.sourceSampleRate, record.samplesPerFrame);
  requireSafeInteger(record.firstAudioFrameOffset, 'MP3 firstAudioFrameOffset', 0);
  requireSafeInteger(record.audioEndByteOffset, 'MP3 audioEndByteOffset', 1, record.sourceSize);
  requireSafeInteger(record.audioFrameCount, 'MP3 audioFrameCount', 1);
  if (record.firstAudioFrameOffset >= record.audioEndByteOffset) {
    throw new RangeError('MP3 audio span must be non-empty');
  }

  const minimumBytes = minimumFrameBytes(record.samplesPerFrame);
  const audioSpan = record.audioEndByteOffset - record.firstAudioFrameOffset;
  if (!spanCanContainFrames(audioSpan, record.audioFrameCount, minimumBytes)) {
    throw new RangeError('MP3 audio byte span contradicts its frame count');
  }

  const timeline = requireTimeline(record.timeline);
  if (
    timeline.samplesPerFrame !== record.samplesPerFrame ||
    timeline.totalRawSamples !==
      safeMultiply(record.audioFrameCount, record.samplesPerFrame, 'MP3 total raw samples')
  ) {
    throw new RangeError('MP3 timeline contradicts its encoded frame geometry');
  }

  const startPlan = requireStartPlan(record.startPlan);
  if (startPlan.mediaFrame >= timeline.totalMediaFrames) {
    throw new RangeError('MP3 exclusive media EOF cannot open a decoder Worker');
  }
  const expectedLocation = locateMp3MediaFrame(timeline, startPlan.mediaFrame);
  if (
    startPlan.rawSample !== expectedLocation.rawSample ||
    startPlan.audioFrameOrdinal !== expectedLocation.audioFrameOrdinal ||
    startPlan.sampleWithinAudioFrame !== expectedLocation.sampleWithinAudioFrame
  ) {
    throw new RangeError('MP3 start target contradicts its sample timeline');
  }
  if (
    startPlan.audioFrameOrdinal >= record.audioFrameCount ||
    startPlan.scanAnchorFrameOrdinal > startPlan.audioFrameOrdinal ||
    startPlan.historyFrameLimit > startPlan.audioFrameOrdinal ||
    startPlan.scanAnchorFrameOrdinal > startPlan.audioFrameOrdinal - startPlan.historyFrameLimit
  ) {
    throw new RangeError('MP3 scan anchor or bounded history contradicts its target frame');
  }

  const bytesBeforeAnchor = startPlan.scanAnchorByteOffset - record.firstAudioFrameOffset;
  const framesAfterAnchor = record.audioFrameCount - startPlan.scanAnchorFrameOrdinal;
  const bytesAfterAnchor = record.audioEndByteOffset - startPlan.scanAnchorByteOffset;
  if (
    !spanCanContainFrames(bytesBeforeAnchor, startPlan.scanAnchorFrameOrdinal, minimumBytes) ||
    !spanCanContainFrames(bytesAfterAnchor, framesAfterAnchor, minimumBytes)
  ) {
    throw new RangeError('MP3 scan anchor byte offset contradicts its frame ordinal');
  }

  expectedLanczosOutputFrames({
    inputSampleRate: record.sourceSampleRate,
    outputSampleRate: record.outputSampleRate,
    totalSourceFrames: timeline.totalMediaFrames,
    startSourceFrame: startPlan.mediaFrame,
  });

  return Object.freeze({
    ...record,
    timeline,
    startPlan,
  }) as unknown as Readonly<Mp3DecoderDescriptor>;
}

/** Strict worker-bound validation, including exact nested key sets. */
export function validateMp3DecoderDescriptor(
  value: unknown,
): asserts value is Mp3DecoderDescriptor {
  requireDescriptor(value);
}

/** Snapshot an untrusted descriptor so later mutation cannot cross the boundary. */
export function snapshotMp3DecoderDescriptor(
  value: unknown,
): Readonly<Mp3DecoderDescriptor> | null {
  try {
    return requireDescriptor(value);
  } catch {
    return null;
  }
}

export function isMp3SourceLifetimeGeneration(
  value: unknown,
): value is Mp3SourceLifetimeGeneration {
  return isPcmStreamGeneration(value);
}

export function isMp3DecoderGeneration(value: unknown): value is Mp3DecoderGeneration {
  return isPcmStreamGeneration(value);
}

export function isMp3SourceSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function samePointTarget(
  point: Readonly<MpegLayer3SeekIndexPoint>,
  frameOrdinal: number,
  samplesPerFrame: 576 | 1_152,
): boolean {
  return (
    point.frameOrdinal === frameOrdinal &&
    point.rawSample === safeMultiply(frameOrdinal, samplesPerFrame, 'MP3 target frame sample')
  );
}

/**
 * Collapse either seek-index prelude variant into the one plan the Worker can
 * resolve without trusting interpolated byte coordinates.
 */
export function createMp3DecoderStartPlan(
  timelineValue: Mp3SampleTimeline,
  mediaFrame: number,
  prelude: MpegLayer3ReservoirPrelude,
): Readonly<Mp3DecoderStartPlan> {
  const timeline = requireTimeline(timelineValue);
  requireSafeInteger(mediaFrame, 'MP3 target mediaFrame', 0);
  if (mediaFrame >= timeline.totalMediaFrames) {
    throw new RangeError('MP3 exclusive media EOF cannot create a decoder start plan');
  }
  if (!prelude || typeof prelude !== 'object') {
    throw new TypeError('MP3 reservoir prelude is missing');
  }

  const location = locateMp3MediaFrame(timeline, mediaFrame);
  const targetFrameRawSample = safeMultiply(
    location.audioFrameOrdinal,
    timeline.samplesPerFrame,
    'MP3 target frame sample',
  );
  let anchor: Readonly<MpegLayer3SeekIndexPoint>;
  let minimumWarmupFrames: number;
  let historyFrameLimit: number;

  if (prelude.kind === 'verified-history') {
    const target = requireIndexPoint(
      prelude.target,
      timeline.samplesPerFrame,
      'MP3 verified prelude target',
    );
    if (!samePointTarget(target, location.audioFrameOrdinal, timeline.samplesPerFrame)) {
      throw new RangeError('MP3 verified prelude targets a different media frame');
    }
    requireSafeInteger(
      prelude.minimumWarmupFrames,
      'MP3 minimum warmup frames',
      0,
      MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES,
    );
    if (!Array.isArray(prelude.previousFrames)) {
      throw new TypeError('MP3 verified prelude history must be an array');
    }
    if (
      prelude.previousFrames.length > MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES ||
      prelude.previousFrames.length > location.audioFrameOrdinal
    ) {
      throw new RangeError('MP3 verified prelude history exceeds its bounded target');
    }
    const expectedFirstOrdinal = location.audioFrameOrdinal - prelude.previousFrames.length;
    const previous = prelude.previousFrames.map((point, index) => {
      const verified = requireIndexPoint(
        point,
        timeline.samplesPerFrame,
        `MP3 verified prelude history ${index}`,
      );
      if (verified.frameOrdinal !== expectedFirstOrdinal + index) {
        throw new RangeError('MP3 verified prelude history is not contiguous');
      }
      return verified;
    });
    const warmupStart = requireIndexPoint(
      prelude.warmupStart,
      timeline.samplesPerFrame,
      'MP3 verified prelude warmup start',
    );
    const actualWarmupFrames = Math.min(prelude.minimumWarmupFrames, location.audioFrameOrdinal);
    const expectedWarmupStartOrdinal = location.audioFrameOrdinal - actualWarmupFrames;
    const historyWarmupStart =
      actualWarmupFrames === 0 ? target : previous[previous.length - actualWarmupFrames];
    if (
      warmupStart.frameOrdinal !== expectedWarmupStartOrdinal ||
      !historyWarmupStart ||
      historyWarmupStart.rawSample !== warmupStart.rawSample ||
      historyWarmupStart.byteOffset !== warmupStart.byteOffset
    ) {
      throw new RangeError('MP3 verified prelude warmup start contradicts its bounded history');
    }
    anchor = previous[0] ?? target;
    minimumWarmupFrames = actualWarmupFrames;
    historyFrameLimit = previous.length;
  } else if (prelude.kind === 'scan-from-anchor') {
    requireSafeInteger(prelude.targetRawSample, 'MP3 scan target raw sample', 0);
    requireSafeInteger(prelude.targetFrameOrdinal, 'MP3 scan target frame ordinal', 0);
    if (
      prelude.targetRawSample !== targetFrameRawSample ||
      prelude.targetFrameOrdinal !== location.audioFrameOrdinal
    ) {
      throw new RangeError('MP3 scan prelude targets a different media frame');
    }
    requireSafeInteger(
      prelude.minimumWarmupFrames,
      'MP3 minimum warmup frames',
      0,
      MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES,
    );
    requireSafeInteger(
      prelude.warmupFrameLimit,
      'MP3 warmup frame limit',
      0,
      MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES,
    );
    requireSafeInteger(
      prelude.reservoirFrameLimit,
      'MP3 reservoir frame limit',
      0,
      MP3_SEEK_MAX_RESERVOIR_HISTORY_FRAMES,
    );
    requireSafeInteger(
      prelude.historyFrameLimit,
      'MP3 history frame limit',
      0,
      MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES,
    );
    const actualWarmupFrames = Math.min(prelude.minimumWarmupFrames, location.audioFrameOrdinal);
    const actualReservoirFrames = Math.min(
      location.audioFrameOrdinal - actualWarmupFrames,
      maximumMainDataBeginBytes(timeline.samplesPerFrame),
    );
    if (
      prelude.historyFrameLimit !== prelude.warmupFrameLimit + prelude.reservoirFrameLimit ||
      prelude.warmupFrameLimit !== actualWarmupFrames ||
      prelude.reservoirFrameLimit !== actualReservoirFrames ||
      prelude.historyFrameLimit > location.audioFrameOrdinal
    ) {
      throw new RangeError('MP3 scan prelude has inconsistent bounded history');
    }
    anchor = requireIndexPoint(prelude.anchor, timeline.samplesPerFrame, 'MP3 scan prelude anchor');
    if (anchor.frameOrdinal > location.audioFrameOrdinal - prelude.historyFrameLimit) {
      throw new RangeError('MP3 scan anchor begins after its required history window');
    }
    minimumWarmupFrames = prelude.warmupFrameLimit;
    historyFrameLimit = prelude.historyFrameLimit;
  } else {
    throw new TypeError('MP3 reservoir prelude kind is unsupported');
  }

  const plan: Mp3DecoderStartPlan = Object.freeze({
    ...location,
    scanAnchorByteOffset: anchor.byteOffset,
    scanAnchorFrameOrdinal: anchor.frameOrdinal,
    minimumWarmupFrames,
    historyFrameLimit,
  });
  requireStartPlan(plan);
  return plan;
}

function isMessagePort(value: unknown): value is MessagePort {
  return typeof MessagePort !== 'undefined' && value instanceof MessagePort;
}

export function parseMp3DecoderCommand(value: unknown): Readonly<Mp3DecoderCommand> | null {
  const record = snapshotWorkerRecord(value);
  if (
    !record ||
    record.protocolVersion !== MP3_DECODER_PROTOCOL_VERSION ||
    typeof record.type !== 'string'
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
        'descriptor',
        'sourcePort',
        'pcmPort',
      ]) ||
      !isMp3SourceLifetimeGeneration(record.sourceLifetimeGeneration) ||
      !isMp3DecoderGeneration(record.decoderGeneration) ||
      !isMessagePort(record.sourcePort) ||
      !isMessagePort(record.pcmPort) ||
      record.sourcePort === record.pcmPort
    ) {
      return null;
    }
    const descriptor = snapshotMp3DecoderDescriptor(record.descriptor);
    if (!descriptor) return null;
    return Object.freeze({
      ...record,
      descriptor,
    }) as unknown as Readonly<Mp3DecoderOpenCommand>;
  }
  if (record.type === 'stop-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
      ]) ||
      !isMp3SourceLifetimeGeneration(record.sourceLifetimeGeneration) ||
      !isMp3DecoderGeneration(record.decoderGeneration)
    ) {
      return null;
    }
    return Object.freeze({ ...record }) as unknown as Readonly<Mp3DecoderStopCommand>;
  }
  return null;
}

/** Exact transfer list for the atomic fresh-realm handoff. */
export function mp3DecoderCommandTransferables(
  command: Readonly<Mp3DecoderCommand>,
): Transferable[] {
  return command.type === 'open-decoder' ? [command.sourcePort, command.pcmPort] : [];
}

const EVENT_IDENTITY_KEYS = [
  'protocolVersion',
  'type',
  'sourceLifetimeGeneration',
  'decoderGeneration',
] as const;

function hasEventIdentity(record: WorkerRecord): boolean {
  return (
    record.protocolVersion === MP3_DECODER_PROTOCOL_VERSION &&
    isMp3SourceLifetimeGeneration(record.sourceLifetimeGeneration) &&
    isMp3DecoderGeneration(record.decoderGeneration)
  );
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Strict adapter-side parser for control events from the fresh Worker realm. */
export function parseMp3DecoderEvent(value: unknown): Readonly<Mp3DecoderEvent> | null {
  const record = snapshotWorkerRecord(value);
  if (!record || typeof record.type !== 'string' || !hasEventIdentity(record)) return null;

  if (record.type === 'decoder-ready') {
    if (!hasExactKeys(record, [...EVENT_IDENTITY_KEYS, 'descriptor'])) return null;
    const descriptor = snapshotMp3DecoderDescriptor(record.descriptor);
    return descriptor
      ? (Object.freeze({ ...record, descriptor }) as unknown as Readonly<Mp3DecoderEvent>)
      : null;
  }
  if (record.type === 'decode-progress' || record.type === 'decoder-eof') {
    if (
      !hasExactKeys(record, [
        ...EVENT_IDENTITY_KEYS,
        'decodedInputBytes',
        'decodedRawSamples',
        'producedOutputFrames',
      ]) ||
      !validCounter(record.decodedInputBytes) ||
      !validCounter(record.decodedRawSamples) ||
      !validCounter(record.producedOutputFrames)
    ) {
      return null;
    }
    return Object.freeze({ ...record }) as unknown as Readonly<Mp3DecoderEvent>;
  }
  if (record.type === 'decoder-stopped') {
    return hasExactKeys(record, EVENT_IDENTITY_KEYS)
      ? (Object.freeze({ ...record }) as unknown as Readonly<Mp3DecoderEvent>)
      : null;
  }
  if (record.type === 'frame-index-point') {
    if (!hasExactKeys(record, [...EVENT_IDENTITY_KEYS, ...MP3_INDEX_POINT_KEYS])) return null;
    for (const key of MP3_INDEX_POINT_KEYS) {
      if (!validCounter(record[key])) return null;
    }
    const mainDataCapacityBytes = record.mainDataCapacityBytes as number;
    const mainDataBeginBytes = record.mainDataBeginBytes as number;
    if (
      mainDataCapacityBytes === 0 ||
      mainDataCapacityBytes >= MAX_LAYER_3_FRAME_BYTES ||
      mainDataBeginBytes > 511
    ) {
      return null;
    }
    return Object.freeze({ ...record }) as unknown as Readonly<Mp3DecoderEvent>;
  }
  if (record.type === 'decoder-error') {
    if (
      !hasExactKeys(record, [...EVENT_IDENTITY_KEYS, 'code', 'message']) ||
      typeof record.code !== 'string' ||
      record.code.length === 0 ||
      record.code.length > MP3_DECODER_MAX_ERROR_CODE_LENGTH ||
      typeof record.message !== 'string' ||
      record.message.length === 0 ||
      record.message.length > MP3_DECODER_MAX_ERROR_MESSAGE_LENGTH
    ) {
      return null;
    }
    return Object.freeze({ ...record }) as unknown as Readonly<Mp3DecoderEvent>;
  }
  return null;
}

/** Turn one current-realm index event into the exact point accepted by the index. */
export function mp3FrameIndexPointFromEvent(
  event: Extract<Mp3DecoderEvent, { readonly type: 'frame-index-point' }>,
  descriptorValue: Mp3DecoderDescriptor,
): Readonly<MpegLayer3SeekIndexPoint> {
  const descriptor = requireDescriptor(descriptorValue);
  const point = requireIndexPoint(
    {
      rawSample: event.rawSample,
      byteOffset: event.byteOffset,
      frameOrdinal: event.frameOrdinal,
      mainDataCapacityBytes: event.mainDataCapacityBytes,
      mainDataBeginBytes: event.mainDataBeginBytes,
    },
    descriptor.samplesPerFrame,
    'MP3 frame index event',
  );
  if (point.frameOrdinal >= descriptor.audioFrameCount) {
    throw new RangeError('MP3 frame index event exceeds the audio frame count');
  }
  const minimumBytes = minimumFrameBytes(descriptor.samplesPerFrame);
  const bytesBefore = point.byteOffset - descriptor.firstAudioFrameOffset;
  const framesAfter = descriptor.audioFrameCount - point.frameOrdinal;
  const bytesAfter = descriptor.audioEndByteOffset - point.byteOffset;
  if (
    !spanCanContainFrames(bytesBefore, point.frameOrdinal, minimumBytes) ||
    !spanCanContainFrames(bytesAfter, framesAfter, minimumBytes)
  ) {
    throw new RangeError('MP3 frame index event contradicts the encoded source geometry');
  }
  return point;
}

export function sameMp3DecoderDescriptor(left: unknown, right: unknown): boolean {
  const first = snapshotMp3DecoderDescriptor(left);
  const second = snapshotMp3DecoderDescriptor(right);
  if (!first || !second) return false;
  for (const key of MP3_DECODER_DESCRIPTOR_KEYS) {
    if (key === 'timeline' || key === 'startPlan') continue;
    if (first[key] !== second[key]) return false;
  }
  for (const key of MP3_SAMPLE_TIMELINE_KEYS) {
    if (first.timeline[key] !== second.timeline[key]) return false;
  }
  for (const key of MP3_DECODER_START_PLAN_KEYS) {
    if (first.startPlan[key] !== second.startPlan[key]) return false;
  }
  return true;
}
