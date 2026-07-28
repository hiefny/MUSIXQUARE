import {
  parseCanonicalAacLcAudioSpecificConfig,
  type AacLcAudioSpecificConfigDescription,
} from '../aac/audio-specific-config.ts';
import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import {
  EncodedSourceIntegrityError,
  type EncodedRandomAccessSource,
  throwIfAborted,
} from '../sources/encoded-audio-source.ts';
import {
  readM4aChunkIndex,
  snapshotM4aChunkIndex,
  validateM4aChunkIndexSnapshot,
  type M4aChunkIndexSnapshot,
} from './chunk-index.ts';
import { readM4aContainerLayout } from './container-layout.ts';
import { readM4aITunSmpb } from './itunes-gapless.ts';
import { readM4aMovieLayout } from './movie-layout.ts';
import { readM4aAacRollRecoveryEvidence } from './roll-recovery.ts';
import { readM4aAacLcSampleDescription } from './sample-entry.ts';
import {
  readM4aSampleSizeIndex,
  readM4aSampleToChunkRuns,
  snapshotM4aSampleSizeIndex,
  validateM4aIndexSourceBinding,
  validateM4aSampleSizeIndexSnapshot,
  type M4aSampleSizeIndexSnapshot,
} from './sample-size-index.ts';
import { readM4aAacSttsEvidence, readM4aSampleTableLayout } from './sample-table-layout.ts';
import {
  M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
  M4A_AAC_MAX_ACCESS_UNITS,
  M4A_AAC_MAX_STTS_ENTRIES,
  normalizeM4aAacTimeline,
  type M4aAacTimeline,
} from './timeline.ts';

export const M4A_AAC_LC_MANIFEST_VERSION = 1 as const;

export interface M4aAacLcContainerManifest {
  readonly majorBrand: string;
  readonly minorVersion: number;
  readonly compatibleBrands: readonly string[];
}

export interface M4aAacLcCodecManifest {
  readonly codec: 'mp4a.40.2';
  readonly sampleRateHz: number;
  readonly channelCount: 1 | 2;
  readonly audioSpecificConfig: AacLcAudioSpecificConfigDescription;
  readonly esId: number;
  readonly bufferSizeDb: number;
  readonly maxBitrate: number;
  readonly averageBitrate: number;
}

export interface M4aAacLcManifest {
  readonly manifestVersion: typeof M4A_AAC_LC_MANIFEST_VERSION;
  readonly format: 'm4a-aac-lc';
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly container: Readonly<M4aAacLcContainerManifest>;
  readonly codec: Readonly<M4aAacLcCodecManifest>;
  readonly timeline: Readonly<M4aAacTimeline>;
  readonly rollRecovery: Readonly<{ readonly requiredPrerollAccessUnits: 1 }> | null;
  readonly sampleSizes: Readonly<M4aSampleSizeIndexSnapshot>;
  readonly chunks: Readonly<M4aChunkIndexSnapshot>;
}

const issuedManifests = new WeakSet<object>();

const MANIFEST_KEYS = Object.freeze([
  'manifestVersion',
  'format',
  'sourceSize',
  'sourceIdentity',
  'container',
  'codec',
  'timeline',
  'rollRecovery',
  'sampleSizes',
  'chunks',
] as const);
const CONTAINER_KEYS = Object.freeze(['majorBrand', 'minorVersion', 'compatibleBrands'] as const);
const CODEC_KEYS = Object.freeze([
  'codec',
  'sampleRateHz',
  'channelCount',
  'audioSpecificConfig',
  'esId',
  'bufferSizeDb',
  'maxBitrate',
  'averageBitrate',
] as const);
const TIMELINE_KEYS = Object.freeze([
  'accessUnitCount',
  'sttsEntryCount',
  'finalAccessUnitDelta',
  'coreFramesPerAccessUnit',
  'rawCoreFrames',
  'presentationEndCoreFrames',
  'headTrimCoreFrames',
  'tailTrimCoreFrames',
  'totalMediaFrames',
  'sampleRateHz',
] as const satisfies readonly (keyof M4aAacTimeline)[]);
const ROLL_RECOVERY_KEYS = Object.freeze(['requiredPrerollAccessUnits'] as const);
const MAX_COMPATIBLE_BRANDS = 1_022;

