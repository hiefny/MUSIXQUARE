import type { IsoBmffBoxRef } from '../mp4/box.ts';
import { ISO_BMFF_MAX_BOUNDED_READ_BYTES, IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import { digestM4aMetadataPage } from './page-auth.ts';
import { M4A_AAC_MAX_ACCESS_UNITS } from './timeline.ts';

const STSC_FULL_BOX_HEADER_BYTES = 8;
const STSC_ENTRY_BYTES = 12;
const STSC_MAX_ENTRIES = 2_048;
const STSZ_FULL_BOX_HEADER_BYTES = 12;
const STSZ_ENTRY_BYTES = 4;
const M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES = 8_191;
const M4A_SAMPLE_SIZE_MAX_CHECKPOINTS = 8_192;
const SAMPLE_SIZE_ENTRIES_PER_PAGE = Math.floor(ISO_BMFF_MAX_BOUNDED_READ_BYTES / STSZ_ENTRY_BYTES);
export const M4A_SAMPLE_SIZE_MAX_PAGES = Math.ceil(
  M4A_AAC_MAX_ACCESS_UNITS / SAMPLE_SIZE_ENTRIES_PER_PAGE,
);

export interface M4aSampleToChunkRun {
  readonly firstChunk: number;
  readonly samplesPerChunk: number;
  readonly sampleDescriptionIndex: 1;
}

export interface M4aSampleToChunkRunTable {
  readonly sampleCount: number;
  readonly runs: readonly Readonly<M4aSampleToChunkRun>[];
}

export interface M4aSamplePrefixCheckpoint {
  readonly ordinal: number;
  readonly prefixBytes: number;
}

export interface M4aSampleSizeIndex {
  readonly sampleCount: number;
  /** Zero means that the box carries one uint32 size per sample. */
  readonly fixedSampleSizeBytes: number;
  readonly entryTableStart: number;
  readonly totalEncodedBytes: number;
  /** Zero for a fixed-size table, otherwise the maximum random reread span. */
  readonly checkpointStride: number;
  readonly checkpoints: readonly Readonly<M4aSamplePrefixCheckpoint>[];
}

export interface M4aSampleSizeSequence {
  readonly ordinal: number;
  sumNext(sampleCount: number, signal: AbortSignal): Promise<number>;
}

interface SampleSizeAuthority {
  readonly reader: IsoBmffBoxReader;
  readonly sampleCount: number;
  readonly fixedSampleSizeBytes: number;
  readonly entryTableStart: number;
  readonly totalEncodedBytes: number;
  readonly checkpointStride: number;
  readonly checkpoints: readonly Readonly<M4aSamplePrefixCheckpoint>[];
  readonly pages: readonly Readonly<SampleSizePageEvidence>[];
}

interface SampleSizePageEvidence {
  readonly firstSampleOrdinal: number;
  readonly sampleCount: number;
  readonly sha256: string;
}

const sampleToChunkAuthorities = new WeakMap<object, IsoBmffBoxReader>();
const sampleSizeAuthorities = new WeakMap<object, SampleSizeAuthority>();

export class M4aSampleSizeError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aSampleSizeError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

const createSampleSizeError = (message: string, cause?: unknown): M4aSampleSizeError =>
  new M4aSampleSizeError(message, cause);

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
    throw new M4aSampleSizeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new M4aSampleSizeError(`${label} exceeds the browser safe-integer range`);
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

function requireZeroFullBox(bytes: Uint8Array, label: string): void {
  if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0) {
    throw new M4aSampleSizeError(`${label} FullBox version and flags must be zero`);
  }
}

function requireExpectedSampleCount(value: unknown): number {
  return requireInteger(value, 1, M4A_AAC_MAX_ACCESS_UNITS, 'M4A expected AAC access-unit count');
}

function requireSampleSize(value: number, ordinal: number): number {
  if (value < 1 || value > M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES) {
    throw new M4aSampleSizeError(
      `M4A AAC sample ${ordinal} size must be from 1 through ${M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES}`,
    );
  }
  return value;
}

function checkpoint(ordinal: number, prefixBytes: number): Readonly<M4aSamplePrefixCheckpoint> {
  return Object.freeze({ ordinal, prefixBytes });
}

