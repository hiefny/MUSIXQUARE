import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';

const ID3V2_HEADER_BYTES = 10;
const ID3V2_FOOTER_BYTES = 10;
const ID3V1_BYTES = 128;
const ID3V1_MARKER_BYTES = 3;

export const MP3_MAX_LEADING_ID3V2_TAGS = 8;
export const MP3_MAX_TRAILING_ID3V2_TAGS = MP3_MAX_LEADING_ID3V2_TAGS;

export type Id3v2MajorVersion = 2 | 3 | 4;

/** A half-open boundary for one leading or appended ID3v2 tag. */
export interface Id3v2TagBoundary {
  readonly headerOffset: number;
  readonly bodyOffset: number;
  readonly bodyBytes: number;
  /** ID3v2.4 footer offset. The footer starts with the reverse marker `3DI`. */
  readonly footerOffset: number | null;
  readonly endOffset: number;
  readonly majorVersion: Id3v2MajorVersion;
  readonly revision: number;
  readonly flags: number;
}

/** Metadata-free byte boundaries consumed by the strict bounded MP3 indexer. */
export interface Mp3Id3Boundaries {
  readonly sourceBytes: number;
  /** First byte after all consecutive leading ID3v2 tags. */
  readonly dataStart: number;
  /** Exclusive audio end, before appended ID3v2.4 tags and optional ID3v1. */
  readonly audioEnd: number;
  readonly leadingTagCount: number;
  readonly leadingTags: readonly Id3v2TagBoundary[];
  readonly hasTrailingId3v1: boolean;
  readonly trailingId3v1Offset: number | null;
}

/** Complete result returned by the ID3 boundary reader. */
export interface ParsedMp3Id3Boundaries extends Mp3Id3Boundaries {
  /** Number of consecutive appended ID3v2.4 tags before an optional ID3v1 tag. */
  readonly trailingTagCount: number;
  /** Appended ID3v2.4 tags in ascending file order, separate from leading tags. */
  readonly trailingTags: readonly Id3v2TagBoundary[];
}

/** A claimed leading ID3 tag uses a major version this indexer cannot skip safely. */
export class UnsupportedId3v2VersionError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedId3v2VersionError';
  }
}

function matchesMarker(bytes: Uint8Array, marker: string): boolean {
  if (bytes.byteLength < marker.length) return false;
  for (let index = 0; index < marker.length; index += 1) {
    if (bytes[index] !== marker.charCodeAt(index)) return false;
  }
  return true;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new EncodedSourceIntegrityError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

async function readExact(
  source: EncodedAudioSource,
  sourceBytes: number,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  validateExactRead(sourceBytes, offset, length);
  throwIfAborted(signal);
  const bytes = await source.readAt(offset, length, signal);
  throwIfAborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new EncodedSourceIntegrityError(
      `ID3 boundary read returned ${bytes instanceof Uint8Array ? bytes.byteLength : 'invalid'} bytes; expected ${length}`,
    );
  }
  return bytes;
}

function readSyncsafeSize(header: Uint8Array): number {
  let value = 0;
  for (let index = 6; index < 10; index += 1) {
    const byte = header[index] ?? 0;
    if ((byte & 0x80) !== 0) {
      throw new EncodedSourceIntegrityError('ID3v2 tag size is not a 28-bit syncsafe integer');
    }
    value = value * 128 + byte;
  }
  return value;
}

function readMajorVersion(header: Uint8Array): Id3v2MajorVersion {
  const majorVersion = header[3] ?? 0;
  if (majorVersion !== 2 && majorVersion !== 3 && majorVersion !== 4) {
    throw new UnsupportedId3v2VersionError(
      `ID3v2 major version ${majorVersion} is not supported; expected 2, 3, or 4`,
    );
  }
  return majorVersion;
}

function validateHeaderFlags(majorVersion: Id3v2MajorVersion, flags: number): void {
  if (majorVersion === 2) {
    if ((flags & 0x3f) !== 0) {
      throw new EncodedSourceIntegrityError('ID3v2.2 header uses reserved flag bits');
    }
    return;
  }

  const reservedMask = majorVersion === 3 ? 0x1f : 0x0f;
  if ((flags & reservedMask) !== 0) {
    throw new EncodedSourceIntegrityError(`ID3v2.${majorVersion} header uses reserved flag bits`);
  }
}

