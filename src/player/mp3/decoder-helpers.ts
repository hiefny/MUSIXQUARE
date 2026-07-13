import { isEncodedAudioSourceIdentity } from '../sources/encoded-audio-source.ts';
import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.ts';
import {
  MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  createMp3DecoderStartPlan,
  snapshotMp3DecoderDescriptor,
  type Mp3DecoderDescriptor,
} from './decoder-protocol.ts';
import type { MpegLayer3FrameHeader, MpegLayer3Version } from './frame-header.ts';
import type { Mp3Metadata } from './metadata.ts';
import {
  MP3_SEEK_INDEX_MAX_POINTS,
  MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES,
  MpegLayer3SeekIndex,
  type MpegLayer3SeekIndexPoint,
} from './seek-index.ts';
import {
  createMp3SampleTimeline,
  locateMp3MediaFrame,
  type Mp3SampleTimeline,
} from './timeline.ts';

export const MP3_DECODER_DEFAULT_WARMUP_FRAMES = 16;

const MAX_LAYER_3_FRAME_BYTES = 1_441;
const MP3_METADATA_CANONICAL_MAX_ENTRIES = 16_384;

const METADATA_KEYS = [
  'format',
  'id3',
  'vbr',
  'gapless',
  'version',
  'sampleRateHz',
  'channels',
  'samplesPerFrame',
  'firstAudioFrameHeader',
  'hasTagFrame',
  'tagFrameOffset',
  'tagFrameBytes',
  'firstAudioFrameOffset',
  'audioEndByteOffset',
  'id3FreeMpegBytes',
  'audioBytes',
  'physicalFrameCount',
  'audioFrameCount',
  'totalRawSamples',
  'totalMediaFrames',
  'durationSeconds',
  'frameCountEvidence',
  'fullyVerifiedFrameSpan',
  'verifiedAudioFrameCount',
  'verifiedAudioBytes',
  'seekPoints',
] as const satisfies readonly (keyof Mp3Metadata)[];

const HEADER_KEYS = [
  'version',
  'layer',
  'bitrateIndex',
  'bitrateKbps',
  'sampleRateIndex',
  'sampleRateHz',
  'channelMode',
  'channelCount',
  'samplesPerFrame',
  'hasCrc',
  'padding',
  'frameLengthBytes',
  'sideInfoBytes',
  'mainDataCapacityBytes',
] as const satisfies readonly (keyof MpegLayer3FrameHeader)[];

const POINT_KEYS = [
  'rawSample',
  'byteOffset',
  'frameOrdinal',
  'mainDataCapacityBytes',
  'mainDataBeginBytes',
] as const satisfies readonly (keyof MpegLayer3SeekIndexPoint)[];

type StrictRecord = Readonly<Record<string, unknown>>;

interface Mp3Geometry {
  readonly sourceSize: number;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  readonly audioFrameCount: number;
  readonly samplesPerFrame: 576 | 1_152;
}

interface ValidatedMetadata {
  readonly metadata: Readonly<Mp3Metadata>;
  readonly timeline: Readonly<Mp3SampleTimeline>;
  readonly geometry: Mp3Geometry;
  readonly metadataSeekPoints: readonly Readonly<MpegLayer3SeekIndexPoint>[];
}

export interface Mp3DecoderPlanningState {
  readonly metadata: Readonly<Mp3Metadata>;
  readonly sourceSize: number;
  readonly timeline: Readonly<Mp3SampleTimeline>;
  /** Mutable only through its bounded verified-point API. */
  readonly seekIndex: MpegLayer3SeekIndex;
  readonly seekPoints: readonly Readonly<MpegLayer3SeekIndexPoint>[];
}

export interface RebuildMp3DecoderPlanningStateOptions {
  readonly metadata: Readonly<Mp3Metadata>;
  readonly sourceSize: number;
  /** Optional progressively enriched exact-point snapshot. */
  readonly seekPoints?: readonly MpegLayer3SeekIndexPoint[];
}

export interface CreateMp3DecoderDescriptorOptions extends RebuildMp3DecoderPlanningStateOptions {
  readonly sourceIdentity: string;
  readonly mediaFrame: number;
  /** Defaults to the encoded sample rate, avoiding an unnecessary resampler. */
  readonly outputSampleRate?: number;
  readonly minimumWarmupFrames?: number;
}

export interface ResolveMp3DecoderPreludeOptions {
  readonly descriptor: Readonly<Mp3DecoderDescriptor>;
  /** Complete rolling point window through the target, oldest first. */
  readonly points: readonly MpegLayer3SeekIndexPoint[];
}