/** Read and retain the small, strict `stsc` run table. */
export async function readM4aSampleToChunkRuns(
  reader: IsoBmffBoxReader,
  stscBox: Readonly<IsoBmffBoxRef>,
  expectedSampleCount: number,
  signal: AbortSignal,
): Promise<Readonly<M4aSampleToChunkRunTable>> {
  requireReaderAndSignal(reader, signal, 'M4A stsc reader');
  const sampleCount = requireExpectedSampleCount(expectedSampleCount);

  // Issued-reference provenance is checked before caller-controlled fields are inspected.
  const body = reader.createChildCursor(stscBox);
  if (stscBox.type !== 'stsc') {
    throw new M4aSampleSizeError('M4A sample-to-chunk parent must be an stsc box');
  }
  if (body.remainingBytes < STSC_FULL_BOX_HEADER_BYTES) {
    throw new M4aSampleSizeError('M4A stsc FullBox header is truncated');
  }

  const header = await reader.readBytes(body.start, STSC_FULL_BOX_HEADER_BYTES, signal);
  requireZeroFullBox(header, 'M4A stsc');
  const entryCount = readUint32(header, 4);
  if (entryCount < 1 || entryCount > STSC_MAX_ENTRIES) {
    throw new M4aSampleSizeError(`M4A stsc entry count must be from 1 through ${STSC_MAX_ENTRIES}`);
  }
  const expectedBodyBytes = STSC_FULL_BOX_HEADER_BYTES + entryCount * STSC_ENTRY_BYTES;
  if (body.remainingBytes !== expectedBodyBytes) {
    throw new M4aSampleSizeError(
      `M4A stsc body has ${body.remainingBytes} bytes; expected ${expectedBodyBytes}`,
    );
  }

  const bytes = await reader.readBytes(body.start, expectedBodyBytes, signal);
  const runs: Readonly<M4aSampleToChunkRun>[] = [];
  let previousFirstChunk = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = STSC_FULL_BOX_HEADER_BYTES + index * STSC_ENTRY_BYTES;
    const firstChunk = readUint32(bytes, offset);
    const samplesPerChunk = readUint32(bytes, offset + 4);
    const sampleDescriptionIndex = readUint32(bytes, offset + 8);
    if ((index === 0 && firstChunk !== 1) || firstChunk <= previousFirstChunk) {
      throw new M4aSampleSizeError(
        index === 0
          ? 'M4A stsc first run must begin at chunk 1'
          : 'M4A stsc first-chunk values must be strictly increasing',
      );
    }
    if (samplesPerChunk < 1 || samplesPerChunk > sampleCount) {
      throw new M4aSampleSizeError(
        `M4A stsc samples per chunk must be from 1 through ${sampleCount}`,
      );
    }
    if (sampleDescriptionIndex !== 1) {
      throw new M4aSampleSizeError('M4A stsc sample-description index must be exactly 1');
    }
    runs.push(Object.freeze({ firstChunk, samplesPerChunk, sampleDescriptionIndex: 1 }));
    previousFirstChunk = firstChunk;
  }

  reader.assertReadable(signal);
  const result = Object.freeze({ sampleCount, runs: Object.freeze(runs) });
  sampleToChunkAuthorities.set(result, reader);
  return result;
}

/**
 * Recover an issued `stsc` record without inspecting caller-controlled fields.
 * The exact frozen object and its source reader must both match the authority
 * captured when the table was parsed.
 */
export function assertM4aSampleToChunkRunTableProvenance(
  reader: IsoBmffBoxReader,
  table: Readonly<M4aSampleToChunkRunTable>,
  signal: AbortSignal,
): Readonly<M4aSampleToChunkRunTable> {
  requireReaderAndSignal(reader, signal, 'M4A stsc provenance assertion');
  reader.assertReadable(signal);
  const authority =
    table !== null && (typeof table === 'object' || typeof table === 'function')
      ? sampleToChunkAuthorities.get(table)
      : undefined;
  if (authority === undefined) {
    throw new M4aSampleSizeError('M4A sample-to-chunk table lacks module provenance');
  }
  if (authority !== reader) {
    throw new M4aSampleSizeError('M4A sample-to-chunk table belongs to a different source reader');
  }
  return table;
}