async function readTrailingTagBoundary(
  source: EncodedAudioSource,
  sourceBytes: number,
  endOffset: number,
  signal: AbortSignal,
): Promise<Id3v2TagBoundary | null> {
  if (endOffset < ID3V2_FOOTER_BYTES) return null;

  const footerOffset = endOffset - ID3V2_FOOTER_BYTES;
  const footer = await readExact(source, sourceBytes, footerOffset, ID3V2_FOOTER_BYTES, signal);
  if (!matchesMarker(footer, '3DI')) return null;

  const majorVersion = footer[3] ?? 0;
  if (majorVersion !== 4) {
    throw new EncodedSourceIntegrityError(
      `Appended ID3v2 footer uses major version ${majorVersion}; only ID3v2.4 defines footers`,
    );
  }
  const revision = footer[4] ?? 0;
  if (revision === 0xff) {
    throw new EncodedSourceIntegrityError('ID3v2 revision must not be 255');
  }
  const flags = footer[5] ?? 0;
  validateHeaderFlags(majorVersion, flags);
  if ((flags & 0x10) === 0) {
    throw new EncodedSourceIntegrityError(
      'Appended ID3v2.4 footer must declare the footer-present flag',
    );
  }

  const bodyBytes = readSyncsafeSize(footer);
  const tagBytes = safeAdd(
    safeAdd(ID3V2_HEADER_BYTES, bodyBytes, 'Appended ID3v2 tag size'),
    ID3V2_FOOTER_BYTES,
    'Appended ID3v2 tag size',
  );
  const headerOffset = endOffset - tagBytes;
  if (!Number.isSafeInteger(headerOffset) || headerOffset < 0) {
    throw new EncodedSourceIntegrityError('Appended ID3v2.4 tag boundary exceeds the audio region');
  }

  const header = await readExact(source, sourceBytes, headerOffset, ID3V2_HEADER_BYTES, signal);
  if (!matchesMarker(header, 'ID3')) {
    throw new EncodedSourceIntegrityError(
      'Appended ID3v2.4 footer does not point to an exact preceding ID3 header',
    );
  }
  for (let index = 3; index < ID3V2_HEADER_BYTES; index += 1) {
    if (header[index] !== footer[index]) {
      throw new EncodedSourceIntegrityError(
        'Appended ID3v2.4 footer version, flags, and size must mirror its header',
      );
    }
  }

  const bodyOffset = safeAdd(headerOffset, ID3V2_HEADER_BYTES, 'Appended ID3v2 body offset');
  if (safeAdd(bodyOffset, bodyBytes, 'Appended ID3v2 body end') !== footerOffset) {
    throw new EncodedSourceIntegrityError('Appended ID3v2.4 tag has inconsistent boundaries');
  }

  return Object.freeze({
    headerOffset,
    bodyOffset,
    bodyBytes,
    footerOffset,
    endOffset,
    majorVersion,
    revision,
    flags,
  });
}

async function readLeadingHeader(
  source: EncodedAudioSource,
  sourceBytes: number,
  offset: number,
  audioEnd: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const remaining = audioEnd - offset;
  if (remaining < 3) return null;

  const length = Math.min(ID3V2_HEADER_BYTES, remaining);
  const header = await readExact(source, sourceBytes, offset, length, signal);
  if (!matchesMarker(header, 'ID3')) return null;
  if (length !== ID3V2_HEADER_BYTES) {
    throw new EncodedSourceIntegrityError('Claimed ID3v2 tag is shorter than its 10-byte header');
  }
  return header;
}

async function readLeadingTagBoundary(
  source: EncodedAudioSource,
  sourceBytes: number,
  headerOffset: number,
  audioEnd: number,
  header: Uint8Array,
  signal: AbortSignal,
): Promise<Id3v2TagBoundary> {
  const majorVersion = readMajorVersion(header);
  const revision = header[4] ?? 0;
  if (revision === 0xff) {
    throw new EncodedSourceIntegrityError('ID3v2 revision must not be 255');
  }
  const flags = header[5] ?? 0;
  validateHeaderFlags(majorVersion, flags);

  const bodyBytes = readSyncsafeSize(header);
  const bodyOffset = safeAdd(headerOffset, ID3V2_HEADER_BYTES, 'ID3v2 body offset');
  const bodyEnd = safeAdd(bodyOffset, bodyBytes, 'ID3v2 body end');
  const hasFooter = majorVersion === 4 && (flags & 0x10) !== 0;
  const endOffset = safeAdd(bodyEnd, hasFooter ? ID3V2_FOOTER_BYTES : 0, 'ID3v2 tag end');
  if (endOffset > audioEnd) {
    throw new EncodedSourceIntegrityError(
      'ID3v2 tag boundary exceeds the source audio region or overlaps trailing metadata',
    );
  }

  const footerOffset = hasFooter ? bodyEnd : null;
  if (footerOffset !== null) {
    const footer = await readExact(source, sourceBytes, footerOffset, ID3V2_FOOTER_BYTES, signal);
    if (!matchesMarker(footer, '3DI')) {
      throw new EncodedSourceIntegrityError(
        'ID3v2.4 footer must begin with the reverse marker 3DI',
      );
    }
    for (let index = 3; index < ID3V2_FOOTER_BYTES; index += 1) {
      if (footer[index] !== header[index]) {
        throw new EncodedSourceIntegrityError(
          'ID3v2.4 footer version, flags, and size must mirror its header',
        );
      }
    }
  }

  return Object.freeze({
    headerOffset,
    bodyOffset,
    bodyBytes,
    footerOffset,
    endOffset,
    majorVersion,
    revision,
    flags,
  });
}