export interface ResolvedMp3DecoderPrelude {
  readonly decodeStart: Readonly<MpegLayer3SeekIndexPoint>;
  readonly warmupStart: Readonly<MpegLayer3SeekIndexPoint>;
  readonly target: Readonly<MpegLayer3SeekIndexPoint>;
  /** Bounded descriptors from decodeStart through target; no encoded bodies. */
  readonly points: readonly Readonly<MpegLayer3SeekIndexPoint>[];
  readonly reservoirCapacityBeforeWarmupBytes: number;
  readonly reachedAudioOrigin: boolean;
  /** Raw decoder-domain samples discarded before the exact media target. */
  readonly discardSamples: number;
  readonly rereadFrameCount: number;
}

export class Mp3DecoderHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp3DecoderHelperError';
  }
}

function snapshotRecord(value: unknown): StrictRecord | null {
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

function snapshotBoundedArray(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  } catch {
    throw new TypeError(`${label} length cannot be inspected safely`);
  }
  const length = lengthDescriptor?.value;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(length) ||
    length < (allowEmpty ? 0 : 1) ||
    length > maximumLength
  ) {
    throw new RangeError(
      `${label} must be a bounded array containing from ${allowEmpty ? 0 : 1} through ${maximumLength} entries`,
    );
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new TypeError(`${label} ${index} cannot be inspected safely`);
    }
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must be a dense data-property array`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function snapshotCanonicalMetadataValue(
  value: unknown,
  label: string,
  budget: { remaining: number },
  stack: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} contains unsupported metadata`);
  }
  if (stack.has(value)) throw new TypeError(`${label} must not contain cycles`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = snapshotBoundedArray(value, label, MP3_SEEK_INDEX_MAX_POINTS, true);
      budget.remaining -= entries.length;
      if (budget.remaining < 0) throw new RangeError(`${label} exceeds its metadata entry bound`);
      const snapshot: unknown[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        snapshot.push(
          snapshotCanonicalMetadataValue(entries[index], `${label} ${index}`, budget, stack),
        );
      }
      return Object.freeze(snapshot);
    }

    const record = snapshotRecord(value);
    if (!record) throw new TypeError(`${label} must contain canonical data records`);
    const keys = Object.keys(record);
    budget.remaining -= keys.length;
    if (budget.remaining < 0) throw new RangeError(`${label} exceeds its metadata entry bound`);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      snapshot[key] = snapshotCanonicalMetadataValue(record[key], `${label}.${key}`, budget, stack);
    }
    return Object.freeze(snapshot);
  } finally {
    stack.delete(value);
  }
}

function snapshotCanonicalMetadataRecord(value: unknown, label: string): StrictRecord {
  const snapshot = snapshotCanonicalMetadataValue(
    value,
    label,
    { remaining: MP3_METADATA_CANONICAL_MAX_ENTRIES },
    new WeakSet<object>(),
  );
  const record = snapshotRecord(snapshot);
  if (!record) throw new TypeError(`${label} must be a metadata record`);
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

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function minimumFrameBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 576 ? 24 : 96;
}