/** Read, fully validate, and sparsely index one strict `stsz` table. */
export async function readM4aSampleSizeIndex(
  reader: IsoBmffBoxReader,
  stszBox: Readonly<IsoBmffBoxRef>,
  expectedSampleCount: number,
  signal: AbortSignal,
): Promise<Readonly<M4aSampleSizeIndex>> {
  requireReaderAndSignal(reader, signal, 'M4A stsz reader');
  const sampleCount = requireExpectedSampleCount(expectedSampleCount);

  const body = reader.createChildCursor(stszBox);
  if (stszBox.type !== 'stsz') {
    throw new M4aSampleSizeError('M4A sample-size parent must be an stsz box');
  }
  if (body.remainingBytes < STSZ_FULL_BOX_HEADER_BYTES) {
    throw new M4aSampleSizeError('M4A stsz FullBox header is truncated');
  }

  const header = await reader.readBytes(body.start, STSZ_FULL_BOX_HEADER_BYTES, signal);
  requireZeroFullBox(header, 'M4A stsz');
  const fixedSampleSizeBytes = readUint32(header, 4);
  const declaredSampleCount = readUint32(header, 8);
  if (declaredSampleCount !== sampleCount) {
    throw new M4aSampleSizeError(
      `M4A stsz sample count ${declaredSampleCount} does not match expected ${sampleCount}`,
    );
  }
  if (fixedSampleSizeBytes > M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES) {
    throw new M4aSampleSizeError(
      `M4A fixed AAC sample size must be at most ${M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES}`,
    );
  }

  const entryTableStart = body.start + STSZ_FULL_BOX_HEADER_BYTES;
  if (fixedSampleSizeBytes !== 0) {
    if (body.remainingBytes !== STSZ_FULL_BOX_HEADER_BYTES) {
      throw new M4aSampleSizeError(
        `M4A fixed stsz body has ${body.remainingBytes} bytes; expected ${STSZ_FULL_BOX_HEADER_BYTES}`,
      );
    }
    const totalEncodedBytes = safeMultiply(
      fixedSampleSizeBytes,
      sampleCount,
      'M4A fixed sample-byte total',
    );
    const checkpoints = Object.freeze([
      checkpoint(0, 0),
      checkpoint(sampleCount, totalEncodedBytes),
    ]);
    reader.assertReadable(signal);
    const result = Object.freeze({
      sampleCount,
      fixedSampleSizeBytes,
      entryTableStart,
      totalEncodedBytes,
      checkpointStride: 0,
      checkpoints,
    });
    sampleSizeAuthorities.set(
      result,
      Object.freeze({
        reader,
        sampleCount,
        fixedSampleSizeBytes,
        entryTableStart,
        totalEncodedBytes,
        checkpointStride: 0,
        checkpoints,
        pages: Object.freeze([]),
      }),
    );
    return result;
  }

  const tableBytes = safeMultiply(sampleCount, STSZ_ENTRY_BYTES, 'M4A stsz entry-table size');
  const expectedBodyBytes = safeAdd(STSZ_FULL_BOX_HEADER_BYTES, tableBytes, 'M4A stsz body size');
  if (body.remainingBytes !== expectedBodyBytes) {
    throw new M4aSampleSizeError(
      `M4A variable stsz body has ${body.remainingBytes} bytes; expected ${expectedBodyBytes}`,
    );
  }

  const checkpointStride = Math.ceil(sampleCount / (M4A_SAMPLE_SIZE_MAX_CHECKPOINTS - 1));
  const checkpoints: Readonly<M4aSamplePrefixCheckpoint>[] = [checkpoint(0, 0)];
  const pages: Readonly<SampleSizePageEvidence>[] = [];
  let totalEncodedBytes = 0;
  let parsedSamples = 0;
  while (parsedSamples < sampleCount) {
    const pageSamples = Math.min(SAMPLE_SIZE_ENTRIES_PER_PAGE, sampleCount - parsedSamples);
    const page = await reader.readBytes(
      entryTableStart + parsedSamples * STSZ_ENTRY_BYTES,
      pageSamples * STSZ_ENTRY_BYTES,
      signal,
    );
    const pageDigest = await digestM4aMetadataPage(
      reader,
      page,
      signal,
      'M4A stsz page',
      createSampleSizeError,
    );
    pages.push(
      Object.freeze({
        firstSampleOrdinal: parsedSamples,
        sampleCount: pageSamples,
        sha256: pageDigest,
      }),
    );
    for (let offset = 0; offset < page.byteLength; offset += STSZ_ENTRY_BYTES) {
      const ordinal = parsedSamples + offset / STSZ_ENTRY_BYTES;
      const size = requireSampleSize(readUint32(page, offset), ordinal);
      totalEncodedBytes = safeAdd(totalEncodedBytes, size, 'M4A variable sample-byte total');
      const nextOrdinal = ordinal + 1;
      if (nextOrdinal < sampleCount && nextOrdinal % checkpointStride === 0) {
        checkpoints.push(checkpoint(nextOrdinal, totalEncodedBytes));
      }
    }
    parsedSamples += pageSamples;
  }
  checkpoints.push(checkpoint(sampleCount, totalEncodedBytes));
  if (checkpoints.length > M4A_SAMPLE_SIZE_MAX_CHECKPOINTS) {
    throw new M4aSampleSizeError('M4A stsz checkpoint count exceeded its proven bound');
  }
  if (pages.length > M4A_SAMPLE_SIZE_MAX_PAGES) {
    throw new M4aSampleSizeError('M4A stsz authenticated page count exceeded its proven bound');
  }

  reader.assertReadable(signal);
  const frozenCheckpoints = Object.freeze(checkpoints);
  const frozenPages = Object.freeze(pages);
  const result = Object.freeze({
    sampleCount,
    fixedSampleSizeBytes: 0,
    entryTableStart,
    totalEncodedBytes,
    checkpointStride,
    checkpoints: frozenCheckpoints,
  });
  sampleSizeAuthorities.set(
    result,
    Object.freeze({
      reader,
      sampleCount,
      fixedSampleSizeBytes: 0,
      entryTableStart,
      totalEncodedBytes,
      checkpointStride,
      checkpoints: frozenCheckpoints,
      pages: frozenPages,
    }),
  );
  return result;
}