/**
 * Discover MP3 payload boundaries without reading or allocating ID3 bodies.
 *
 * Consecutive leading ID3v2.2, v2.3, and v2.4 tags are skipped, up to a hard
 * limit of eight. A v2.4 size excludes both its 10-byte header and optional
 * 10-byte footer; a present footer is read exactly and must begin with `3DI`
 * while mirroring the header's version, flags, and syncsafe size. Consecutive
 * appended ID3v2.4 tags are discovered backward by their required footers and
 * kept separate from leading tags. A trailing ID3v1 tag is recognized only at
 * its canonical 128-byte-from-end boundary.
 */
export async function readMp3Id3Boundaries(
  source: EncodedAudioSource,
  signal: AbortSignal,
): Promise<ParsedMp3Id3Boundaries> {
  const sourceBytes = source.size;
  validateExactRead(sourceBytes, 0, 0);
  throwIfAborted(signal);

  let trailingId3v1Offset: number | null = null;
  if (sourceBytes >= ID3V1_BYTES) {
    const candidateOffset = sourceBytes - ID3V1_BYTES;
    const marker = await readExact(
      source,
      sourceBytes,
      candidateOffset,
      ID3V1_MARKER_BYTES,
      signal,
    );
    if (matchesMarker(marker, 'TAG')) trailingId3v1Offset = candidateOffset;
  }
  let audioEnd = trailingId3v1Offset ?? sourceBytes;

  const reverseTrailingTags: Id3v2TagBoundary[] = [];
  while (audioEnd > 0) {
    throwIfAborted(signal);
    const boundary = await readTrailingTagBoundary(source, sourceBytes, audioEnd, signal);
    if (!boundary) break;
    if (reverseTrailingTags.length >= MP3_MAX_TRAILING_ID3V2_TAGS) {
      throw new EncodedSourceIntegrityError(
        `MP3 has more than ${MP3_MAX_TRAILING_ID3V2_TAGS} consecutive appended ID3v2.4 tags`,
      );
    }
    reverseTrailingTags.push(boundary);
    audioEnd = boundary.headerOffset;
  }

  const leadingTags: Id3v2TagBoundary[] = [];
  let dataStart = 0;
  while (dataStart < audioEnd) {
    throwIfAborted(signal);
    const header = await readLeadingHeader(source, sourceBytes, dataStart, audioEnd, signal);
    if (!header) break;
    if (leadingTags.length >= MP3_MAX_LEADING_ID3V2_TAGS) {
      throw new EncodedSourceIntegrityError(
        `MP3 has more than ${MP3_MAX_LEADING_ID3V2_TAGS} consecutive leading ID3v2 tags`,
      );
    }
    const boundary = await readLeadingTagBoundary(
      source,
      sourceBytes,
      dataStart,
      audioEnd,
      header,
      signal,
    );
    leadingTags.push(boundary);
    dataStart = boundary.endOffset;
  }

  throwIfAborted(signal);
  const frozenTags = Object.freeze(leadingTags.slice());
  const frozenTrailingTags = Object.freeze(reverseTrailingTags.slice().reverse());
  return Object.freeze({
    sourceBytes,
    dataStart,
    audioEnd,
    leadingTagCount: frozenTags.length,
    leadingTags: frozenTags,
    trailingTagCount: frozenTrailingTags.length,
    trailingTags: frozenTrailingTags,
    hasTrailingId3v1: trailingId3v1Offset !== null,
    trailingId3v1Offset,
  });
}