function maximumMainDataBeginBytes(samplesPerFrame: 576 | 1_152): number {
  return samplesPerFrame === 1_152 ? 511 : 255;
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

function mainDataCapacityCanFitFrame(
  samplesPerFrame: 576 | 1_152,
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

function requireVersionGeometry(
  version: unknown,
  sampleRateHz: number,
  samplesPerFrame: 576 | 1_152,
): asserts version is MpegLayer3Version {
  const rates: Readonly<Record<MpegLayer3Version, readonly number[]>> = Object.freeze({
    '1': Object.freeze([32_000, 44_100, 48_000]),
    '2': Object.freeze([16_000, 22_050, 24_000]),
    '2.5': Object.freeze([8_000, 11_025, 12_000]),
  });
  if (version !== '1' && version !== '2' && version !== '2.5') {
    throw new RangeError('MP3 metadata version is unsupported');
  }
  if (!rates[version].includes(sampleRateHz)) {
    throw new RangeError('MP3 metadata sample rate contradicts its MPEG version');
  }
  if (samplesPerFrame !== (version === '1' ? 1_152 : 576)) {
    throw new RangeError('MP3 metadata frame size contradicts its MPEG version');
  }
}

function snapshotPoint(
  value: unknown,
  geometry: Mp3Geometry,
  label: string,
): Readonly<MpegLayer3SeekIndexPoint> {
  const record = requireExactRecord(value, POINT_KEYS, label);
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
    maximumMainDataBeginBytes(geometry.samplesPerFrame),
  );
  if (
    record.frameOrdinal >= geometry.audioFrameCount ||
    record.rawSample !==
      safeMultiply(record.frameOrdinal, geometry.samplesPerFrame, `${label} raw sample`)
  ) {
    throw new Mp3DecoderHelperError(`${label} contradicts the audio frame geometry`);
  }
  if (record.frameOrdinal === 0 && record.mainDataBeginBytes !== 0) {
    throw new Mp3DecoderHelperError(`${label} frame zero references unavailable reservoir data`);
  }
  const minimumBytes = minimumFrameBytes(geometry.samplesPerFrame);
  if (
    !spanCanContainFrames(
      record.byteOffset - geometry.firstAudioFrameOffset,
      record.frameOrdinal,
      minimumBytes,
    ) ||
    !spanCanContainFrames(
      geometry.audioEndByteOffset - record.byteOffset,
      geometry.audioFrameCount - record.frameOrdinal,
      minimumBytes,
    )
  ) {
    throw new Mp3DecoderHelperError(`${label} byte offset contradicts its frame ordinal`);
  }
  if (
    record.frameOrdinal === geometry.audioFrameCount - 1 &&
    !mainDataCapacityCanFitFrame(
      geometry.samplesPerFrame,
      geometry.audioEndByteOffset - record.byteOffset,
      record.mainDataCapacityBytes,
    )
  ) {
    throw new Mp3DecoderHelperError(`${label} terminal frame capacity is inconsistent`);
  }
  return Object.freeze({ ...record }) as unknown as Readonly<MpegLayer3SeekIndexPoint>;
}

function snapshotSeekPoints(
  value: unknown,
  geometry: Mp3Geometry,
  label: string,
): readonly Readonly<MpegLayer3SeekIndexPoint>[] {
  const values = snapshotBoundedArray(value, label, MP3_SEEK_INDEX_MAX_POINTS);
  const points: Readonly<MpegLayer3SeekIndexPoint>[] = [];
  for (let index = 0; index < values.length; index += 1) {
    points.push(snapshotPoint(values[index], geometry, `${label} ${index}`));
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !previous ||
      !current ||
      current.frameOrdinal <= previous.frameOrdinal ||
      current.rawSample <= previous.rawSample ||
      current.byteOffset <= previous.byteOffset
    ) {
      throw new Mp3DecoderHelperError(`${label} must be strictly ordered without duplicates`);
    }
    if (
      current.frameOrdinal === previous.frameOrdinal + 1 &&
      !mainDataCapacityCanFitFrame(
        geometry.samplesPerFrame,
        current.byteOffset - previous.byteOffset,
        previous.mainDataCapacityBytes,
      )
    ) {
      throw new Mp3DecoderHelperError(`${label} has an impossible contiguous frame capacity`);
    }
  }
  return Object.freeze(points);
}

function requireHeader(
  value: unknown,
  version: MpegLayer3Version,
  sampleRateHz: number,
  channels: 1 | 2,
  samplesPerFrame: 576 | 1_152,
): Readonly<MpegLayer3FrameHeader> {
  const record = requireExactRecord(value, HEADER_KEYS, 'MP3 first audio frame header');
  if (
    record.version !== version ||
    record.layer !== 3 ||
    record.sampleRateHz !== sampleRateHz ||
    record.channelCount !== channels ||
    record.samplesPerFrame !== samplesPerFrame ||
    typeof record.hasCrc !== 'boolean' ||
    typeof record.padding !== 'boolean'
  ) {
    throw new Mp3DecoderHelperError('MP3 first audio frame header contradicts metadata');
  }
  requireSafeInteger(record.bitrateIndex, 'MP3 bitrateIndex', 1, 14);
  requireSafeInteger(record.bitrateKbps, 'MP3 bitrateKbps', 1);
  requireSafeInteger(record.sampleRateIndex, 'MP3 sampleRateIndex', 0, 2);
  requireSafeInteger(record.frameLengthBytes, 'MP3 first frame length', 1, MAX_LAYER_3_FRAME_BYTES);
  requireSafeInteger(record.mainDataCapacityBytes, 'MP3 first main-data capacity', 1);
  if (
    !mainDataCapacityCanFitFrame(
      samplesPerFrame,
      record.frameLengthBytes,
      record.mainDataCapacityBytes,
    )
  ) {
    throw new Mp3DecoderHelperError('MP3 first frame main-data capacity is inconsistent');
  }
  return Object.freeze({ ...record }) as unknown as Readonly<MpegLayer3FrameHeader>;
}