async function readAuthenticatedSampleSizePage(
  reader: IsoBmffBoxReader,
  authority: SampleSizeAuthority,
  pageIndex: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const evidence = authority.pages[pageIndex];
  if (evidence === undefined) {
    throw new M4aSampleSizeError('M4A stsz authenticated page geometry is inconsistent');
  }
  const page = await reader.readBytes(
    authority.entryTableStart + evidence.firstSampleOrdinal * STSZ_ENTRY_BYTES,
    evidence.sampleCount * STSZ_ENTRY_BYTES,
    signal,
  );
  if (
    (await digestM4aMetadataPage(reader, page, signal, 'M4A stsz page', createSampleSizeError)) !==
    evidence.sha256
  ) {
    throw new M4aSampleSizeError('M4A stsz entries changed after the index was built');
  }
  return page;
}

function requireSampleSizeAuthority(
  reader: IsoBmffBoxReader,
  index: unknown,
  signal: AbortSignal,
): SampleSizeAuthority {
  reader.assertReadable(signal);
  const authority =
    (index !== null && (typeof index === 'object' || typeof index === 'function')
      ? sampleSizeAuthorities.get(index)
      : undefined) ?? null;
  if (authority === null) {
    throw new M4aSampleSizeError('M4A sample-size index lacks module provenance');
  }
  if (authority.reader !== reader) {
    throw new M4aSampleSizeError('M4A sample-size index belongs to a different source reader');
  }
  return authority;
}

function floorCheckpointIndex(
  checkpoints: readonly Readonly<M4aSamplePrefixCheckpoint>[],
  ordinal: number,
): number {
  let low = 0;
  let high = checkpoints.length - 1;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (checkpoints[middle]!.ordinal <= ordinal) low = middle;
    else high = middle;
  }
  // The terminal checkpoint authenticates the preceding segment rather than
  // serving as an empty scan origin.
  return ordinal === checkpoints[high]!.ordinal ? Math.max(0, high - 1) : low;
}

interface AuthenticatedSegmentResult {
  readonly prefixBytes: number;
  readonly sampleSizeBytes: number | null;
}