export class M4aAacLcManifestError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aAacLcManifestError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

function manifestError(message: string, cause?: unknown): M4aAacLcManifestError {
  return new M4aAacLcManifestError(message, cause);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw manifestError(`${label} must be an exact plain data record`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw manifestError(`${label} must not be a class instance`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      throw manifestError(`${label} must contain exactly its canonical keys`);
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw manifestError(`${label}.${key} must be own enumerable data`);
      }
      record[key] = descriptor.value;
    }
    return Object.freeze(record);
  } catch (error) {
    if (error instanceof M4aAacLcManifestError) throw error;
    throw manifestError(`${label} could not be inspected safely`, error);
  }
}

function denseDataArray(value: unknown, maximumLength: number, label: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw manifestError(`${label} must be a plain array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors.length;
    const lengthValue: unknown = lengthDescriptor?.value;
    if (
      typeof lengthValue !== 'number' ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > maximumLength
    ) {
      throw manifestError(`${label} length exceeds its canonical bound`);
    }
    const length = lengthValue;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== length + 1 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) < 0 || Number(key) >= length)),
      )
    ) {
      throw manifestError(`${label} must be dense and contain no extra properties`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw manifestError(`${label}[${index}] must be own enumerable data`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof M4aAacLcManifestError) throw error;
    throw manifestError(`${label} could not be inspected safely`, error);
  }
}

function manifestInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw manifestError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function safeManifestMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw manifestError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function safeManifestAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw manifestError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function fourCc(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 4) {
    throw manifestError(`${label} must be a four-character code`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) {
      throw manifestError(`${label} must contain only ISO BMFF byte characters`);
    }
  }
  return value;
}

function copyDescription(
  description: AacLcAudioSpecificConfigDescription,
): AacLcAudioSpecificConfigDescription {
  return Object.freeze([...description]) as AacLcAudioSpecificConfigDescription;
}

function copyTimeline(timeline: Readonly<M4aAacTimeline>): Readonly<M4aAacTimeline> {
  return Object.freeze({
    accessUnitCount: timeline.accessUnitCount,
    sttsEntryCount: timeline.sttsEntryCount,
    finalAccessUnitDelta: timeline.finalAccessUnitDelta,
    coreFramesPerAccessUnit: timeline.coreFramesPerAccessUnit,
    rawCoreFrames: timeline.rawCoreFrames,
    presentationEndCoreFrames: timeline.presentationEndCoreFrames,
    headTrimCoreFrames: timeline.headTrimCoreFrames,
    tailTrimCoreFrames: timeline.tailTrimCoreFrames,
    totalMediaFrames: timeline.totalMediaFrames,
    sampleRateHz: timeline.sampleRateHz,
  });
}

function copySampleSizes(
  snapshot: Readonly<M4aSampleSizeIndexSnapshot>,
): Readonly<M4aSampleSizeIndexSnapshot> {
  return Object.freeze({
    sampleCount: snapshot.sampleCount,
    fixedSampleSizeBytes: snapshot.fixedSampleSizeBytes,
    entryTableStart: snapshot.entryTableStart,
    totalEncodedBytes: snapshot.totalEncodedBytes,
    checkpointStride: snapshot.checkpointStride,
    checkpoints: Object.freeze(
      snapshot.checkpoints.map((checkpoint) =>
        Object.freeze({
          ordinal: checkpoint.ordinal,
          prefixBytes: checkpoint.prefixBytes,
        }),
      ),
    ),
    headerSha256: snapshot.headerSha256,
    pages: Object.freeze(
      snapshot.pages.map((page) =>
        Object.freeze({
          firstSampleOrdinal: page.firstSampleOrdinal,
          sampleCount: page.sampleCount,
          sha256: page.sha256,
        }),
      ),
    ),
  });
}

function copyChunks(snapshot: Readonly<M4aChunkIndexSnapshot>): Readonly<M4aChunkIndexSnapshot> {
  return Object.freeze({
    sampleCount: snapshot.sampleCount,
    chunkCount: snapshot.chunkCount,
    chunkOffsetWidthBytes: snapshot.chunkOffsetWidthBytes,
    chunkOffsetTableStart: snapshot.chunkOffsetTableStart,
    headerSha256: snapshot.headerSha256,
    sampleToChunk: Object.freeze({
      bodyStart: snapshot.sampleToChunk.bodyStart,
      bodyLength: snapshot.sampleToChunk.bodyLength,
      sha256: snapshot.sampleToChunk.sha256,
    }),
    runs: Object.freeze(
      snapshot.runs.map((run) =>
        Object.freeze({
          firstChunk: run.firstChunk,
          endChunkExclusive: run.endChunkExclusive,
          firstSampleOrdinal: run.firstSampleOrdinal,
          samplesPerChunk: run.samplesPerChunk,
        }),
      ),
    ),
    mediaDataRanges: Object.freeze(
      snapshot.mediaDataRanges.map((range) =>
        Object.freeze({ start: range.start, end: range.end }),
      ),
    ),
    pages: Object.freeze(
      snapshot.pages.map((page) =>
        Object.freeze({
          firstChunkOrdinal: page.firstChunkOrdinal,
          entryCount: page.entryCount,
          sha256: page.sha256,
        }),
      ),
    ),
  });
}

function copyManifest(manifest: Readonly<M4aAacLcManifest>): Readonly<M4aAacLcManifest> {
  return Object.freeze({
    manifestVersion: M4A_AAC_LC_MANIFEST_VERSION,
    format: 'm4a-aac-lc',
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
    container: Object.freeze({
      majorBrand: manifest.container.majorBrand,
      minorVersion: manifest.container.minorVersion,
      compatibleBrands: Object.freeze([...manifest.container.compatibleBrands]),
    }),
    codec: Object.freeze({
      codec: 'mp4a.40.2',
      sampleRateHz: manifest.codec.sampleRateHz,
      channelCount: manifest.codec.channelCount,
      audioSpecificConfig: copyDescription(manifest.codec.audioSpecificConfig),
      esId: manifest.codec.esId,
      bufferSizeDb: manifest.codec.bufferSizeDb,
      maxBitrate: manifest.codec.maxBitrate,
      averageBitrate: manifest.codec.averageBitrate,
    }),
    timeline: copyTimeline(manifest.timeline),
    rollRecovery:
      manifest.rollRecovery === null
        ? null
        : Object.freeze({ requiredPrerollAccessUnits: 1 as const }),
    sampleSizes: copySampleSizes(manifest.sampleSizes),
    chunks: copyChunks(manifest.chunks),
  });
}

function validateContainerManifest(value: unknown): Readonly<M4aAacLcContainerManifest> {
  const record = exactDataRecord(value, CONTAINER_KEYS, 'M4A container manifest');
  const brands = denseDataArray(
    record.compatibleBrands,
    MAX_COMPATIBLE_BRANDS,
    'M4A compatible brands',
  ).map((brand, index) => fourCc(brand, `M4A compatible brand ${index}`));
  return Object.freeze({
    majorBrand: fourCc(record.majorBrand, 'M4A major brand'),
    minorVersion: manifestInteger(record.minorVersion, 0, 0xffff_ffff, 'M4A minor version'),
    compatibleBrands: Object.freeze(brands),
  });
}

function validateCodecManifest(value: unknown): Readonly<M4aAacLcCodecManifest> {
  const record = exactDataRecord(value, CODEC_KEYS, 'M4A AAC codec manifest');
  if (record.codec !== 'mp4a.40.2') {
    throw manifestError('M4A AAC codec manifest must use mp4a.40.2');
  }
  const descriptionValues = denseDataArray(
    record.audioSpecificConfig,
    5,
    'M4A AAC AudioSpecificConfig',
  );
  if (descriptionValues.length !== 2 && descriptionValues.length !== 5) {
    throw manifestError('M4A AAC AudioSpecificConfig must contain exactly two or five bytes');
  }
  const descriptionBytes = new Uint8Array(descriptionValues.length);
  for (let index = 0; index < descriptionValues.length; index += 1) {
    descriptionBytes[index] = manifestInteger(
      descriptionValues[index],
      0,
      0xff,
      `M4A AAC AudioSpecificConfig byte ${index}`,
    );
  }
  let parsed: ReturnType<typeof parseCanonicalAacLcAudioSpecificConfig>;
  try {
    parsed = parseCanonicalAacLcAudioSpecificConfig(descriptionBytes);
  } catch (error) {
    throw manifestError('M4A AAC AudioSpecificConfig is not canonical AAC-LC', error);
  }
  const sampleRateHz = manifestInteger(record.sampleRateHz, 1, 96_000, 'M4A AAC sample rate');
  const channelCount = manifestInteger(record.channelCount, 1, 2, 'M4A AAC channel count');
  if (parsed.sampleRateHz !== sampleRateHz || parsed.channelCount !== channelCount) {
    throw manifestError('M4A AAC codec geometry conflicts with its AudioSpecificConfig');
  }
  return Object.freeze({
    codec: 'mp4a.40.2',
    sampleRateHz,
    channelCount: channelCount as 1 | 2,
    audioSpecificConfig: parsed.description,
    esId: manifestInteger(record.esId, 0, 0xffff, 'M4A AAC ES identifier'),
    bufferSizeDb: manifestInteger(record.bufferSizeDb, 0, 0xff_ffff, 'M4A AAC bufferSizeDB'),
    maxBitrate: manifestInteger(record.maxBitrate, 0, 0xffff_ffff, 'M4A AAC maximum bitrate'),
    averageBitrate: manifestInteger(
      record.averageBitrate,
      0,
      0xffff_ffff,
      'M4A AAC average bitrate',
    ),
  });
}

function validateTimelineManifest(value: unknown): Readonly<M4aAacTimeline> {
  const record = exactDataRecord(value, TIMELINE_KEYS, 'M4A AAC timeline manifest');
  const accessUnitCount = manifestInteger(
    record.accessUnitCount,
    1,
    M4A_AAC_MAX_ACCESS_UNITS,
    'M4A AAC access-unit count',
  );
  const sttsEntryCount = manifestInteger(
    record.sttsEntryCount,
    1,
    Math.min(M4A_AAC_MAX_STTS_ENTRIES, accessUnitCount),
    'M4A AAC stts entry count',
  );
  const finalAccessUnitDelta = manifestInteger(
    record.finalAccessUnitDelta,
    1,
    M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    'M4A AAC final access-unit delta',
  );
  if (
    accessUnitCount > 1 &&
    finalAccessUnitDelta < M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT &&
    sttsEntryCount < 2
  ) {
    throw manifestError('M4A AAC shortened final access unit requires a separate stts entry');
  }
  if (record.coreFramesPerAccessUnit !== M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) {
    throw manifestError('M4A AAC core frames per access unit must be exactly 1,024');
  }
  const rawCoreFrames = safeManifestMultiply(
    accessUnitCount,
    M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    'M4A AAC raw duration',
  );
  const presentationEndCoreFrames = safeManifestAdd(
    safeManifestMultiply(
      accessUnitCount - 1,
      M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
      'M4A AAC presentation prefix',
    ),
    finalAccessUnitDelta,
    'M4A AAC presentation duration',
  );
  const headTrimCoreFrames = manifestInteger(
    record.headTrimCoreFrames,
    0,
    presentationEndCoreFrames - 1,
    'M4A AAC head trim',
  );
  const expectedTailTrim = rawCoreFrames - presentationEndCoreFrames;
  const expectedTotalMediaFrames = presentationEndCoreFrames - headTrimCoreFrames;
  if (
    record.rawCoreFrames !== rawCoreFrames ||
    record.presentationEndCoreFrames !== presentationEndCoreFrames ||
    record.tailTrimCoreFrames !== expectedTailTrim ||
    record.totalMediaFrames !== expectedTotalMediaFrames
  ) {
    throw manifestError('M4A AAC timeline fields have contradictory frame geometry');
  }
  const sampleRateHz = manifestInteger(record.sampleRateHz, 1, 96_000, 'M4A timeline sample rate');
  return Object.freeze({
    accessUnitCount,
    sttsEntryCount,
    finalAccessUnitDelta,
    coreFramesPerAccessUnit: M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    rawCoreFrames,
    presentationEndCoreFrames,
    headTrimCoreFrames,
    tailTrimCoreFrames: expectedTailTrim,
    totalMediaFrames: expectedTotalMediaFrames,
    sampleRateHz,
  });
}

function validateRollRecoveryManifest(
  value: unknown,
): Readonly<{ readonly requiredPrerollAccessUnits: 1 }> | null {
  if (value === null) return null;
  const record = exactDataRecord(value, ROLL_RECOVERY_KEYS, 'M4A AAC roll-recovery manifest');
  if (record.requiredPrerollAccessUnits !== 1) {
    throw manifestError('M4A AAC roll recovery must require exactly one access unit');
  }
  return Object.freeze({ requiredPrerollAccessUnits: 1 });
}

/** Strictly canonicalize a structured-cloned same-app Worker manifest. */
export function validateM4aAacLcManifest(value: unknown): Readonly<M4aAacLcManifest> {
  const record = exactDataRecord(value, MANIFEST_KEYS, 'M4A AAC-LC manifest');
  if (record.manifestVersion !== M4A_AAC_LC_MANIFEST_VERSION) {
    throw manifestError('M4A AAC-LC manifest version is unsupported');
  }
  if (record.format !== 'm4a-aac-lc') {
    throw manifestError('M4A AAC-LC manifest format is invalid');
  }
  const sourceSize = manifestInteger(
    record.sourceSize,
    1,
    Number.MAX_SAFE_INTEGER,
    'M4A manifest source size',
  );
  const binding = validateM4aIndexSourceBinding({
    sourceSize,
    sourceIdentity: record.sourceIdentity,
  });
  const container = validateContainerManifest(record.container);
  const codec = validateCodecManifest(record.codec);
  const timeline = validateTimelineManifest(record.timeline);
  const rollRecovery = validateRollRecoveryManifest(record.rollRecovery);
  const sampleSizes = validateM4aSampleSizeIndexSnapshot(record.sampleSizes);
  const chunks = validateM4aChunkIndexSnapshot(record.chunks);

  if (codec.sampleRateHz !== timeline.sampleRateHz) {
    throw manifestError('M4A AAC codec and timeline sample rates do not match');
  }
  if (
    sampleSizes.sampleCount !== timeline.accessUnitCount ||
    chunks.sampleCount !== timeline.accessUnitCount
  ) {
    throw manifestError('M4A AAC table counts do not match the timeline access-unit count');
  }
  const stszTableBytes =
    sampleSizes.fixedSampleSizeBytes === 0
      ? safeManifestMultiply(sampleSizes.sampleCount, 4, 'M4A stsz table bytes')
      : 0;
  if (
    sampleSizes.entryTableStart < 12 ||
    safeManifestAdd(sampleSizes.entryTableStart, stszTableBytes, 'M4A stsz table end') > sourceSize
  ) {
    throw manifestError('M4A stsz snapshot is outside its bound source');
  }
  const chunkTableBytes = safeManifestMultiply(
    chunks.chunkCount,
    chunks.chunkOffsetWidthBytes,
    'M4A chunk-offset table bytes',
  );
  if (
    chunks.chunkOffsetTableStart < 8 ||
    safeManifestAdd(chunks.chunkOffsetTableStart, chunkTableBytes, 'M4A chunk table end') >
      sourceSize
  ) {
    throw manifestError('M4A chunk-offset snapshot is outside its bound source');
  }
  if (
    safeManifestAdd(
      chunks.sampleToChunk.bodyStart,
      chunks.sampleToChunk.bodyLength,
      'M4A stsc body end',
    ) > sourceSize
  ) {
    throw manifestError('M4A stsc snapshot is outside its bound source');
  }
  let mediaDataPayloadBytes = 0;
  for (const range of chunks.mediaDataRanges) {
    if (range.end > sourceSize) {
      throw manifestError('M4A media-data range exceeds its bound source');
    }
    mediaDataPayloadBytes = safeManifestAdd(
      mediaDataPayloadBytes,
      range.end - range.start,
      'M4A aggregate media-data bytes',
    );
  }
  if (sampleSizes.totalEncodedBytes > mediaDataPayloadBytes) {
    throw manifestError('M4A logical sample bytes exceed physical media-data capacity');
  }

  return copyManifest({
    manifestVersion: M4A_AAC_LC_MANIFEST_VERSION,
    format: 'm4a-aac-lc',
    sourceSize: binding.sourceSize,
    sourceIdentity: binding.sourceIdentity,
    container,
    codec,
    timeline,
    rollRecovery,
    sampleSizes,
    chunks,
  });
}

/**
 * Parse and authenticate one non-fragmented, self-contained M4A AAC-LC source.
 * The source remains caller-owned and no encoded media body is retained.
 */
export async function readM4aAacLcMetadata(
  source: EncodedRandomAccessSource,
  signal: AbortSignal,
): Promise<Readonly<M4aAacLcManifest>> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A AAC-LC metadata requires an AbortSignal');
  }
  throwIfAborted(signal);
  const reader = new IsoBmffBoxReader(source);
  const container = await readM4aContainerLayout(reader, signal);
  const movie = await readM4aMovieLayout(reader, container.moov, signal);
  const sampleTable = await readM4aSampleTableLayout(reader, movie.audioTrack.stbl, signal);
  const codec = await readM4aAacLcSampleDescription(reader, sampleTable.stsd, signal);
  const stts = await readM4aAacSttsEvidence(reader, sampleTable.stts, signal);
  const iTun = await readM4aITunSmpb(reader, movie.metadataRoot, signal);
  const timeline = normalizeM4aAacTimeline({
    stts,
    sampleRateHz: codec.sampleRateHz,
    mdhdTimescale: movie.audioTrack.mediaHeader.mediaTimescale,
    mdhdDurationCoreFrames: movie.audioTrack.mediaHeader.mediaDurationMediaTicks,
    movieTimescale: movie.movieHeader.movieTimescale,
    trackDurationMovieTicks: movie.audioTrack.trackHeader.durationMovieTicks,
    edit: movie.audioTrack.edit,
    iTun,
  });
  const rollRecovery = await readM4aAacRollRecoveryEvidence(
    reader,
    sampleTable.rollRecoverySampleGroup,
    timeline.accessUnitCount,
    signal,
  );
  const sampleToChunk = await readM4aSampleToChunkRuns(
    reader,
    sampleTable.stsc,
    timeline.accessUnitCount,
    signal,
  );
  const sampleSizes = await readM4aSampleSizeIndex(
    reader,
    sampleTable.stsz,
    timeline.accessUnitCount,
    signal,
  );
  const chunks = await readM4aChunkIndex(
    reader,
    container,
    sampleToChunk,
    sampleSizes,
    sampleTable.chunkOffsets,
    signal,
  );

  reader.assertReadable(signal);
  const manifest = copyManifest({
    manifestVersion: M4A_AAC_LC_MANIFEST_VERSION,
    format: 'm4a-aac-lc',
    sourceSize: reader.sourceSize,
    sourceIdentity: reader.sourceIdentity,
    container: Object.freeze({
      majorBrand: container.majorBrand,
      minorVersion: container.minorVersion,
      compatibleBrands: container.compatibleBrands,
    }),
    codec: Object.freeze({
      codec: codec.codec,
      sampleRateHz: codec.sampleRateHz,
      channelCount: codec.channelCount,
      audioSpecificConfig: codec.audioSpecificConfig.description,
      esId: codec.esId,
      bufferSizeDb: codec.bufferSizeDb,
      maxBitrate: codec.maxBitrate,
      averageBitrate: codec.averageBitrate,
    }),
    timeline,
    rollRecovery,
    sampleSizes: snapshotM4aSampleSizeIndex(reader, sampleSizes, signal),
    chunks: snapshotM4aChunkIndex(reader, chunks, signal),
  });
  issuedManifests.add(manifest);
  return manifest;
}

/** Produce a fresh data-only manifest that can cross one same-app Worker boundary. */
export function snapshotM4aAacLcManifest(
  value: Readonly<M4aAacLcManifest>,
): Readonly<M4aAacLcManifest> {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    !issuedManifests.has(value)
  ) {
    throw new TypeError('M4A AAC-LC manifest was not issued by the bounded metadata reader');
  }
  return copyManifest(value);
}