function validateMetadata(metadataValue: unknown, sourceSizeValue: unknown): ValidatedMetadata {
  requireSafeInteger(sourceSizeValue, 'MP3 source size', 1);
  const record = requireExactRecord(metadataValue, METADATA_KEYS, 'MP3 metadata');
  if (record.format !== 'mp3') throw new TypeError('MP3 metadata format is invalid');
  requireSafeInteger(record.sampleRateHz, 'MP3 metadata sampleRateHz', 1);
  if (record.channels !== 1 && record.channels !== 2) {
    throw new RangeError('MP3 metadata channels must be one or two');
  }
  if (record.samplesPerFrame !== 576 && record.samplesPerFrame !== 1_152) {
    throw new RangeError('MP3 metadata samplesPerFrame must be 576 or 1152');
  }
  requireVersionGeometry(record.version, record.sampleRateHz, record.samplesPerFrame);
  requireSafeInteger(record.firstAudioFrameOffset, 'MP3 first audio frame offset', 0);
  requireSafeInteger(record.audioEndByteOffset, 'MP3 audio end offset', 1, sourceSizeValue);
  requireSafeInteger(record.audioFrameCount, 'MP3 audio frame count', 1);
  requireSafeInteger(record.physicalFrameCount, 'MP3 physical frame count', 1);
  requireSafeInteger(record.totalRawSamples, 'MP3 total raw samples', 1);
  requireSafeInteger(record.totalMediaFrames, 'MP3 total media frames', 1);
  requireSafeInteger(record.id3FreeMpegBytes, 'MP3 ID3-free byte count', 1);
  requireSafeInteger(record.audioBytes, 'MP3 audio byte count', 1);
  requireSafeInteger(record.tagFrameBytes, 'MP3 tag frame byte count', 0);
  requireSafeInteger(record.verifiedAudioFrameCount, 'MP3 verified audio frame count', 1);
  requireSafeInteger(record.verifiedAudioBytes, 'MP3 verified audio byte count', 1);
  if (typeof record.fullyVerifiedFrameSpan !== 'boolean') {
    throw new TypeError('MP3 fullyVerifiedFrameSpan must be boolean');
  }
  if (
    record.frameCountEvidence !== 'verified-scan' &&
    record.frameCountEvidence !== 'xing' &&
    record.frameCountEvidence !== 'info' &&
    record.frameCountEvidence !== 'vbri'
  ) {
    throw new TypeError('MP3 frame-count evidence is invalid');
  }
  if (record.hasTagFrame !== true && record.hasTagFrame !== false) {
    throw new TypeError('MP3 hasTagFrame must be boolean');
  }
  if (typeof record.durationSeconds !== 'number' || !Number.isFinite(record.durationSeconds)) {
    throw new RangeError('MP3 duration must be finite');
  }

  const id3 = snapshotCanonicalMetadataRecord(record.id3, 'MP3 ID3 boundary metadata');
  requireSafeInteger(id3.sourceBytes, 'MP3 ID3 sourceBytes', 1);
  requireSafeInteger(id3.dataStart, 'MP3 ID3 dataStart', 0, id3.sourceBytes);
  requireSafeInteger(id3.audioEnd, 'MP3 ID3 audioEnd', 1, id3.sourceBytes);
  if (id3.sourceBytes !== sourceSizeValue || id3.audioEnd !== record.audioEndByteOffset) {
    throw new Mp3DecoderHelperError('MP3 metadata is bound to a different source size');
  }

  const expectedTagFrames = record.hasTagFrame ? 1 : 0;
  if (
    record.physicalFrameCount !== record.audioFrameCount + expectedTagFrames ||
    record.id3FreeMpegBytes !== id3.audioEnd - id3.dataStart ||
    record.audioBytes !== record.audioEndByteOffset - record.firstAudioFrameOffset ||
    record.totalRawSamples !==
      safeMultiply(record.audioFrameCount, record.samplesPerFrame, 'MP3 total raw samples')
  ) {
    throw new Mp3DecoderHelperError('MP3 metadata byte or frame totals are inconsistent');
  }
  if (record.hasTagFrame) {
    if (
      record.vbr === null ||
      record.tagFrameOffset !== id3.dataStart ||
      record.tagFrameBytes <= 0 ||
      record.firstAudioFrameOffset !== id3.dataStart + record.tagFrameBytes
    ) {
      throw new Mp3DecoderHelperError('MP3 structural tag-frame geometry is inconsistent');
    }
  } else if (
    record.vbr !== null ||
    record.tagFrameOffset !== null ||
    record.tagFrameBytes !== 0 ||
    record.firstAudioFrameOffset !== id3.dataStart
  ) {
    throw new Mp3DecoderHelperError('MP3 tag-free geometry is inconsistent');
  }

  const vbr =
    record.vbr === null ? null : snapshotCanonicalMetadataRecord(record.vbr, 'MP3 VBR metadata');
  const gapless =
    record.gapless === null
      ? null
      : snapshotCanonicalMetadataRecord(record.gapless, 'MP3 gapless metadata');
  if (vbr) {
    if (vbr.kind !== 'xing' && vbr.kind !== 'vbri') {
      throw new TypeError('MP3 VBR metadata kind is invalid');
    }
    if (
      (vbr.kind === 'xing' && vbr.identifier !== 'Xing' && vbr.identifier !== 'Info') ||
      (vbr.kind === 'vbri' && vbr.identifier !== 'VBRI')
    ) {
      throw new Mp3DecoderHelperError('MP3 VBR metadata identifier contradicts its kind');
    }
    if (vbr.frameCount !== null) {
      requireSafeInteger(vbr.frameCount, 'MP3 VBR frame count', 1);
      if (vbr.frameCount !== record.audioFrameCount) {
        throw new Mp3DecoderHelperError('MP3 VBR frame count contradicts normalized metadata');
      }
    } else if (vbr.kind === 'vbri') {
      throw new Mp3DecoderHelperError('MP3 VBRI metadata is missing its frame count');
    }
    if (vbr.streamBytes !== null) {
      requireSafeInteger(vbr.streamBytes, 'MP3 VBR stream byte count', 1);
      if (vbr.streamBytes !== record.id3FreeMpegBytes) {
        throw new Mp3DecoderHelperError('MP3 VBR stream bytes contradict normalized metadata');
      }
    } else if (vbr.kind === 'vbri') {
      throw new Mp3DecoderHelperError('MP3 VBRI metadata is missing its stream byte count');
    }
  }
  if (record.frameCountEvidence !== 'verified-scan') {
    const expectedEvidence =
      vbr?.kind === 'vbri' ? 'vbri' : vbr?.identifier === 'Info' ? 'info' : 'xing';
    if (!vbr || vbr.frameCount === null || record.frameCountEvidence !== expectedEvidence) {
      throw new Mp3DecoderHelperError('MP3 frame-count evidence lacks its matching declaration');
    }
  }
  if (gapless) {
    requireSafeInteger(gapless.encoderDelaySamples, 'MP3 encoder delay', 0);
    requireSafeInteger(gapless.endPaddingSamples, 'MP3 end padding', 0);
    const vbrGapless = vbr?.kind === 'xing' ? snapshotRecord(vbr.gapless) : null;
    if (
      !vbrGapless ||
      vbrGapless.encoderDelaySamples !== gapless.encoderDelaySamples ||
      vbrGapless.endPaddingSamples !== gapless.endPaddingSamples
    ) {
      throw new Mp3DecoderHelperError('MP3 gapless metadata is not backed by its Xing tag');
    }
  } else if (vbr?.kind === 'xing' && vbr.gapless !== null) {
    throw new Mp3DecoderHelperError('MP3 Xing gapless metadata was not normalized consistently');
  }

  const timeline = createMp3SampleTimeline({
    totalRawSamples: record.totalRawSamples,
    samplesPerFrame: record.samplesPerFrame,
    gapless: gapless
      ? {
          encoderDelaySamples: gapless.encoderDelaySamples as number,
          endPaddingSamples: gapless.endPaddingSamples as number,
        }
      : null,
  });
  if (
    timeline.totalMediaFrames !== record.totalMediaFrames ||
    record.durationSeconds !== record.totalMediaFrames / record.sampleRateHz
  ) {
    throw new Mp3DecoderHelperError('MP3 media timeline contradicts normalized metadata');
  }
  if (
    record.verifiedAudioFrameCount > record.audioFrameCount ||
    record.verifiedAudioBytes > record.audioBytes ||
    (record.fullyVerifiedFrameSpan &&
      (record.verifiedAudioFrameCount !== record.audioFrameCount ||
        record.verifiedAudioBytes !== record.audioBytes)) ||
    (record.frameCountEvidence === 'verified-scan') !== record.fullyVerifiedFrameSpan
  ) {
    throw new Mp3DecoderHelperError('MP3 verified-span evidence is inconsistent');
  }

  const header = requireHeader(
    record.firstAudioFrameHeader,
    record.version,
    record.sampleRateHz,
    record.channels,
    record.samplesPerFrame,
  );
  const geometry: Mp3Geometry = Object.freeze({
    sourceSize: sourceSizeValue,
    firstAudioFrameOffset: record.firstAudioFrameOffset,
    audioEndByteOffset: record.audioEndByteOffset,
    audioFrameCount: record.audioFrameCount,
    samplesPerFrame: record.samplesPerFrame,
  });
  const minimumBytes = minimumFrameBytes(geometry.samplesPerFrame);
  if (
    geometry.firstAudioFrameOffset >= geometry.audioEndByteOffset ||
    !spanCanContainFrames(record.audioBytes, geometry.audioFrameCount, minimumBytes)
  ) {
    throw new Mp3DecoderHelperError('MP3 audio span contradicts its frame count');
  }
  const metadataSeekPoints = snapshotSeekPoints(
    record.seekPoints,
    geometry,
    'MP3 metadata seek point',
  );
  const verifiedAudioFrameCount = record.verifiedAudioFrameCount as number;
  const verifiedAudioBytes = record.verifiedAudioBytes as number;
  const verifiedAudioEnd = safeAdd(
    geometry.firstAudioFrameOffset,
    verifiedAudioBytes,
    'MP3 verified audio end',
  );
  const remainingVerifiedFrames = geometry.audioFrameCount - verifiedAudioFrameCount;
  const remainingVerifiedBytes = record.audioBytes - verifiedAudioBytes;
  if (
    verifiedAudioEnd > geometry.audioEndByteOffset ||
    !spanCanContainFrames(verifiedAudioBytes, verifiedAudioFrameCount, minimumBytes) ||
    !spanCanContainFrames(remainingVerifiedBytes, remainingVerifiedFrames, minimumBytes)
  ) {
    throw new Mp3DecoderHelperError('MP3 verified prefix contradicts the audio geometry');
  }
  if (
    metadataSeekPoints.some(
      (point) =>
        point.frameOrdinal >= verifiedAudioFrameCount || point.byteOffset >= verifiedAudioEnd,
    )
  ) {
    throw new Mp3DecoderHelperError('MP3 metadata seek point exceeds its verified prefix');
  }
  const origin = metadataSeekPoints[0];
  if (
    !origin ||
    origin.frameOrdinal !== 0 ||
    origin.rawSample !== 0 ||
    origin.byteOffset !== geometry.firstAudioFrameOffset ||
    origin.mainDataCapacityBytes !== header.mainDataCapacityBytes ||
    origin.mainDataBeginBytes !== 0
  ) {
    throw new Mp3DecoderHelperError('MP3 metadata seek index has an invalid audio origin');
  }

  return Object.freeze({
    metadata: Object.freeze({
      ...record,
      id3,
      vbr,
      gapless,
      firstAudioFrameHeader: header,
      seekPoints: metadataSeekPoints,
    }) as unknown as Readonly<Mp3Metadata>,
    timeline,
    geometry,
    metadataSeekPoints,
  });
}

