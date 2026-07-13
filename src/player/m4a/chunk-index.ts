import type { IsoBmffBoxRef } from '../mp4/box.ts';
import { ISO_BMFF_MAX_BOUNDED_READ_BYTES, IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import {
  assertM4aContainerLayoutProvenance,
  M4A_MAX_MDAT_BOXES,
  type M4aContainerLayout,
  type M4aMediaDataRange,
} from './container-layout.ts';
import {
  assertM4aSampleToChunkRunTableProvenance,
  createM4aSampleSizeSequence,
  type M4aIndexSourceBinding,
  type M4aSampleToChunkEvidence,
  type M4aSampleSizeIndex,
  type M4aSampleToChunkRunTable,
  readM4aSamplePrefixBytes,
  readM4aSampleSizeAt,
  rehydrateM4aSampleToChunkRuns,
  snapshotM4aSampleToChunkEvidence,
  snapshotM4aSampleSizeIndex,
  validateM4aIndexSourceBinding,
  validateM4aSampleToChunkEvidence,
} from './sample-size-index.ts';
import { digestM4aMetadataPage } from './page-auth.ts';
import { M4A_AAC_MAX_ACCESS_UNITS } from './timeline.ts';

const CHUNK_OFFSET_FULL_BOX_HEADER_BYTES = 8;
const STSC_FULL_BOX_HEADER_BYTES = 8;
const STSC_ENTRY_BYTES = 12;
const STSC_MAX_ENTRIES = 2_048;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
export const M4A_MAX_CHUNKS = 1_048_576;
const M4A_MAX_CHUNK_OFFSET_PAGES = Math.ceil(
  M4A_MAX_CHUNKS / Math.floor(ISO_BMFF_MAX_BOUNDED_READ_BYTES / 8),
);

export interface M4aNormalizedChunkRun {
  /** One-based first chunk, as encoded by `stsc`. */
  readonly firstChunk: number;
  /** One-based exclusive chunk boundary; the final value is chunkCount + 1. */
  readonly endChunkExclusive: number;
  /** Zero-based access-unit ordinal carried by `firstChunk`. */
  readonly firstSampleOrdinal: number;
  readonly samplesPerChunk: number;
}

export interface M4aChunkIndex {
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly chunkOffsetWidthBytes: 4 | 8;
  readonly chunkOffsetTableStart: number;
  readonly runs: readonly Readonly<M4aNormalizedChunkRun>[];
  readonly mediaDataRanges: readonly Readonly<M4aMediaDataRange>[];
}

export interface M4aAacAccessUnitLocation {
  readonly ordinal: number;
  readonly chunkOrdinal: number;
  readonly chunkOffset: number;
  readonly offset: number;
  readonly byteLength: number;
}

export interface M4aChunkOffsetPageEvidence {
  readonly firstChunkOrdinal: number;
  readonly entryCount: number;
  readonly sha256: string;
}

export interface M4aChunkIndexSnapshot {
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly chunkOffsetWidthBytes: 4 | 8;
  readonly chunkOffsetTableStart: number;
  readonly headerSha256: string;
  readonly sampleToChunk: Readonly<M4aSampleToChunkEvidence>;
  readonly runs: readonly Readonly<M4aNormalizedChunkRun>[];
  readonly mediaDataRanges: readonly Readonly<M4aMediaDataRange>[];
  readonly pages: readonly Readonly<M4aChunkOffsetPageEvidence>[];
}

interface ChunkIndexAuthority {
  readonly reader: IsoBmffBoxReader;
  readonly sampleSizes: Readonly<M4aSampleSizeIndex>;
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly chunkOffsetWidthBytes: 4 | 8;
  readonly chunkOffsetTableStart: number;
  readonly headerSha256: string;
  readonly sampleToChunk: Readonly<M4aSampleToChunkEvidence>;
  readonly entriesPerPage: number;
  readonly runs: readonly Readonly<M4aNormalizedChunkRun>[];
  readonly mediaDataRanges: readonly Readonly<M4aMediaDataRange>[];
  readonly pages: readonly Readonly<M4aChunkOffsetPageEvidence>[];
}

const chunkIndexAuthorities = new WeakMap<object, ChunkIndexAuthority>();

export class M4aChunkIndexError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aChunkIndexError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function requireReaderAndSignal(
  reader: unknown,
  signal: unknown,
  label: string,
): asserts reader is IsoBmffBoxReader {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError(`${label} requires an IsoBmffBoxReader`);
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError(`${label} requires an AbortSignal`);
  }
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): number {
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

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new M4aChunkIndexError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new M4aChunkIndexError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x100_0000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readChunkOffset(bytes: Uint8Array, offset: number, width: 4 | 8): number {
  if (width === 4) return readUint32(bytes, offset);
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false);
  if (value > MAX_SAFE_BIGINT) {
    throw new M4aChunkIndexError('M4A co64 chunk offset exceeds the browser safe-integer range');
  }
  return Number(value);
}

