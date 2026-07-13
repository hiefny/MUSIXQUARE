import type { IsoBmffBoxRef } from '../mp4/box.ts';
import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import {
  M4A_AAC_MAX_STTS_ENTRIES,
  M4aAacSttsAccumulator,
  type M4aAacSttsEvidence,
} from './timeline.ts';

const SAMPLE_TABLE_BOX_TYPES = Object.freeze(['stsd', 'stts', 'stsc', 'stsz'] as const);
const UNSUPPORTED_SAMPLE_TABLE_BOX_TYPES = new Set([
  'ctts',
  'sbgp',
  'sgpd',
  'saio',
  'saiz',
  'sdtp',
  'stss',
  'stz2',
  'subs',
]);
const STTS_FULL_BOX_HEADER_BYTES = 8;
const STTS_ENTRY_BYTES = 8;
export const M4A_STTS_MAX_PAGE_BYTES = 64 * 1_024;

export interface M4aSampleTableLayout {
  readonly stsd: Readonly<IsoBmffBoxRef>;
  readonly stts: Readonly<IsoBmffBoxRef>;
  readonly stsc: Readonly<IsoBmffBoxRef>;
  readonly stsz: Readonly<IsoBmffBoxRef>;
  readonly chunkOffsets: Readonly<IsoBmffBoxRef>;
  readonly chunkOffsetWidthBytes: 4 | 8;
}

export class M4aSampleTableError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aSampleTableError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x100_0000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
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

/**
 * Retain only the provenance-bearing child references needed by the initial
 * non-fragmented AAC sample-table subset.
 */
export async function readM4aSampleTableLayout(
  reader: IsoBmffBoxReader,
  stblBox: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<M4aSampleTableLayout>> {
  requireReaderAndSignal(reader, signal, 'M4A sample-table layout');

  // Provenance is checked before inspecting any caller-controlled fields.
  const children = reader.createChildCursor(stblBox);
  if (stblBox.type !== 'stbl') {
    throw new M4aSampleTableError('M4A sample-table parent must be an stbl box');
  }

  const required = new Map<string, Readonly<IsoBmffBoxRef>>();
  let chunkOffsets: Readonly<IsoBmffBoxRef> | null = null;

  for (;;) {
    const child = await children.next(signal);
    if (child === null) break;

    if ((SAMPLE_TABLE_BOX_TYPES as readonly string[]).includes(child.type)) {
      if (required.has(child.type)) {
        throw new M4aSampleTableError(
          `M4A sample table contains duplicate ${JSON.stringify(child.type)} boxes`,
        );
      }
      required.set(child.type, child);
      continue;
    }

    if (child.type === 'stco' || child.type === 'co64') {
      if (chunkOffsets !== null) {
        throw new M4aSampleTableError('M4A sample table must contain exactly one of stco or co64');
      }
      chunkOffsets = child;
      continue;
    }

    if (UNSUPPORTED_SAMPLE_TABLE_BOX_TYPES.has(child.type)) {
      throw new M4aSampleTableError(
        `Unsupported M4A sample-table box ${JSON.stringify(child.type)}`,
      );
    }
    throw new M4aSampleTableError(
      `Unknown M4A sample-table box ${JSON.stringify(child.type)} is not admitted`,
    );
  }

  for (const type of SAMPLE_TABLE_BOX_TYPES) {
    if (!required.has(type)) {
      throw new M4aSampleTableError(`M4A sample table is missing its ${type} box`);
    }
  }
  if (chunkOffsets === null) {
    throw new M4aSampleTableError('M4A sample table is missing stco or co64 chunk offsets');
  }

  reader.assertReadable(signal);
  return Object.freeze({
    stsd: required.get('stsd')!,
    stts: required.get('stts')!,
    stsc: required.get('stsc')!,
    stsz: required.get('stsz')!,
    chunkOffsets,
    chunkOffsetWidthBytes: chunkOffsets.type === 'stco' ? 4 : 8,
  });
}

/**
 * Stream every `stts` entry through the bounded AAC-LC accumulator. The table
 * body is never retained and no read exceeds 64 KiB.
 */
export async function readM4aAacSttsEvidence(
  reader: IsoBmffBoxReader,
  sttsBox: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<M4aAacSttsEvidence>> {
  requireReaderAndSignal(reader, signal, 'M4A AAC stts reader');

  const body = reader.createChildCursor(sttsBox);
  if (sttsBox.type !== 'stts') {
    throw new M4aSampleTableError('M4A AAC time-to-sample parent must be an stts box');
  }
  if (body.remainingBytes < STTS_FULL_BOX_HEADER_BYTES) {
    throw new M4aSampleTableError('M4A AAC stts FullBox header is truncated');
  }

  const header = await reader.readBytes(body.start, STTS_FULL_BOX_HEADER_BYTES, signal);
  if (header[0] !== 0 || header[1] !== 0 || header[2] !== 0 || header[3] !== 0) {
    throw new M4aSampleTableError('M4A AAC stts FullBox version and flags must be zero');
  }
  const entryCount = readUint32(header, 4);
  if (entryCount < 1 || entryCount > M4A_AAC_MAX_STTS_ENTRIES) {
    throw new M4aSampleTableError(
      `M4A AAC stts entry count must be from 1 through ${M4A_AAC_MAX_STTS_ENTRIES}`,
    );
  }
  const expectedBodyBytes = STTS_FULL_BOX_HEADER_BYTES + entryCount * STTS_ENTRY_BYTES;
  if (!Number.isSafeInteger(expectedBodyBytes) || body.remainingBytes !== expectedBodyBytes) {
    throw new M4aSampleTableError(
      `M4A AAC stts body has ${body.remainingBytes} bytes; expected ${expectedBodyBytes}`,
    );
  }

  const accumulator = new M4aAacSttsAccumulator();
  const entriesPerPage = Math.floor(M4A_STTS_MAX_PAGE_BYTES / STTS_ENTRY_BYTES);
  let parsedEntries = 0;
  while (parsedEntries < entryCount) {
    const pageEntries = Math.min(entriesPerPage, entryCount - parsedEntries);
    const pageBytes = pageEntries * STTS_ENTRY_BYTES;
    const page = await reader.readBytes(
      body.start + STTS_FULL_BOX_HEADER_BYTES + parsedEntries * STTS_ENTRY_BYTES,
      pageBytes,
      signal,
    );
    for (let offset = 0; offset < page.byteLength; offset += STTS_ENTRY_BYTES) {
      accumulator.addRun(readUint32(page, offset), readUint32(page, offset + 4));
    }
    parsedEntries += pageEntries;
  }

  reader.assertReadable(signal);
  return accumulator.finish();
}
