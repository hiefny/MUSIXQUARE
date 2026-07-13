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
  'saio',
  'saiz',
  'sdtp',
  'stss',
  'stz2',
  'subs',
]);
const STTS_FULL_BOX_HEADER_BYTES = 8;
const STTS_ENTRY_BYTES = 8;
const SAMPLE_GROUP_COMMON_PREFIX_BYTES = 8;
export const M4A_STTS_MAX_PAGE_BYTES = 64 * 1_024;

export interface M4aSampleTableLayout {
  readonly stsd: Readonly<IsoBmffBoxRef>;
  readonly stts: Readonly<IsoBmffBoxRef>;
  readonly stsc: Readonly<IsoBmffBoxRef>;
  readonly stsz: Readonly<IsoBmffBoxRef>;
  readonly chunkOffsets: Readonly<IsoBmffBoxRef>;
  readonly chunkOffsetWidthBytes: 4 | 8;
  readonly rollRecoverySampleGroup: Readonly<M4aRollRecoverySampleGroupLayout> | null;
}

export interface M4aRollRecoverySampleGroupLayout {
  readonly sgpd: Readonly<IsoBmffBoxRef>;
  readonly sbgp: Readonly<IsoBmffBoxRef>;
}

interface RollRecoverySampleGroupAuthority {
  readonly reader: IsoBmffBoxReader;
  readonly stbl: Readonly<IsoBmffBoxRef>;
  readonly layout: Readonly<M4aRollRecoverySampleGroupLayout>;
}

const rollRecoverySampleGroupAuthorities = new WeakMap<
  object,
  Readonly<RollRecoverySampleGroupAuthority>
>();

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

function readFourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function minimumSampleGroupBodyBytes(type: 'sgpd' | 'sbgp', version: number): number {
  if (type === 'sgpd') {
    if (version === 0) return 12;
    if (version === 1) return 16;
    return 20;
  }
  return version === 1 ? 16 : 12;
}

async function readSampleGroupingType(
  reader: IsoBmffBoxReader,
  box: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<string> {
  const body = reader.createChildCursor(box);
  if (box.type !== 'sgpd' && box.type !== 'sbgp') {
    throw new M4aSampleTableError('M4A sample-group discovery requires an sgpd or sbgp box');
  }
  if (body.remainingBytes < SAMPLE_GROUP_COMMON_PREFIX_BYTES) {
    throw new M4aSampleTableError(`M4A ${box.type} FullBox and grouping-type prefix is truncated`);
  }

  const commonPrefix = await reader.readBytes(body.start, SAMPLE_GROUP_COMMON_PREFIX_BYTES, signal);
  const minimumBodyBytes = minimumSampleGroupBodyBytes(box.type, commonPrefix[0]!);
  if (body.remainingBytes < minimumBodyBytes) {
    throw new M4aSampleTableError(
      `M4A ${box.type} version ${commonPrefix[0]} body is shorter than ${minimumBodyBytes} bytes`,
    );
  }

  // Read the complete version-dependent fixed prefix before skipping an
  // unconsumed grouping type. No group-specific entry body is retained.
  if (minimumBodyBytes > commonPrefix.byteLength) {
    await reader.readBytes(body.start, minimumBodyBytes, signal);
  }
  return readFourCc(commonPrefix, 4);
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
  let sgpd: Readonly<IsoBmffBoxRef> | null = null;
  let sbgp: Readonly<IsoBmffBoxRef> | null = null;

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

    if (child.type === 'sgpd' || child.type === 'sbgp') {
      const groupingType = await readSampleGroupingType(reader, child, signal);
      if (groupingType !== 'roll') {
        continue;
      }
      if (child.type === 'sgpd') {
        if (sgpd !== null) {
          throw new M4aSampleTableError('M4A sample table contains duplicate "roll" sgpd boxes');
        }
        sgpd = child;
      } else {
        if (sbgp !== null) {
          throw new M4aSampleTableError('M4A sample table contains duplicate "roll" sbgp boxes');
        }
        sbgp = child;
      }
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
  if ((sgpd === null) !== (sbgp === null)) {
    throw new M4aSampleTableError(
      'M4A roll-recovery sample-group boxes sgpd and sbgp must appear as a pair',
    );
  }

  const rollRecoverySampleGroup =
    sgpd === null || sbgp === null ? null : Object.freeze({ sgpd, sbgp });
  if (rollRecoverySampleGroup !== null) {
    rollRecoverySampleGroupAuthorities.set(
      rollRecoverySampleGroup,
      Object.freeze({ reader, stbl: stblBox, layout: rollRecoverySampleGroup }),
    );
  }

  reader.assertReadable(signal);
  return Object.freeze({
    stsd: required.get('stsd')!,
    stts: required.get('stts')!,
    stsc: required.get('stsc')!,
    stsz: required.get('stsz')!,
    chunkOffsets,
    chunkOffsetWidthBytes: chunkOffsets.type === 'stco' ? 4 : 8,
    rollRecoverySampleGroup,
  });
}

/**
 * Recover only the exact `roll` pair issued while walking this reader's
 * selected `stbl`. Authentic box references from another table cannot be
 * spliced into a manufactured pair.
 */
export function assertM4aRollRecoverySampleGroupLayoutProvenance(
  reader: IsoBmffBoxReader,
  layout: Readonly<M4aRollRecoverySampleGroupLayout>,
  signal: AbortSignal,
): Readonly<M4aRollRecoverySampleGroupLayout> {
  requireReaderAndSignal(reader, signal, 'M4A roll-recovery layout provenance');
  reader.assertReadable(signal);
  const authority =
    layout !== null && (typeof layout === 'object' || typeof layout === 'function')
      ? rollRecoverySampleGroupAuthorities.get(layout)
      : undefined;
  if (authority === undefined) {
    throw new M4aSampleTableError('M4A roll-recovery layout lacks module provenance');
  }
  if (authority.reader !== reader) {
    throw new M4aSampleTableError('M4A roll-recovery layout belongs to a different source reader');
  }
  // Re-authenticate the issuing table as well as the retained pair before
  // returning trusted evidence to a downstream parser.
  reader.createChildCursor(authority.stbl);
  reader.createChildCursor(authority.layout.sgpd);
  reader.createChildCursor(authority.layout.sbgp);
  return authority.layout;
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