function buildIndex(
  validated: ValidatedMetadata,
  seekPointsValue?: readonly MpegLayer3SeekIndexPoint[],
): Mp3DecoderPlanningState {
  const points =
    seekPointsValue === undefined
      ? validated.metadataSeekPoints
      : snapshotSeekPoints(seekPointsValue, validated.geometry, 'MP3 decoder seek point');
  const origin = points[0];
  const metadataOrigin = validated.metadataSeekPoints[0];
  if (
    !origin ||
    !metadataOrigin ||
    origin.rawSample !== metadataOrigin.rawSample ||
    origin.byteOffset !== metadataOrigin.byteOffset ||
    origin.frameOrdinal !== metadataOrigin.frameOrdinal ||
    origin.mainDataCapacityBytes !== metadataOrigin.mainDataCapacityBytes ||
    origin.mainDataBeginBytes !== metadataOrigin.mainDataBeginBytes
  ) {
    throw new Mp3DecoderHelperError('MP3 decoder seek points do not preserve metadata origin');
  }
  const index = new MpegLayer3SeekIndex({
    sourceSize: validated.geometry.sourceSize,
    firstAudioFrameOffset: validated.geometry.firstAudioFrameOffset,
    audioEndByteOffset: validated.geometry.audioEndByteOffset,
    totalRawSamples: validated.timeline.totalRawSamples,
    samplesPerFrame: validated.geometry.samplesPerFrame,
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
      throw new Mp3DecoderHelperError('MP3 decoder seek point contradicts the source geometry');
    }
  }
  const snapshot = index.snapshot();
  if (snapshot.length !== points.length) {
    throw new Mp3DecoderHelperError('MP3 decoder seek points were not rebuilt exactly');
  }
  return Object.freeze({
    metadata: validated.metadata,
    sourceSize: validated.geometry.sourceSize,
    timeline: validated.timeline,
    seekIndex: index,
    seekPoints: snapshot,
  });
}

