import type { IsoBmffBoxRef } from '../mp4/box.ts';
import { ISO_BMFF_MAX_BOUNDED_READ_BYTES, IsoBmffBoxReader } from '../mp4/box-reader.ts';
import {
  EncodedSourceIntegrityError,
  isEncodedAudioSourceIdentity,
} from '../sources/encoded-audio-source.ts';
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

export interface M4aSampleSizePageEvidence {
  readonly firstSampleOrdinal: number;
  readonly sampleCount: number;
  readonly sha256: string;
}

/** Shared source binding owned by the enclosing transferable M4A manifest. */
export interface M4aIndexSourceBinding {
  readonly sourceSize: number;
  readonly sourceIdentity: string;
}

/** Deeply data-only evidence needed to reopen one authenticated `stsz` index. */
export interface M4aSampleSizeIndexSnapshot {
  readonly sampleCount: number;
  readonly fixedSampleSizeBytes: number;
  readonly entryTableStart: number;
  readonly totalEncodedBytes: number;
  readonly checkpointStride: number;
  readonly checkpoints: readonly Readonly<M4aSamplePrefixCheckpoint>[];
  readonly headerSha256: string;
  readonly pages: readonly Readonly<M4aSampleSizePageEvidence>[];
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
  readonly headerSha256: string;
  readonly pages: readonly Readonly<M4aSampleSizePageEvidence>[];
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

const SNAPSHOT_KEYS = Object.freeze([
  'sampleCount',
  'fixedSampleSizeBytes',
  'entryTableStart',
  'totalEncodedBytes',
  'checkpointStride',
  'checkpoints',
  'headerSha256',
  'pages',
] as const);
const CHECKPOINT_KEYS = Object.freeze(['ordinal', 'prefixBytes'] as const);
const PAGE_EVIDENCE_KEYS = Object.freeze(['firstSampleOrdinal', 'sampleCount', 'sha256'] as const);
const SOURCE_BINDING_KEYS = Object.freeze(['sourceSize', 'sourceIdentity'] as const);
const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;

function requireExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw createSampleSizeError(`${label} must be a plain data object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw createSampleSizeError(`${label} must not be a class instance`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      throw createSampleSizeError(`${label} must contain exactly its canonical keys`);
    }
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw createSampleSizeError(`${label}.${key} must be own enumerable data`);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof M4aSampleSizeError) throw error;
    throw createSampleSizeError(`${label} could not be inspected as data`, error);
  }
}

function requireDenseDataArray(
  value: unknown,
  maximumLength: number,
  label: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw createSampleSizeError(`${label} must be a plain array`);
    }
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
      throw createSampleSizeError(`${label} length exceeds its proven bound`);
    }
    const length = lengthValue;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) < 0 || Number(key) >= length)),
      )
    ) {
      throw createSampleSizeError(`${label} must be dense and contain no extra properties`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw createSampleSizeError(`${label}[${index}] must be own enumerable data`);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof M4aSampleSizeError) throw error;
    throw createSampleSizeError(`${label} could not be inspected as data`, error);
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
    throw createSampleSizeError(`${label} is outside its canonical integer range`, error);
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_LOWER_HEX.test(value)) {
    throw createSampleSizeError(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

/** Validate and canonically copy the source binding owned by a top-level manifest. */
export function validateM4aIndexSourceBinding(value: unknown): Readonly<M4aIndexSourceBinding> {
  const record = requireExactDataRecord(value, SOURCE_BINDING_KEYS, 'M4A index source binding');
  const sourceSize = requireSnapshotInteger(
    record.sourceSize,
    0,
    Number.MAX_SAFE_INTEGER,
    'M4A index source size',
  );
  if (!isEncodedAudioSourceIdentity(record.sourceIdentity)) {
    throw createSampleSizeError('M4A index source identity is invalid');
  }
  return Object.freeze({ sourceSize, sourceIdentity: record.sourceIdentity });
}

/** Strictly validate and deeply canonicalize an untrusted transferable snapshot. */
export function validateM4aSampleSizeIndexSnapshot(
  value: unknown,
): Readonly<M4aSampleSizeIndexSnapshot> {
  const record = requireExactDataRecord(value, SNAPSHOT_KEYS, 'M4A stsz snapshot');
  const sampleCount = requireSnapshotInteger(
    record.sampleCount,
    1,
    M4A_AAC_MAX_ACCESS_UNITS,
    'M4A stsz snapshot sample count',
  );
  const fixedSampleSizeBytes = requireSnapshotInteger(
    record.fixedSampleSizeBytes,
    0,
    M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES,
    'M4A stsz snapshot fixed sample size',
  );
  const entryTableStart = requireSnapshotInteger(
    record.entryTableStart,
    STSZ_FULL_BOX_HEADER_BYTES,
    Number.MAX_SAFE_INTEGER,
    'M4A stsz snapshot entry-table start',
  );
  const maximumTotalEncodedBytes = safeMultiply(
    sampleCount,
    M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES,
    'M4A stsz snapshot maximum sample-byte total',
  );
  const totalEncodedBytes = requireSnapshotInteger(
    record.totalEncodedBytes,
    sampleCount,
    maximumTotalEncodedBytes,
    'M4A stsz snapshot sample-byte total',
  );
  const checkpointStride = requireSnapshotInteger(
    record.checkpointStride,
    0,
    sampleCount,
    'M4A stsz snapshot checkpoint stride',
  );
  const headerSha256 = requireSha256(record.headerSha256, 'M4A stsz snapshot header digest');

  const checkpointValues = requireDenseDataArray(
    record.checkpoints,
    M4A_SAMPLE_SIZE_MAX_CHECKPOINTS,
    'M4A stsz snapshot checkpoints',
  );
  const checkpoints = checkpointValues.map((candidate, index) => {
    const item = requireExactDataRecord(
      candidate,
      CHECKPOINT_KEYS,
      `M4A stsz snapshot checkpoint ${index}`,
    );
    return checkpoint(
      requireSnapshotInteger(
        item.ordinal,
        0,
        sampleCount,
        `M4A stsz snapshot checkpoint ${index} ordinal`,
      ),
      requireSnapshotInteger(
        item.prefixBytes,
        0,
        totalEncodedBytes,
        `M4A stsz snapshot checkpoint ${index} prefix`,
      ),
    );
  });
  const pageValues = requireDenseDataArray(
    record.pages,
    M4A_SAMPLE_SIZE_MAX_PAGES,
    'M4A stsz snapshot pages',
  );
  const pages = pageValues.map((candidate, index) => {
    const item = requireExactDataRecord(
      candidate,
      PAGE_EVIDENCE_KEYS,
      `M4A stsz snapshot page ${index}`,
    );
    return Object.freeze({
      firstSampleOrdinal: requireSnapshotInteger(
        item.firstSampleOrdinal,
        0,
        sampleCount - 1,
        `M4A stsz snapshot page ${index} first ordinal`,
      ),
      sampleCount: requireSnapshotInteger(
        item.sampleCount,
        1,
        SAMPLE_SIZE_ENTRIES_PER_PAGE,
        `M4A stsz snapshot page ${index} sample count`,
      ),
      sha256: requireSha256(item.sha256, `M4A stsz snapshot page ${index} digest`),
    });
  });

  if (fixedSampleSizeBytes !== 0) {
    const expectedTotal = safeMultiply(
      fixedSampleSizeBytes,
      sampleCount,
      'M4A fixed snapshot sample-byte total',
    );
    if (
      checkpointStride !== 0 ||
      totalEncodedBytes !== expectedTotal ||
      checkpoints.length !== 2 ||
      checkpoints[0]!.ordinal !== 0 ||
      checkpoints[0]!.prefixBytes !== 0 ||
      checkpoints[1]!.ordinal !== sampleCount ||
      checkpoints[1]!.prefixBytes !== totalEncodedBytes ||
      pages.length !== 0
    ) {
      throw createSampleSizeError('M4A fixed stsz snapshot geometry is inconsistent');
    }
  } else {
    const expectedStride = Math.ceil(sampleCount / (M4A_SAMPLE_SIZE_MAX_CHECKPOINTS - 1));
    const expectedCheckpointCount = Math.floor((sampleCount - 1) / expectedStride) + 2;
    if (
      checkpointStride !== expectedStride ||
      checkpoints.length !== expectedCheckpointCount ||
      checkpoints[0]!.ordinal !== 0 ||
      checkpoints[0]!.prefixBytes !== 0 ||
      checkpoints.at(-1)!.ordinal !== sampleCount ||
      checkpoints.at(-1)!.prefixBytes !== totalEncodedBytes
    ) {
      throw createSampleSizeError('M4A variable stsz checkpoint coverage is inconsistent');
    }
    for (let index = 1; index < checkpoints.length; index += 1) {
      const previous = checkpoints[index - 1]!;
      const current = checkpoints[index]!;
      const expectedOrdinal =
        index === checkpoints.length - 1 ? sampleCount : index * checkpointStride;
      const ordinalDelta = current.ordinal - previous.ordinal;
      const prefixDelta = current.prefixBytes - previous.prefixBytes;
      if (
        current.ordinal !== expectedOrdinal ||
        ordinalDelta < 1 ||
        prefixDelta < ordinalDelta ||
        prefixDelta > ordinalDelta * M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES
      ) {
        throw createSampleSizeError('M4A variable stsz checkpoint evidence is inconsistent');
      }
    }

    const expectedPageCount = Math.ceil(sampleCount / SAMPLE_SIZE_ENTRIES_PER_PAGE);
    if (pages.length !== expectedPageCount) {
      throw createSampleSizeError('M4A variable stsz page coverage is inconsistent');
    }
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]!;
      const expectedFirstSampleOrdinal = index * SAMPLE_SIZE_ENTRIES_PER_PAGE;
      const expectedSampleCount = Math.min(
        SAMPLE_SIZE_ENTRIES_PER_PAGE,
        sampleCount - expectedFirstSampleOrdinal,
      );
      if (
        page.firstSampleOrdinal !== expectedFirstSampleOrdinal ||
        page.sampleCount !== expectedSampleCount
      ) {
        throw createSampleSizeError('M4A variable stsz page evidence is inconsistent');
      }
    }
  }

  return Object.freeze({
    sampleCount,
    fixedSampleSizeBytes,
    entryTableStart,
    totalEncodedBytes,
    checkpointStride,
    checkpoints: Object.freeze(checkpoints),
    headerSha256,
    pages: Object.freeze(pages),
  });
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
  const headerSha256 = await digestM4aMetadataPage(
    reader,
    header,
    signal,
    'M4A stsz header',
    createSampleSizeError,
  );

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
        headerSha256,
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
  const pages: Readonly<M4aSampleSizePageEvidence>[] = [];
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
      headerSha256,
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

/** Export a deeply data-only snapshot from an authentic same-reader index. */
export function snapshotM4aSampleSizeIndex(
  reader: IsoBmffBoxReader,
  index: Readonly<M4aSampleSizeIndex>,
  signal: AbortSignal,
): Readonly<M4aSampleSizeIndexSnapshot> {
  requireReaderAndSignal(reader, signal, 'M4A stsz snapshot export');
  const authority = requireSampleSizeAuthority(reader, index, signal);
  return Object.freeze({
    sampleCount: authority.sampleCount,
    fixedSampleSizeBytes: authority.fixedSampleSizeBytes,
    entryTableStart: authority.entryTableStart,
    totalEncodedBytes: authority.totalEncodedBytes,
    checkpointStride: authority.checkpointStride,
    checkpoints: Object.freeze(
      authority.checkpoints.map((item) => checkpoint(item.ordinal, item.prefixBytes)),
    ),
    headerSha256: authority.headerSha256,
    pages: Object.freeze(
      authority.pages.map((page) =>
        Object.freeze({
          firstSampleOrdinal: page.firstSampleOrdinal,
          sampleCount: page.sampleCount,
          sha256: page.sha256,
        }),
      ),
    ),
  });
}

/**
 * Reopen an untrusted transferable snapshot against one explicitly bound source.
 * Only the 12-byte `stsz` header is reread here; variable table pages remain lazy.
 */
export async function rehydrateM4aSampleSizeIndex(
  reader: IsoBmffBoxReader,
  snapshotValue: unknown,
  expectedSourceValue: unknown,
  signal: AbortSignal,
): Promise<Readonly<M4aSampleSizeIndex>> {
  requireReaderAndSignal(reader, signal, 'M4A stsz snapshot rehydration');
  reader.assertReadable(signal);
  const expectedSource = validateM4aIndexSourceBinding(expectedSourceValue);
  if (
    reader.sourceSize !== expectedSource.sourceSize ||
    reader.sourceIdentity !== expectedSource.sourceIdentity
  ) {
    throw createSampleSizeError('M4A stsz snapshot source binding does not match its reader');
  }
  const snapshot = validateM4aSampleSizeIndexSnapshot(snapshotValue);
  const tableBytes =
    snapshot.fixedSampleSizeBytes === 0
      ? safeMultiply(snapshot.sampleCount, STSZ_ENTRY_BYTES, 'M4A rehydrated stsz table size')
      : 0;
  const tableEnd = safeAdd(snapshot.entryTableStart, tableBytes, 'M4A rehydrated stsz table end');
  if (tableEnd > expectedSource.sourceSize) {
    throw createSampleSizeError('M4A stsz snapshot table exceeds its bound source');
  }

  const header = await reader.readBytes(
    snapshot.entryTableStart - STSZ_FULL_BOX_HEADER_BYTES,
    STSZ_FULL_BOX_HEADER_BYTES,
    signal,
  );
  const headerSha256 = await digestM4aMetadataPage(
    reader,
    header,
    signal,
    'M4A stsz header',
    createSampleSizeError,
  );
  if (headerSha256 !== snapshot.headerSha256) {
    throw createSampleSizeError('M4A stsz header changed after the snapshot was built');
  }
  requireZeroFullBox(header, 'M4A stsz');
  if (
    readUint32(header, 4) !== snapshot.fixedSampleSizeBytes ||
    readUint32(header, 8) !== snapshot.sampleCount
  ) {
    throw createSampleSizeError('M4A stsz header does not match its snapshot geometry');
  }

  reader.assertReadable(signal);
  const index = Object.freeze({
    sampleCount: snapshot.sampleCount,
    fixedSampleSizeBytes: snapshot.fixedSampleSizeBytes,
    entryTableStart: snapshot.entryTableStart,
    totalEncodedBytes: snapshot.totalEncodedBytes,
    checkpointStride: snapshot.checkpointStride,
    checkpoints: snapshot.checkpoints,
  });
  sampleSizeAuthorities.set(
    index,
    Object.freeze({
      reader,
      sampleCount: snapshot.sampleCount,
      fixedSampleSizeBytes: snapshot.fixedSampleSizeBytes,
      entryTableStart: snapshot.entryTableStart,
      totalEncodedBytes: snapshot.totalEncodedBytes,
      checkpointStride: snapshot.checkpointStride,
      checkpoints: snapshot.checkpoints,
      headerSha256: snapshot.headerSha256,
      pages: snapshot.pages,
    }),
  );
  return index;
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