async function readAuthenticatedVariableSegment(
  reader: IsoBmffBoxReader,
  authority: SampleSizeAuthority,
  ordinal: number,
  captureSample: boolean,
  signal: AbortSignal,
): Promise<AuthenticatedSegmentResult> {
  const startCheckpointIndex = floorCheckpointIndex(authority.checkpoints, ordinal);
  const start = authority.checkpoints[startCheckpointIndex]!;
  const end = authority.checkpoints[startCheckpointIndex + 1]!;
  let runningPrefix = start.prefixBytes;
  let prefixBytes = ordinal === start.ordinal ? start.prefixBytes : -1;
  let sampleSizeBytes: number | null = null;
  let scanned = start.ordinal;

  while (scanned < end.ordinal) {
    const pageIndex = Math.floor(scanned / SAMPLE_SIZE_ENTRIES_PER_PAGE);
    const evidence = authority.pages[pageIndex]!;
    const page = await readAuthenticatedSampleSizePage(reader, authority, pageIndex, signal);
    const consumeEnd = Math.min(end.ordinal, evidence.firstSampleOrdinal + evidence.sampleCount);
    for (let currentOrdinal = scanned; currentOrdinal < consumeEnd; currentOrdinal += 1) {
      const offset = (currentOrdinal - evidence.firstSampleOrdinal) * STSZ_ENTRY_BYTES;
      const size = requireSampleSize(readUint32(page, offset), currentOrdinal);
      if (captureSample && currentOrdinal === ordinal) sampleSizeBytes = size;
      runningPrefix = safeAdd(runningPrefix, size, 'M4A sample prefix');
      if (currentOrdinal + 1 === ordinal) prefixBytes = runningPrefix;
    }
    scanned = consumeEnd;
  }

  if (runningPrefix !== end.prefixBytes) {
    throw new M4aSampleSizeError('M4A stsz entries changed after the index was built');
  }
  if (ordinal === end.ordinal) prefixBytes = end.prefixBytes;
  if (prefixBytes < 0 || (captureSample && sampleSizeBytes === null)) {
    throw new M4aSampleSizeError('M4A stsz checkpoint geometry is internally inconsistent');
  }
  reader.assertReadable(signal);
  return Object.freeze({ prefixBytes, sampleSizeBytes });
}

/** Read one zero-based raw AAC access-unit size. */
export async function readM4aSampleSizeAt(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aSampleSizeIndex>,
  ordinal: number,
  signal: AbortSignal,
): Promise<number> {
  requireReaderAndSignal(reader, signal, 'M4A sample-size lookup');
  const authority = requireSampleSizeAuthority(reader, index, signal);
  const sampleOrdinal = requireInteger(ordinal, 0, authority.sampleCount - 1, 'M4A sample ordinal');
  if (authority.fixedSampleSizeBytes !== 0) return authority.fixedSampleSizeBytes;
  const result = await readAuthenticatedVariableSegment(
    reader,
    authority,
    sampleOrdinal,
    true,
    signal,
  );
  return result.sampleSizeBytes!;
}

/** Read the encoded-byte prefix before an ordinal from zero through sampleCount. */
export async function readM4aSamplePrefixBytes(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aSampleSizeIndex>,
  ordinal: number,
  signal: AbortSignal,
): Promise<number> {
  requireReaderAndSignal(reader, signal, 'M4A sample-prefix lookup');
  const authority = requireSampleSizeAuthority(reader, index, signal);
  const sampleOrdinal = requireInteger(
    ordinal,
    0,
    authority.sampleCount,
    'M4A sample-prefix ordinal',
  );
  if (authority.fixedSampleSizeBytes !== 0) {
    return safeMultiply(authority.fixedSampleSizeBytes, sampleOrdinal, 'M4A fixed sample prefix');
  }
  return (await readAuthenticatedVariableSegment(reader, authority, sampleOrdinal, false, signal))
    .prefixBytes;
}

/** Create a source-bound, forward-only sample-size summation cursor. */
export function createM4aSampleSizeSequence(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aSampleSizeIndex>,
  startOrdinal = 0,
): M4aSampleSizeSequence {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A sample-size sequence requires an IsoBmffBoxReader');
  }
  const inspectionSignal = new AbortController().signal;
  const authority = requireSampleSizeAuthority(reader, index, inspectionSignal);
  const ordinal = requireInteger(
    startOrdinal,
    0,
    authority.sampleCount,
    'M4A sample-size sequence start ordinal',
  );
  return new SourceBoundM4aSampleSizeSequence(reader, authority, ordinal);
}

class SourceBoundM4aSampleSizeSequence implements M4aSampleSizeSequence {
  #ordinal: number;
  #reading = false;
  #cachedPageStart = -1;
  #cachedPage: Uint8Array = new Uint8Array(0);
  #verifiedPrefixBytes: number | null = null;
  #nextCheckpointIndex = 0;
  #pendingAuthenticationCheckpointIndex: number | null = null;