export function rebuildMp3DecoderPlanningState(
  options: RebuildMp3DecoderPlanningStateOptions,
): Readonly<Mp3DecoderPlanningState> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('MP3 decoder planning options are missing');
  }
  const validated = validateMetadata(options.metadata, options.sourceSize);
  return buildIndex(validated, options.seekPoints);
}

export function createMp3DecoderDescriptor(
  options: CreateMp3DecoderDescriptorOptions,
): Readonly<Mp3DecoderDescriptor> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('MP3 decoder descriptor options are missing');
  }
  if (!isEncodedAudioSourceIdentity(options.sourceIdentity)) {
    throw new TypeError('MP3 decoder source identity is invalid');
  }
  const planning = rebuildMp3DecoderPlanningState(options);
  const outputSampleRate = options.outputSampleRate ?? planning.metadata.sampleRateHz;
  requireSafeInteger(
    outputSampleRate,
    'MP3 output sample rate',
    1,
    MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  );
  const minimumWarmupFrames = options.minimumWarmupFrames ?? MP3_DECODER_DEFAULT_WARMUP_FRAMES;
  requireSafeInteger(
    minimumWarmupFrames,
    'MP3 minimum warmup frames',
    0,
    MP3_SEEK_MAX_SYNTHESIS_WARMUP_FRAMES,
  );
  requireSafeInteger(options.mediaFrame, 'MP3 target media frame', 0);
  if (options.mediaFrame >= planning.timeline.totalMediaFrames) {
    throw new RangeError('MP3 exclusive media EOF cannot create a decoder descriptor');
  }
  const location = locateMp3MediaFrame(planning.timeline, options.mediaFrame);
  const targetFrameRawSample = safeMultiply(
    location.audioFrameOrdinal,
    planning.timeline.samplesPerFrame,
    'MP3 target frame raw sample',
  );
  const prelude = planning.seekIndex.reservoirPrelude(targetFrameRawSample, minimumWarmupFrames);
  const startPlan = createMp3DecoderStartPlan(planning.timeline, options.mediaFrame, prelude);
  const descriptor: Mp3DecoderDescriptor = Object.freeze({
    format: 'mp3',
    sourceSize: planning.sourceSize,
    sourceIdentity: options.sourceIdentity,
    version: planning.metadata.version,
    sourceSampleRate: planning.metadata.sampleRateHz,
    outputSampleRate,
    channels: planning.metadata.channels,
    samplesPerFrame: planning.metadata.samplesPerFrame,
    firstAudioFrameOffset: planning.metadata.firstAudioFrameOffset,
    audioEndByteOffset: planning.metadata.audioEndByteOffset,
    audioFrameCount: planning.metadata.audioFrameCount,
    timeline: planning.timeline,
    startPlan,
  });
  const snapshot = snapshotMp3DecoderDescriptor(descriptor);
  if (!snapshot) throw new Mp3DecoderHelperError('MP3 decoder descriptor failed validation');
  return snapshot;
}