function normalizeRuns(
  table: Readonly<M4aSampleToChunkRunTable>,
  chunkCount: number,
): readonly Readonly<M4aNormalizedChunkRun>[] {
  const normalized: Readonly<M4aNormalizedChunkRun>[] = [];
  let firstSampleOrdinal = 0;
  for (let index = 0; index < table.runs.length; index += 1) {
    const run = table.runs[index]!;
    if (run.firstChunk > chunkCount) {
      throw new M4aChunkIndexError('M4A stsc run begins after the final declared chunk');
    }
    const endChunkExclusive = table.runs[index + 1]?.firstChunk ?? chunkCount + 1;
    if (endChunkExclusive > chunkCount + 1 || endChunkExclusive <= run.firstChunk) {
      throw new M4aChunkIndexError('M4A stsc run has an invalid declared chunk boundary');
    }
    const runChunks = endChunkExclusive - run.firstChunk;
    const runSamples = safeMultiply(runChunks, run.samplesPerChunk, 'M4A stsc run sample count');
    normalized.push(
      Object.freeze({
        firstChunk: run.firstChunk,
        endChunkExclusive,
        firstSampleOrdinal,
        samplesPerChunk: run.samplesPerChunk,
      }),
    );
    firstSampleOrdinal = safeAdd(firstSampleOrdinal, runSamples, 'M4A stsc covered sample count');
    if (firstSampleOrdinal > table.sampleCount) {
      throw new M4aChunkIndexError('M4A stsc runs cover more samples than the sample table');
    }
  }
  if (firstSampleOrdinal !== table.sampleCount) {
    throw new M4aChunkIndexError(
      `M4A stsc runs cover ${firstSampleOrdinal} samples; expected ${table.sampleCount}`,
    );
  }
  return Object.freeze(normalized);
}

function normalizedRunsEqual(
  left: readonly Readonly<M4aNormalizedChunkRun>[],
  right: readonly Readonly<M4aNormalizedChunkRun>[],
): boolean {
  return (
    left.length === right.length &&
    left.every((run, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        run.firstChunk === candidate.firstChunk &&
        run.endChunkExclusive === candidate.endChunkExclusive &&
        run.firstSampleOrdinal === candidate.firstSampleOrdinal &&
        run.samplesPerChunk === candidate.samplesPerChunk
      );
    })
  );
}

function findContainingMediaDataRange(
  ranges: readonly Readonly<M4aMediaDataRange>[],
  start: number,
  end: number,
): Readonly<M4aMediaDataRange> | null {
  if (end <= start) return null;
  return ranges.find((range) => start >= range.start && end <= range.end) ?? null;
}

function requireMediaDataSpan(
  ranges: readonly Readonly<M4aMediaDataRange>[],
  start: number,
  byteLength: number,
  label: string,
): number {
  if (byteLength < 1) throw new M4aChunkIndexError(`${label} must contain at least one byte`);
  const end = safeAdd(start, byteLength, `${label} end`);
  if (findContainingMediaDataRange(ranges, start, end) === null) {
    throw new M4aChunkIndexError(`${label} is not wholly contained by one M4A mdat payload`);
  }
  return end;
}

const createChunkIndexError = (message: string, cause?: unknown): M4aChunkIndexError =>
  new M4aChunkIndexError(message, cause);

const SNAPSHOT_KEYS = Object.freeze([
  'sampleCount',
  'chunkCount',
  'chunkOffsetWidthBytes',
  'chunkOffsetTableStart',
  'headerSha256',
  'sampleToChunk',
  'runs',
  'mediaDataRanges',
  'pages',
] as const);
const RUN_KEYS = Object.freeze([
  'firstChunk',
  'endChunkExclusive',
  'firstSampleOrdinal',
  'samplesPerChunk',
] as const);
const MEDIA_DATA_RANGE_KEYS = Object.freeze(['start', 'end'] as const);
const PAGE_EVIDENCE_KEYS = Object.freeze(['firstChunkOrdinal', 'entryCount', 'sha256'] as const);
const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;

function requireExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw createChunkIndexError(`${label} must be a plain data object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw createChunkIndexError(`${label} must not be a class instance`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      throw createChunkIndexError(`${label} must contain exactly its canonical keys`);
    }
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw createChunkIndexError(`${label}.${key} must be own enumerable data`);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof M4aChunkIndexError) throw error;
    throw createChunkIndexError(`${label} could not be inspected as data`, error);
  }
}

function requireDenseDataArray(
  value: unknown,
  maximumLength: number,
  label: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw createChunkIndexError(`${label} must be a plain array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const lengthValue: unknown = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthValue !== 'number' ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > maximumLength
    ) {
      throw createChunkIndexError(`${label} length exceeds its proven bound`);
    }
    const length = lengthValue;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) < 0 || Number(key) >= length)),
      )
    ) {
      throw createChunkIndexError(`${label} must be dense and contain no extra properties`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw createChunkIndexError(`${label}[${index}] must be own enumerable data`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof M4aChunkIndexError) throw error;
    throw createChunkIndexError(`${label} could not be inspected as data`, error);
  }
}

function requireSnapshotInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  try {
    return requireInteger(value, minimum, maximum, label);
  } catch (error) {
    throw createChunkIndexError(`${label} is outside its canonical integer range`, error);
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_LOWER_HEX.test(value)) {
    throw createChunkIndexError(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

/** Strictly validate and deeply canonicalize an untrusted transferable snapshot. */
export function validateM4aChunkIndexSnapshot(value: unknown): Readonly<M4aChunkIndexSnapshot> {
  const record = requireExactDataRecord(value, SNAPSHOT_KEYS, 'M4A chunk-index snapshot');
  const sampleCount = requireSnapshotInteger(
    record.sampleCount,
    1,
    M4A_AAC_MAX_ACCESS_UNITS,
    'M4A chunk-index snapshot sample count',
  );
  const chunkCount = requireSnapshotInteger(
    record.chunkCount,
    1,
    Math.min(M4A_MAX_CHUNKS, sampleCount),
    'M4A chunk-index snapshot chunk count',
  );
  const chunkOffsetWidthBytes = requireSnapshotInteger(
    record.chunkOffsetWidthBytes,
    4,
    8,
    'M4A chunk-index snapshot offset width',
  );
  if (chunkOffsetWidthBytes !== 4 && chunkOffsetWidthBytes !== 8) {
    throw createChunkIndexError('M4A chunk-index snapshot offset width must be 4 or 8 bytes');
  }
  const chunkOffsetTableStart = requireSnapshotInteger(
    record.chunkOffsetTableStart,
    CHUNK_OFFSET_FULL_BOX_HEADER_BYTES,
    Number.MAX_SAFE_INTEGER,
    'M4A chunk-index snapshot table start',
  );
  safeAdd(
    chunkOffsetTableStart,
    safeMultiply(chunkCount, chunkOffsetWidthBytes, 'M4A snapshot chunk-offset table size'),
    'M4A snapshot chunk-offset table end',
  );
  const headerSha256 = requireSha256(record.headerSha256, 'M4A chunk-index snapshot header digest');
  const sampleToChunk = validateM4aSampleToChunkEvidence(record.sampleToChunk);

  const runValues = requireDenseDataArray(
    record.runs,
    STSC_MAX_ENTRIES,
    'M4A chunk-index snapshot runs',
  );
  if (runValues.length < 1) {
    throw createChunkIndexError('M4A chunk-index snapshot must contain at least one run');
  }
  let coveredSamples = 0;
  let previousRunEndChunkExclusive = 1;
  const runs = runValues.map((candidate, index) => {
    const item = requireExactDataRecord(candidate, RUN_KEYS, `M4A chunk-index run ${index}`);
    const firstChunk = requireSnapshotInteger(
      item.firstChunk,
      1,
      chunkCount,
      `M4A chunk-index run ${index} first chunk`,
    );
    const endChunkExclusive = requireSnapshotInteger(
      item.endChunkExclusive,
      2,
      chunkCount + 1,
      `M4A chunk-index run ${index} exclusive end`,
    );
    const firstSampleOrdinal = requireSnapshotInteger(
      item.firstSampleOrdinal,
      0,
      sampleCount - 1,
      `M4A chunk-index run ${index} first sample ordinal`,
    );
    const samplesPerChunk = requireSnapshotInteger(
      item.samplesPerChunk,
      1,
      sampleCount,
      `M4A chunk-index run ${index} samples per chunk`,
    );
    if (
      firstChunk !== previousRunEndChunkExclusive ||
      endChunkExclusive <= firstChunk ||
      firstSampleOrdinal !== coveredSamples
    ) {
      throw createChunkIndexError('M4A chunk-index snapshot run coverage is inconsistent');
    }
    coveredSamples = safeAdd(
      coveredSamples,
      safeMultiply(
        endChunkExclusive - firstChunk,
        samplesPerChunk,
        'M4A snapshot run sample count',
      ),
      'M4A snapshot covered sample count',
    );
    if (coveredSamples > sampleCount) {
      throw createChunkIndexError('M4A chunk-index snapshot runs cover too many samples');
    }
    previousRunEndChunkExclusive = endChunkExclusive;
    return Object.freeze({
      firstChunk,
      endChunkExclusive,
      firstSampleOrdinal,
      samplesPerChunk,
    });
  });
  if (runs.at(-1)!.endChunkExclusive !== chunkCount + 1 || coveredSamples !== sampleCount) {
    throw createChunkIndexError('M4A chunk-index snapshot run coverage is incomplete');
  }
  if (sampleToChunk.bodyLength !== STSC_FULL_BOX_HEADER_BYTES + runs.length * STSC_ENTRY_BYTES) {
    throw createChunkIndexError('M4A chunk-index stsc evidence conflicts with its run count');
  }

  const mediaRangeValues = requireDenseDataArray(
    record.mediaDataRanges,
    M4A_MAX_MDAT_BOXES,
    'M4A chunk-index snapshot media-data ranges',
  );
  if (mediaRangeValues.length < 1) {
    throw createChunkIndexError('M4A chunk-index snapshot must contain an mdat range');
  }
  let previousRangeEnd = 0;
  let nonEmptyMediaRange = false;
  const mediaDataRanges = mediaRangeValues.map((candidate, index) => {
    const item = requireExactDataRecord(
      candidate,
      MEDIA_DATA_RANGE_KEYS,
      `M4A chunk-index mdat range ${index}`,
    );
    const start = requireSnapshotInteger(
      item.start,
      0,
      Number.MAX_SAFE_INTEGER,
      `M4A chunk-index mdat range ${index} start`,
    );
    const end = requireSnapshotInteger(
      item.end,
      start,
      Number.MAX_SAFE_INTEGER,
      `M4A chunk-index mdat range ${index} end`,
    );
    if (index > 0 && start < previousRangeEnd) {
      throw createChunkIndexError('M4A chunk-index mdat ranges must be sorted and nonoverlapping');
    }
    previousRangeEnd = end;
    nonEmptyMediaRange ||= end > start;
    return Object.freeze({ start, end });
  });
  if (!nonEmptyMediaRange) {
    throw createChunkIndexError('M4A chunk-index snapshot has no non-empty mdat payload');
  }

  const entriesPerPage = Math.floor(ISO_BMFF_MAX_BOUNDED_READ_BYTES / chunkOffsetWidthBytes);
  const pageValues = requireDenseDataArray(
    record.pages,
    M4A_MAX_CHUNK_OFFSET_PAGES,
    'M4A chunk-index snapshot pages',
  );
  const expectedPageCount = Math.ceil(chunkCount / entriesPerPage);
  if (pageValues.length !== expectedPageCount) {
    throw createChunkIndexError('M4A chunk-index snapshot page coverage is inconsistent');
  }
  const pages = pageValues.map((candidate, index) => {
    const item = requireExactDataRecord(
      candidate,
      PAGE_EVIDENCE_KEYS,
      `M4A chunk-index page ${index}`,
    );
    const expectedFirstChunkOrdinal = index * entriesPerPage;
    const expectedEntryCount = Math.min(entriesPerPage, chunkCount - expectedFirstChunkOrdinal);
    const firstChunkOrdinal = requireSnapshotInteger(
      item.firstChunkOrdinal,
      0,
      chunkCount - 1,
      `M4A chunk-index page ${index} first chunk ordinal`,
    );
    const entryCount = requireSnapshotInteger(
      item.entryCount,
      1,
      entriesPerPage,
      `M4A chunk-index page ${index} entry count`,
    );
    if (firstChunkOrdinal !== expectedFirstChunkOrdinal || entryCount !== expectedEntryCount) {
      throw createChunkIndexError('M4A chunk-index snapshot page evidence is inconsistent');
    }
    return Object.freeze({
      firstChunkOrdinal,
      entryCount,
      sha256: requireSha256(item.sha256, `M4A chunk-index page ${index} digest`),
    });
  });

  return Object.freeze({
    sampleCount,
    chunkCount,
    chunkOffsetWidthBytes,
    chunkOffsetTableStart,
    headerSha256,
    sampleToChunk,
    runs: Object.freeze(runs),
    mediaDataRanges: Object.freeze(mediaDataRanges),
    pages: Object.freeze(pages),
  });
}

function requireChunkIndexAuthority(
  reader: IsoBmffBoxReader,
  index: unknown,
  signal: AbortSignal,
): ChunkIndexAuthority {
  reader.assertReadable(signal);
  const authority =
    index !== null && (typeof index === 'object' || typeof index === 'function')
      ? chunkIndexAuthorities.get(index)
      : undefined;
  if (authority === undefined) {
    throw new M4aChunkIndexError('M4A chunk index lacks module provenance');
  }
  if (authority.reader !== reader) {
    throw new M4aChunkIndexError('M4A chunk index belongs to a different source reader');
  }
  return authority;
}

/** Copy one issued index into bounded structured-clone data for a decoder Worker. */
export function snapshotM4aChunkIndex(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aChunkIndex>,
  signal: AbortSignal,
): Readonly<M4aChunkIndexSnapshot> {
  requireReaderAndSignal(reader, signal, 'M4A chunk-index snapshot');
  const authority = requireChunkIndexAuthority(reader, index, signal);
  const runs = Object.freeze(
    authority.runs.map((run) =>
      Object.freeze({
        firstChunk: run.firstChunk,
        endChunkExclusive: run.endChunkExclusive,
        firstSampleOrdinal: run.firstSampleOrdinal,
        samplesPerChunk: run.samplesPerChunk,
      }),
    ),
  );
  const mediaDataRanges = Object.freeze(
    authority.mediaDataRanges.map((range) => Object.freeze({ start: range.start, end: range.end })),
  );
  const pages = Object.freeze(
    authority.pages.map((page) =>
      Object.freeze({
        firstChunkOrdinal: page.firstChunkOrdinal,
        entryCount: page.entryCount,
        sha256: page.sha256,
      }),
    ),
  );
  reader.assertReadable(signal);
  return Object.freeze({
    sampleCount: authority.sampleCount,
    chunkCount: authority.chunkCount,
    chunkOffsetWidthBytes: authority.chunkOffsetWidthBytes,
    chunkOffsetTableStart: authority.chunkOffsetTableStart,
    headerSha256: authority.headerSha256,
    sampleToChunk: Object.freeze({
      bodyStart: authority.sampleToChunk.bodyStart,
      bodyLength: authority.sampleToChunk.bodyLength,
      sha256: authority.sampleToChunk.sha256,
    }),
    runs,
    mediaDataRanges,
    pages,
  });
}

/**
 * Reopen untrusted transferable chunk evidence against its exact source and
 * one already-authenticated same-reader sample-size index. The complete bounded
 * `stsc` body and eight-byte `stco`/`co64` header are reread; offset pages stay lazy.
 */
export async function rehydrateM4aChunkIndex(
  reader: IsoBmffBoxReader,
  snapshotValue: unknown,
  sampleSizes: Readonly<M4aSampleSizeIndex>,
  expectedSourceValue: unknown,
  signal: AbortSignal,
): Promise<Readonly<M4aChunkIndex>> {
  requireReaderAndSignal(reader, signal, 'M4A chunk-index snapshot rehydration');
  reader.assertReadable(signal);
  const expectedSource: Readonly<M4aIndexSourceBinding> =
    validateM4aIndexSourceBinding(expectedSourceValue);
  if (
    reader.sourceSize !== expectedSource.sourceSize ||
    reader.sourceIdentity !== expectedSource.sourceIdentity
  ) {
    throw createChunkIndexError(
      'M4A chunk-index snapshot source binding does not match its reader',
    );
  }
  const snapshot = validateM4aChunkIndexSnapshot(snapshotValue);
  const sampleSizeSnapshot = snapshotM4aSampleSizeIndex(reader, sampleSizes, signal);
  if (sampleSizeSnapshot.sampleCount !== snapshot.sampleCount) {
    throw createChunkIndexError('M4A chunk and sample-size snapshot counts do not match');
  }
  const sourceSampleToChunk = await rehydrateM4aSampleToChunkRuns(
    reader,
    snapshot.sampleToChunk,
    snapshot.sampleCount,
    expectedSource,
    signal,
  );
  const sourceRuns = normalizeRuns(sourceSampleToChunk, snapshot.chunkCount);
  if (!normalizedRunsEqual(sourceRuns, snapshot.runs)) {
    throw createChunkIndexError('M4A transferred stsc runs do not match their bound source body');
  }

  const tableBytes = safeMultiply(
    snapshot.chunkCount,
    snapshot.chunkOffsetWidthBytes,
    'M4A rehydrated chunk-offset table size',
  );
  const tableEnd = safeAdd(
    snapshot.chunkOffsetTableStart,
    tableBytes,
    'M4A rehydrated chunk-offset table end',
  );
  if (tableEnd > expectedSource.sourceSize) {
    throw createChunkIndexError('M4A chunk-index snapshot table exceeds its bound source');
  }

  let mediaDataPayloadBytes = 0;
  for (const range of snapshot.mediaDataRanges) {
    if (range.end > expectedSource.sourceSize) {
      throw createChunkIndexError('M4A chunk-index mdat range exceeds its bound source');
    }
    mediaDataPayloadBytes = safeAdd(
      mediaDataPayloadBytes,
      range.end - range.start,
      'M4A rehydrated aggregate mdat payload size',
    );
  }
  if (sampleSizeSnapshot.totalEncodedBytes > mediaDataPayloadBytes) {
    throw createChunkIndexError(
      'M4A logical sample bytes exceed the aggregate physical mdat payload capacity',
    );
  }

  const header = await reader.readBytes(
    snapshot.chunkOffsetTableStart - CHUNK_OFFSET_FULL_BOX_HEADER_BYTES,
    CHUNK_OFFSET_FULL_BOX_HEADER_BYTES,
    signal,
  );
  const headerSha256 = await digestM4aMetadataPage(
    reader,
    header,
    signal,
    'M4A chunk-offset FullBox header',
    createChunkIndexError,
  );
  if (headerSha256 !== snapshot.headerSha256) {
    throw createChunkIndexError('M4A chunk-offset header changed after the snapshot was built');
  }
  if (header[0] !== 0 || header[1] !== 0 || header[2] !== 0 || header[3] !== 0) {
    throw createChunkIndexError('M4A chunk-offset FullBox version and flags must be zero');
  }
  if (readUint32(header, 4) !== snapshot.chunkCount) {
    throw createChunkIndexError('M4A chunk-offset header does not match its snapshot geometry');
  }

  reader.assertReadable(signal);
  const index = Object.freeze({
    sampleCount: snapshot.sampleCount,
    chunkCount: snapshot.chunkCount,
    chunkOffsetWidthBytes: snapshot.chunkOffsetWidthBytes,
    chunkOffsetTableStart: snapshot.chunkOffsetTableStart,
    runs: sourceRuns,
    mediaDataRanges: snapshot.mediaDataRanges,
  });
  chunkIndexAuthorities.set(
    index,
    Object.freeze({
      reader,
      sampleSizes,
      sampleCount: snapshot.sampleCount,
      chunkCount: snapshot.chunkCount,
      chunkOffsetWidthBytes: snapshot.chunkOffsetWidthBytes,
      chunkOffsetTableStart: snapshot.chunkOffsetTableStart,
      headerSha256: snapshot.headerSha256,
      sampleToChunk: snapshot.sampleToChunk,
      entriesPerPage: Math.floor(ISO_BMFF_MAX_BOUNDED_READ_BYTES / snapshot.chunkOffsetWidthBytes),
      runs: sourceRuns,
      mediaDataRanges: snapshot.mediaDataRanges,
      pages: snapshot.pages,
    }),
  );
  return index;
}

/**
 * Validate the complete non-fragmented chunk geometry without retaining the
 * offset table or sample-size table. Each table page is at most 64 KiB.
 *
 * Chunk offsets are deliberately not required to be monotonic, contiguous, or
 * disjoint. ISO BMFF may interleave physical media data, and duplicate or
 * overlapping byte spans do not weaken this reader's bounds: every positive
 * span is independently required to fit inside one authentic `mdat` payload.
 */
export async function readM4aChunkIndex(
  reader: IsoBmffBoxReader,
  containerLayout: Readonly<M4aContainerLayout>,
  sampleToChunkTable: Readonly<M4aSampleToChunkRunTable>,
  sampleSizes: Readonly<M4aSampleSizeIndex>,
  chunkOffsetsBox: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<M4aChunkIndex>> {
  requireReaderAndSignal(reader, signal, 'M4A chunk index');
  const layout = assertM4aContainerLayoutProvenance(reader, containerLayout, signal);
  const stsc = assertM4aSampleToChunkRunTableProvenance(reader, sampleToChunkTable, signal);
  const sampleToChunk = snapshotM4aSampleToChunkEvidence(reader, stsc, signal);
  const sampleSizeSequence = createM4aSampleSizeSequence(reader, sampleSizes, 0);
  if (sampleSizes.sampleCount !== stsc.sampleCount) {
    throw new M4aChunkIndexError('M4A stsc and stsz sample counts do not match');
  }

  // Issued-reference provenance is checked before caller-controlled fields.
  const body = reader.createChildCursor(chunkOffsetsBox);
  if (chunkOffsetsBox.type !== 'stco' && chunkOffsetsBox.type !== 'co64') {
    throw new M4aChunkIndexError('M4A chunk-offset parent must be an stco or co64 box');
  }
  const chunkOffsetWidthBytes: 4 | 8 = chunkOffsetsBox.type === 'stco' ? 4 : 8;
  if (body.remainingBytes < CHUNK_OFFSET_FULL_BOX_HEADER_BYTES) {
    throw new M4aChunkIndexError('M4A chunk-offset FullBox header is truncated');
  }
  const header = await reader.readBytes(body.start, CHUNK_OFFSET_FULL_BOX_HEADER_BYTES, signal);
  const headerSha256 = await digestM4aMetadataPage(
    reader,
    header,
    signal,
    'M4A chunk-offset FullBox header',
    createChunkIndexError,
  );
  if (header[0] !== 0 || header[1] !== 0 || header[2] !== 0 || header[3] !== 0) {
    throw new M4aChunkIndexError('M4A chunk-offset FullBox version and flags must be zero');
  }
  const chunkCount = readUint32(header, 4);
  if (chunkCount < 1 || chunkCount > M4A_MAX_CHUNKS) {
    throw new M4aChunkIndexError(`M4A chunk count must be from 1 through ${M4A_MAX_CHUNKS}`);
  }
  if (chunkCount > stsc.sampleCount) {
    throw new M4aChunkIndexError('M4A chunk count cannot exceed the AAC access-unit count');
  }
  const tableBytes = safeMultiply(chunkCount, chunkOffsetWidthBytes, 'M4A chunk-offset table size');
  const expectedBodyBytes = safeAdd(
    CHUNK_OFFSET_FULL_BOX_HEADER_BYTES,
    tableBytes,
    'M4A chunk-offset body size',
  );
  if (body.remainingBytes !== expectedBodyBytes) {
    throw new M4aChunkIndexError(
      `M4A chunk-offset body has ${body.remainingBytes} bytes; expected ${expectedBodyBytes}`,
    );
  }

  const runs = normalizeRuns(stsc, chunkCount);
  const mediaDataRanges = Object.freeze(
    layout.mediaDataRanges.map((range) => Object.freeze({ start: range.start, end: range.end })),
  );
  let mediaDataPayloadBytes = 0;
  for (const range of mediaDataRanges) {
    mediaDataPayloadBytes = safeAdd(
      mediaDataPayloadBytes,
      range.end - range.start,
      'M4A aggregate mdat payload size',
    );
  }
  if (sampleSizes.totalEncodedBytes > mediaDataPayloadBytes) {
    throw new M4aChunkIndexError(
      'M4A logical sample bytes exceed the aggregate physical mdat payload capacity',
    );
  }
  const chunkOffsetTableStart = body.start + CHUNK_OFFSET_FULL_BOX_HEADER_BYTES;
  const entriesPerPage = Math.floor(ISO_BMFF_MAX_BOUNDED_READ_BYTES / chunkOffsetWidthBytes);
  const pages: Readonly<M4aChunkOffsetPageEvidence>[] = [];
  let parsedChunks = 0;
  let runIndex = 0;
  let totalChunkBytes = 0;
  while (parsedChunks < chunkCount) {
    const pageEntries = Math.min(entriesPerPage, chunkCount - parsedChunks);
    const page = await reader.readBytes(
      chunkOffsetTableStart + parsedChunks * chunkOffsetWidthBytes,
      pageEntries * chunkOffsetWidthBytes,
      signal,
    );
    const pageDigest = await digestM4aMetadataPage(
      reader,
      page,
      signal,
      'M4A chunk-offset page',
      createChunkIndexError,
    );
    pages.push(
      Object.freeze({
        firstChunkOrdinal: parsedChunks,
        entryCount: pageEntries,
        sha256: pageDigest,
      }),
    );

    for (let pageIndex = 0; pageIndex < pageEntries; pageIndex += 1) {
      const chunkOrdinal = parsedChunks + pageIndex;
      const oneBasedChunk = chunkOrdinal + 1;
      while (oneBasedChunk >= runs[runIndex]!.endChunkExclusive) runIndex += 1;
      const run = runs[runIndex]!;
      const chunkBytes = await sampleSizeSequence.sumNext(run.samplesPerChunk, signal);
      const chunkOffset = readChunkOffset(
        page,
        pageIndex * chunkOffsetWidthBytes,
        chunkOffsetWidthBytes,
      );
      requireMediaDataSpan(mediaDataRanges, chunkOffset, chunkBytes, `M4A chunk ${chunkOrdinal}`);
      totalChunkBytes = safeAdd(totalChunkBytes, chunkBytes, 'M4A covered chunk-byte total');
    }
    parsedChunks += pageEntries;
  }

  if (sampleSizeSequence.ordinal !== stsc.sampleCount) {
    throw new M4aChunkIndexError('M4A chunk geometry did not consume every AAC access unit');
  }
  if (totalChunkBytes !== sampleSizes.totalEncodedBytes) {
    throw new M4aChunkIndexError(
      'M4A chunk geometry does not cover the complete sample-size table',
    );
  }

  reader.assertReadable(signal);
  const result = Object.freeze({
    sampleCount: stsc.sampleCount,
    chunkCount,
    chunkOffsetWidthBytes,
    chunkOffsetTableStart,
    runs,
    mediaDataRanges,
  });
  chunkIndexAuthorities.set(
    result,
    Object.freeze({
      reader,
      sampleSizes,
      sampleCount: stsc.sampleCount,
      chunkCount,
      chunkOffsetWidthBytes,
      chunkOffsetTableStart,
      headerSha256,
      sampleToChunk,
      entriesPerPage,
      runs,
      mediaDataRanges,
      pages: Object.freeze(pages),
    }),
  );
  return result;
}

/** Read and authenticate one zero-based chunk offset with one bounded page. */
export async function readM4aChunkOffsetAt(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aChunkIndex>,
  chunkOrdinal: number,
  signal: AbortSignal,
): Promise<number> {
  requireReaderAndSignal(reader, signal, 'M4A chunk-offset lookup');
  const authority = requireChunkIndexAuthority(reader, index, signal);
  const ordinal = requireInteger(chunkOrdinal, 0, authority.chunkCount - 1, 'M4A chunk ordinal');
  const pageIndex = Math.floor(ordinal / authority.entriesPerPage);
  const evidence = authority.pages[pageIndex]!;
  const page = await reader.readBytes(
    authority.chunkOffsetTableStart + evidence.firstChunkOrdinal * authority.chunkOffsetWidthBytes,
    evidence.entryCount * authority.chunkOffsetWidthBytes,
    signal,
  );
  if (
    (await digestM4aMetadataPage(
      reader,
      page,
      signal,
      'M4A chunk-offset page',
      createChunkIndexError,
    )) !== evidence.sha256
  ) {
    throw new M4aChunkIndexError('M4A chunk-offset entries changed after the index was built');
  }
  return readChunkOffset(
    page,
    (ordinal - evidence.firstChunkOrdinal) * authority.chunkOffsetWidthBytes,
    authority.chunkOffsetWidthBytes,
  );
}

function findRunForSample(
  runs: readonly Readonly<M4aNormalizedChunkRun>[],
  sampleOrdinal: number,
): Readonly<M4aNormalizedChunkRun> {
  let low = 0;
  let high = runs.length;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (runs[middle]!.firstSampleOrdinal <= sampleOrdinal) low = middle;
    else high = middle;
  }
  return runs[low]!;
}

/** Resolve one zero-based raw AAC access unit without materializing either table. */
export async function locateM4aAacAccessUnit(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aChunkIndex>,
  sampleOrdinal: number,
  signal: AbortSignal,
): Promise<Readonly<M4aAacAccessUnitLocation>> {
  requireReaderAndSignal(reader, signal, 'M4A AAC access-unit locator');
  const authority = requireChunkIndexAuthority(reader, index, signal);
  const ordinal = requireInteger(
    sampleOrdinal,
    0,
    authority.sampleCount - 1,
    'M4A AAC access-unit ordinal',
  );
  const run = findRunForSample(authority.runs, ordinal);
  const ordinalWithinRun = ordinal - run.firstSampleOrdinal;
  const chunkWithinRun = Math.floor(ordinalWithinRun / run.samplesPerChunk);
  const chunkOrdinal = run.firstChunk - 1 + chunkWithinRun;
  const chunkFirstSampleOrdinal = run.firstSampleOrdinal + chunkWithinRun * run.samplesPerChunk;
  const chunkEndSampleOrdinal = chunkFirstSampleOrdinal + run.samplesPerChunk;

  const chunkOffset = await readM4aChunkOffsetAt(reader, index, chunkOrdinal, signal);
  const chunkPrefix = await readM4aSamplePrefixBytes(
    reader,
    authority.sampleSizes,
    chunkFirstSampleOrdinal,
    signal,
  );
  const samplePrefix = await readM4aSamplePrefixBytes(
    reader,
    authority.sampleSizes,
    ordinal,
    signal,
  );
  const chunkEndPrefix = await readM4aSamplePrefixBytes(
    reader,
    authority.sampleSizes,
    chunkEndSampleOrdinal,
    signal,
  );
  const byteLength = await readM4aSampleSizeAt(reader, authority.sampleSizes, ordinal, signal);
  const offsetWithinChunk = samplePrefix - chunkPrefix;
  const chunkByteLength = chunkEndPrefix - chunkPrefix;
  if (
    offsetWithinChunk < 0 ||
    chunkByteLength < 1 ||
    offsetWithinChunk + byteLength > chunkByteLength
  ) {
    throw new M4aChunkIndexError('M4A access-unit prefix geometry is internally inconsistent');
  }

  requireMediaDataSpan(
    authority.mediaDataRanges,
    chunkOffset,
    chunkByteLength,
    `M4A current chunk ${chunkOrdinal}`,
  );
  const offset = safeAdd(chunkOffset, offsetWithinChunk, 'M4A AAC access-unit offset');
  requireMediaDataSpan(
    authority.mediaDataRanges,
    offset,
    byteLength,
    `M4A AAC access unit ${ordinal}`,
  );
  reader.assertReadable(signal);
  return Object.freeze({ ordinal, chunkOrdinal, chunkOffset, offset, byteLength });
}