  constructor(
    private readonly reader: IsoBmffBoxReader,
    private readonly authority: SampleSizeAuthority,
    ordinal: number,
  ) {
    this.#ordinal = ordinal;
    if (authority.fixedSampleSizeBytes === 0) {
      const checkpointIndex = authority.checkpoints.findIndex(
        (candidate) => candidate.ordinal === ordinal,
      );
      if (checkpointIndex >= 0) {
        this.#verifiedPrefixBytes = authority.checkpoints[checkpointIndex]!.prefixBytes;
        this.#nextCheckpointIndex = checkpointIndex + 1;
      } else {
        this.#pendingAuthenticationCheckpointIndex = floorCheckpointIndex(
          authority.checkpoints,
          ordinal,
        );
      }
    }
  }

  get ordinal(): number {
    return this.#ordinal;
  }

  sumNext(sampleCount: number, signal: AbortSignal): Promise<number> {
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('M4A sample-size sequence requires an AbortSignal'));
    }
    try {
      this.reader.assertReadable(signal);
      requireInteger(
        sampleCount,
        0,
        this.authority.sampleCount - this.#ordinal,
        'M4A sequential sample count',
      );
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#reading) {
      return Promise.reject(
        new M4aSampleSizeError('Concurrent M4A sample-size sequence reads are not supported'),
      );
    }
    this.#reading = true;
    return this.#sumNext(sampleCount, signal).finally(() => {
      this.#reading = false;
    });
  }

  async #sumNext(sampleCount: number, signal: AbortSignal): Promise<number> {
    if (sampleCount === 0) {
      this.reader.assertReadable(signal);
      return 0;
    }
    if (this.authority.fixedSampleSizeBytes !== 0) {
      const sum = safeMultiply(
        this.authority.fixedSampleSizeBytes,
        sampleCount,
        'M4A sequential fixed sample sum',
      );
      this.reader.assertReadable(signal);
      this.#ordinal += sampleCount;
      return sum;
    }

    const startOrdinal = this.#ordinal;
    const endOrdinal = startOrdinal + sampleCount;
    let scanOrdinal = startOrdinal;
    let sum = 0;
    let verifiedPrefixBytes = this.#verifiedPrefixBytes;
    let nextCheckpointIndex = this.#nextCheckpointIndex;
    const pendingAuthenticationCheckpointIndex = this.#pendingAuthenticationCheckpointIndex;
    if (pendingAuthenticationCheckpointIndex !== null) {
      const authenticated = await readAuthenticatedVariableSegment(
        this.reader,
        this.authority,
        startOrdinal,
        false,
        signal,
      );
      verifiedPrefixBytes = authenticated.prefixBytes;
      nextCheckpointIndex = pendingAuthenticationCheckpointIndex + 1;
    }
    while (scanOrdinal < endOrdinal) {
      const pageStart =
        Math.floor(scanOrdinal / SAMPLE_SIZE_ENTRIES_PER_PAGE) * SAMPLE_SIZE_ENTRIES_PER_PAGE;
      if (this.#cachedPageStart !== pageStart) {
        const pageIndex = Math.floor(scanOrdinal / SAMPLE_SIZE_ENTRIES_PER_PAGE);
        this.#cachedPage = await readAuthenticatedSampleSizePage(
          this.reader,
          this.authority,
          pageIndex,
          signal,
        );
        this.#cachedPageStart = pageStart;
      }

      const pageEndOrdinal = this.#cachedPageStart + this.#cachedPage.byteLength / STSZ_ENTRY_BYTES;
      const consumeEnd = Math.min(endOrdinal, pageEndOrdinal);
      for (; scanOrdinal < consumeEnd; scanOrdinal += 1) {
        const offset = (scanOrdinal - this.#cachedPageStart) * STSZ_ENTRY_BYTES;
        const size = requireSampleSize(readUint32(this.#cachedPage, offset), scanOrdinal);
        sum = safeAdd(sum, size, 'M4A sequential sample sum');
        if (verifiedPrefixBytes !== null) {
          verifiedPrefixBytes = safeAdd(
            verifiedPrefixBytes,
            size,
            'M4A sequential verified sample prefix',
          );
          const nextCheckpoint = this.authority.checkpoints[nextCheckpointIndex];
          if (nextCheckpoint?.ordinal === scanOrdinal + 1) {
            if (verifiedPrefixBytes !== nextCheckpoint.prefixBytes) {
              throw new M4aSampleSizeError(
                'M4A stsz entries changed after the sequential index was built',
              );
            }
            nextCheckpointIndex += 1;
          }
        }
      }
    }

    this.reader.assertReadable(signal);
    this.#ordinal = endOrdinal;
    this.#verifiedPrefixBytes = verifiedPrefixBytes;
    this.#nextCheckpointIndex = nextCheckpointIndex;
    this.#pendingAuthenticationCheckpointIndex = null;
    return sum;
  }
}
