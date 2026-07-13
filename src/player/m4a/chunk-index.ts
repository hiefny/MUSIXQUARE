import type { IsoBmffBoxRef } from '../mp4/box.ts';
import { ISO_BMFF_MAX_BOUNDED_READ_BYTES, IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import {
  assertM4aContainerLayoutProvenance,
  type M4aContainerLayout,
  type M4aMediaDataRange,
} from './container-layout.ts';
import {
  assertM4aSampleToChunkRunTableProvenance,
  createM4aSampleSizeSequence,
  type M4aSampleSizeIndex,
  type M4aSampleToChunkRunTable,
  readM4aSamplePrefixBytes,
  readM4aSampleSizeAt,
} from './sample-size-index.ts';
import { digestM4aMetadataPage } from './page-auth.ts';

const CHUNK_OFFSET_FULL_BOX_HEADER_BYTES = 8;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
export const M4A_MAX_CHUNKS = 1_048_576;

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

interface ChunkOffsetPageEvidence {
  readonly firstChunkOrdinal: number;
  readonly entryCount: number;
  readonly sha256: string;
}

interface ChunkIndexAuthority {
  readonly reader: IsoBmffBoxReader;
  readonly sampleSizes: Readonly<M4aSampleSizeIndex>;
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly chunkOffsetWidthBytes: 4 | 8;
  readonly chunkOffsetTableStart: number;
  readonly entriesPerPage: number;
  readonly runs: readonly Readonly<M4aNormalizedChunkRun>[];
  readonly mediaDataRanges: readonly Readonly<M4aMediaDataRange>[];
  readonly pages: readonly Readonly<ChunkOffsetPageEvidence>[];
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
  const pages: Readonly<ChunkOffsetPageEvidence>[] = [];
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