function requireDescriptor(value: unknown): Readonly<Mp3DecoderDescriptor> {
  const descriptor = snapshotMp3DecoderDescriptor(value);
  if (!descriptor) throw new TypeError('A valid MP3 decoder descriptor is required');
  return descriptor;
}

export function remainingMp3SourceFrames(descriptorValue: Mp3DecoderDescriptor): number {
  const descriptor = requireDescriptor(descriptorValue);
  return descriptor.timeline.totalMediaFrames - descriptor.startPlan.mediaFrame;
}

export function expectedMp3OutputFrames(descriptorValue: Mp3DecoderDescriptor): number {
  const descriptor = requireDescriptor(descriptorValue);
  if (descriptor.sourceSampleRate === descriptor.outputSampleRate) {
    return remainingMp3SourceFrames(descriptor);
  }
  return expectedLanczosOutputFrames({
    inputSampleRate: descriptor.sourceSampleRate,
    outputSampleRate: descriptor.outputSampleRate,
    totalSourceFrames: descriptor.timeline.totalMediaFrames,
    startSourceFrame: descriptor.startPlan.mediaFrame,
  });
}

export function resolveMp3DecoderPrelude(
  options: ResolveMp3DecoderPreludeOptions,
): Readonly<ResolvedMp3DecoderPrelude> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('MP3 decoder prelude options are missing');
  }
  const descriptor = requireDescriptor(options.descriptor);
  const { startPlan } = descriptor;
  const pointValues = snapshotBoundedArray(
    options.points,
    'MP3 decoder prelude point window',
    startPlan.historyFrameLimit + 1,
  );
  const geometry: Mp3Geometry = Object.freeze({
    sourceSize: descriptor.sourceSize,
    firstAudioFrameOffset: descriptor.firstAudioFrameOffset,
    audioEndByteOffset: descriptor.audioEndByteOffset,
    audioFrameCount: descriptor.audioFrameCount,
    samplesPerFrame: descriptor.samplesPerFrame,
  });
  const points: Readonly<MpegLayer3SeekIndexPoint>[] = [];
  for (let index = 0; index < pointValues.length; index += 1) {
    points.push(snapshotPoint(pointValues[index], geometry, `MP3 decoder rolling point ${index}`));
  }
  const expectedFirstOrdinal = Math.max(
    startPlan.scanAnchorFrameOrdinal,
    startPlan.audioFrameOrdinal - startPlan.historyFrameLimit,
  );
  const expectedLength = startPlan.audioFrameOrdinal - expectedFirstOrdinal + 1;
  if (
    points.length !== expectedLength ||
    points[0]?.frameOrdinal !== expectedFirstOrdinal ||
    points.at(-1)?.frameOrdinal !== startPlan.audioFrameOrdinal
  ) {
    throw new Mp3DecoderHelperError('MP3 decoder rolling window is incomplete for its target');
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !previous ||
      !current ||
      current.frameOrdinal !== previous.frameOrdinal + 1 ||
      current.rawSample !== previous.rawSample + descriptor.samplesPerFrame ||
      current.byteOffset <= previous.byteOffset ||
      !mainDataCapacityCanFitFrame(
        descriptor.samplesPerFrame,
        current.byteOffset - previous.byteOffset,
        previous.mainDataCapacityBytes,
      )
    ) {
      throw new Mp3DecoderHelperError('MP3 decoder rolling points are not contiguous');
    }
  }
  const first = points[0];
  if (
    expectedFirstOrdinal === startPlan.scanAnchorFrameOrdinal &&
    first?.byteOffset !== startPlan.scanAnchorByteOffset
  ) {
    throw new Mp3DecoderHelperError('MP3 decoder rolling window changed its scan anchor');
  }

  const targetIndex = points.length - 1;
  const target = points[targetIndex];
  const warmupStartIndex = targetIndex - startPlan.minimumWarmupFrames;
  const warmupStart = points[warmupStartIndex];
  if (!target || !warmupStart) {
    throw new Mp3DecoderHelperError('MP3 decoder rolling window cannot satisfy its warmup');
  }

  let decodeStartIndex = warmupStartIndex;
  let reservoirCapacityBeforeWarmupBytes = 0;
  while (reservoirCapacityBeforeWarmupBytes < warmupStart.mainDataBeginBytes) {
    if (decodeStartIndex === 0) {
      throw new Mp3DecoderHelperError(
        points[0]?.frameOrdinal === 0
          ? 'MP3 reservoir requirement exceeds all capacity available from the audio origin'
          : 'MP3 rolling history does not contain a reservoir-complete prelude',
      );
    }
    decodeStartIndex -= 1;
    const history = points[decodeStartIndex];
    if (!history) throw new Mp3DecoderHelperError('MP3 decoder rolling history was lost');
    reservoirCapacityBeforeWarmupBytes = safeAdd(
      reservoirCapacityBeforeWarmupBytes,
      history.mainDataCapacityBytes,
      'MP3 reservoir capacity',
    );
  }

  const decodeStart = points[decodeStartIndex];
  if (!decodeStart) throw new Mp3DecoderHelperError('MP3 decoder prelude start was lost');
  const discardSamples = startPlan.rawSample - decodeStart.rawSample;
  if (!Number.isSafeInteger(discardSamples) || discardSamples < 0) {
    throw new Mp3DecoderHelperError('MP3 decoder discard count is invalid');
  }
  const selectedPoints = Object.freeze(points.slice(decodeStartIndex));
  return Object.freeze({
    decodeStart,
    warmupStart,
    target,
    points: selectedPoints,
    reservoirCapacityBeforeWarmupBytes,
    reachedAudioOrigin: decodeStart.frameOrdinal === 0,
    discardSamples,
    rereadFrameCount: target.frameOrdinal - decodeStart.frameOrdinal + 1,
  });
}
