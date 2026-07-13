import { parseMpegLayer3FrameHeader, type MpegLayer3FrameHeader } from './frame-header.ts';

const XING_KNOWN_FLAGS = 0x0f;
const XING_FRAMES_FLAG = 0x01;
const XING_BYTES_FLAG = 0x02;
const XING_TOC_FLAG = 0x04;
const XING_QUALITY_FLAG = 0x08;
const XING_TOC_ENTRIES = 100;
const XING_MAX_QUALITY = 100;
const VBRI_MAX_QUALITY = 100;
const VBRI_OFFSET = 36 as const;
const VBRI_FIXED_BYTES = 26;

export type XingIdentifier = 'Xing' | 'Info';
export type LameEncoderFamily = 'LAME' | 'L3.99' | 'Lavf' | 'Lavc';
export type VbriTocEntryBytes = 1 | 2 | 3 | 4;

export interface Mp3GaplessMetadata {
  readonly encoderFamily: LameEncoderFamily;
  /** The exact printable nine-byte encoder field following the Xing payload. */
  readonly encoderTag: string;
  /** Raw 12-bit encoder delay. Decoder-specific delay is deliberately excluded. */
  readonly encoderDelaySamples: number;
  /** Raw 12-bit end padding. */
  readonly endPaddingSamples: number;
}

export interface Mp3XingMetadata {
  readonly kind: 'xing';
  readonly identifier: XingIdentifier;
  readonly headerOffset: number;
  readonly flags: number;
  readonly frameCount: number | null;
  readonly streamBytes: number | null;
  readonly toc: readonly number[] | null;
  readonly quality: number | null;
  /**
   * Present only when a recognized encoder tag and a declared frame count make
   * both trim values structurally provable. Otherwise playback stays untrimmed.
   */
  readonly gapless: Mp3GaplessMetadata | null;
}

export interface Mp3VbriMetadata {
  readonly kind: 'vbri';
  readonly identifier: 'VBRI';
  readonly headerOffset: typeof VBRI_OFFSET;
  readonly version: 1;
  /** Raw 16-bit VBRI delay field; this is not LAME gapless trim metadata. */
  readonly delay: number;
  readonly quality: number;
  readonly streamBytes: number;
  readonly frameCount: number;
  readonly tocEntryCount: number;
  readonly tocScale: number;
  readonly tocEntryBytes: VbriTocEntryBytes;
  readonly framesPerEntry: number;
  /** Raw big-endian TOC values; multiply each value by `tocScale` for bytes. */
  readonly tocEntries: readonly number[];
}

export type Mp3FirstFrameVbrMetadata = Mp3XingMetadata | Mp3VbriMetadata;

export class Mp3VbrMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp3VbrMetadataError';
  }
}

function markerAt(bytes: Uint8Array, offset: number, marker: string): boolean {
  if (offset < 0 || offset + marker.length > bytes.byteLength) return false;
  for (let index = 0; index < marker.length; index += 1) {
    if (bytes[offset + index] !== marker.charCodeAt(index)) return false;
  }
  return true;
}

function requireBytes(bytes: Uint8Array, offset: number, length: number, label: string): number {
  const end = offset + length;
  if (!Number.isSafeInteger(end) || offset < 0 || length < 0 || end > bytes.byteLength) {
    throw new Mp3VbrMetadataError(`${label} is truncated in the first MPEG frame`);
  }
  return end;
}

function readUint16(bytes: Uint8Array, offset: number, label: string): number {
  requireBytes(bytes, offset, 2, label);
  return (bytes[offset] ?? 0) * 0x100 + (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number, label: string): number {
  requireBytes(bytes, offset, 4, label);
  return (
    (bytes[offset] ?? 0) * 0x1_00_00_00 +
    (bytes[offset + 1] ?? 0) * 0x1_00_00 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  );
}

function readVariableUint(
  bytes: Uint8Array,
  offset: number,
  length: VbriTocEntryBytes,
  label: string,
): number {
  requireBytes(bytes, offset, length, label);
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 0x100 + (bytes[offset + index] ?? 0);
  }
  return value;
}

function sameParsedHeader(expected: MpegLayer3FrameHeader, actual: MpegLayer3FrameHeader): boolean {
  return (
    expected.version === actual.version &&
    expected.layer === actual.layer &&
    expected.bitrateIndex === actual.bitrateIndex &&
    expected.bitrateKbps === actual.bitrateKbps &&
    expected.sampleRateIndex === actual.sampleRateIndex &&
    expected.sampleRateHz === actual.sampleRateHz &&
    expected.channelMode === actual.channelMode &&
    expected.channelCount === actual.channelCount &&
    expected.samplesPerFrame === actual.samplesPerFrame &&
    expected.hasCrc === actual.hasCrc &&
    expected.padding === actual.padding &&
    expected.frameLengthBytes === actual.frameLengthBytes &&
    expected.sideInfoBytes === actual.sideInfoBytes &&
    expected.mainDataCapacityBytes === actual.mainDataCapacityBytes
  );
}

function validateInput(
  firstFrame: Uint8Array,
  header: MpegLayer3FrameHeader,
): MpegLayer3FrameHeader {
  if (!(firstFrame instanceof Uint8Array)) {
    throw new TypeError('MP3 first frame must be a Uint8Array');
  }
  if (firstFrame.byteLength < 4) {
    throw new Mp3VbrMetadataError('MP3 first frame is shorter than its four-byte header');
  }

  const parsed = parseMpegLayer3FrameHeader(firstFrame.subarray(0, 4));
  if (!sameParsedHeader(header, parsed)) {
    throw new Mp3VbrMetadataError('Parsed MPEG header does not match the supplied first frame');
  }
  if (firstFrame.byteLength !== parsed.frameLengthBytes) {
    throw new Mp3VbrMetadataError(
      `MP3 first frame has ${firstFrame.byteLength} bytes; expected exactly ${parsed.frameLengthBytes}`,
    );
  }
  return parsed;
}

function readXingCount(bytes: Uint8Array, offset: number, label: string): number {
  const value = readUint32(bytes, offset, label);
  if (value === 0) throw new Mp3VbrMetadataError(`${label} must be greater than zero`);
  return value;
}

function readXingToc(bytes: Uint8Array, offset: number): readonly number[] {
  requireBytes(bytes, offset, XING_TOC_ENTRIES, 'Xing TOC');
  const toc = Array.from(bytes.subarray(offset, offset + XING_TOC_ENTRIES));
  if (toc[0] !== 0) {
    throw new Mp3VbrMetadataError('Xing TOC must begin at byte fraction zero');
  }
  for (let index = 1; index < toc.length; index += 1) {
    if ((toc[index] ?? 0) < (toc[index - 1] ?? 0)) {
      throw new Mp3VbrMetadataError('Xing TOC byte fractions must be monotonic');
    }
  }
  return Object.freeze(toc);
}

function encoderFamilyAt(bytes: Uint8Array, offset: number): LameEncoderFamily | null {
  if (markerAt(bytes, offset, 'LAME')) return 'LAME';
  if (markerAt(bytes, offset, 'L3.99')) return 'L3.99';
  if (markerAt(bytes, offset, 'Lavf')) return 'Lavf';
  if (markerAt(bytes, offset, 'Lavc')) return 'Lavc';
  return null;
}

function printableEncoderTag(bytes: Uint8Array, offset: number): string | null {
  if (offset + 9 > bytes.byteLength) return null;
  let tag = '';
  for (let index = 0; index < 9; index += 1) {
    const value = bytes[offset + index] ?? 0;
    if (value < 0x20 || value > 0x7e) return null;
    tag += String.fromCharCode(value);
  }
  return tag;
}

function readProvenGapless(
  bytes: Uint8Array,
  encoderOffset: number,
  frameCount: number | null,
  samplesPerFrame: number,
): Mp3GaplessMetadata | null {
  const encoderFamily = encoderFamilyAt(bytes, encoderOffset);
  if (encoderFamily === null || frameCount === null) return null;

  const encoderTag = printableEncoderTag(bytes, encoderOffset);
  const delayOffset = encoderOffset + 21;
  if (encoderTag === null || delayOffset + 3 > bytes.byteLength) return null;
  const tagRevision = (bytes[encoderOffset + 9] ?? 0) >>> 4;
  if (tagRevision !== 0) return null;

  const packed =
    (bytes[delayOffset] ?? 0) * 0x1_00_00 +
    (bytes[delayOffset + 1] ?? 0) * 0x100 +
    (bytes[delayOffset + 2] ?? 0);
  const encoderDelaySamples = Math.floor(packed / 0x1000);
  const endPaddingSamples = packed & 0x0fff;
  const codedSamples = frameCount * samplesPerFrame;
  if (
    !Number.isSafeInteger(codedSamples) ||
    codedSamples <= 0 ||
    encoderDelaySamples === 0x0fff ||
    endPaddingSamples === 0x0fff ||
    encoderDelaySamples + endPaddingSamples >= codedSamples
  ) {
    return null;
  }

  return Object.freeze({
    encoderFamily,
    encoderTag,
    encoderDelaySamples,
    endPaddingSamples,
  });
}

function parseXing(
  bytes: Uint8Array,
  header: MpegLayer3FrameHeader,
  offset: number,
): Mp3XingMetadata {
  const identifier: XingIdentifier = markerAt(bytes, offset, 'Info') ? 'Info' : 'Xing';
  const flags = readUint32(bytes, offset + 4, 'Xing flags');
  if ((flags & ~XING_KNOWN_FLAGS) !== 0) {
    throw new Mp3VbrMetadataError('Xing header uses unknown flag bits');
  }

  let cursor = offset + 8;
  let frameCount: number | null = null;
  let streamBytes: number | null = null;
  let toc: readonly number[] | null = null;
  let quality: number | null = null;

  if ((flags & XING_FRAMES_FLAG) !== 0) {
    frameCount = readXingCount(bytes, cursor, 'Xing frame count');
    cursor += 4;
  }
  if ((flags & XING_BYTES_FLAG) !== 0) {
    streamBytes = readXingCount(bytes, cursor, 'Xing stream byte count');
    if (streamBytes < header.frameLengthBytes) {
      throw new Mp3VbrMetadataError('Xing stream byte count is shorter than its first frame');
    }
    cursor += 4;
  }
  if ((flags & XING_TOC_FLAG) !== 0) {
    toc = readXingToc(bytes, cursor);
    cursor += XING_TOC_ENTRIES;
  }
  if ((flags & XING_QUALITY_FLAG) !== 0) {
    quality = readUint32(bytes, cursor, 'Xing quality');
    if (quality > XING_MAX_QUALITY) {
      throw new Mp3VbrMetadataError(`Xing quality must be between 0 and ${XING_MAX_QUALITY}`);
    }
    cursor += 4;
  }

  return Object.freeze({
    kind: 'xing',
    identifier,
    headerOffset: offset,
    flags,
    frameCount,
    streamBytes,
    toc,
    quality,
    gapless: readProvenGapless(bytes, cursor, frameCount, header.samplesPerFrame),
  });
}

function readVbriEntryBytes(value: number): VbriTocEntryBytes {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new Mp3VbrMetadataError('VBRI TOC entry width must be 1, 2, 3, or 4 bytes');
}

function parseVbri(bytes: Uint8Array, header: MpegLayer3FrameHeader): Mp3VbriMetadata {
  requireBytes(bytes, VBRI_OFFSET, VBRI_FIXED_BYTES, 'VBRI header');
  const version = readUint16(bytes, VBRI_OFFSET + 4, 'VBRI version');
  if (version !== 1) {
    throw new Mp3VbrMetadataError(`VBRI version ${version} is unsupported; expected version 1`);
  }

  const delay = readUint16(bytes, VBRI_OFFSET + 6, 'VBRI delay');
  const quality = readUint16(bytes, VBRI_OFFSET + 8, 'VBRI quality');
  const streamBytes = readUint32(bytes, VBRI_OFFSET + 10, 'VBRI stream byte count');
  const frameCount = readUint32(bytes, VBRI_OFFSET + 14, 'VBRI frame count');
  const tocEntryCount = readUint16(bytes, VBRI_OFFSET + 18, 'VBRI TOC entry count');
  const tocScale = readUint16(bytes, VBRI_OFFSET + 20, 'VBRI TOC scale');
  const tocEntryBytes = readVbriEntryBytes(
    readUint16(bytes, VBRI_OFFSET + 22, 'VBRI TOC entry width'),
  );
  const framesPerEntry = readUint16(bytes, VBRI_OFFSET + 24, 'VBRI frames per TOC entry');

  if (streamBytes < header.frameLengthBytes) {
    throw new Mp3VbrMetadataError('VBRI stream byte count is shorter than its first frame');
  }
  if (quality > VBRI_MAX_QUALITY) {
    throw new Mp3VbrMetadataError(`VBRI quality must be between 0 and ${VBRI_MAX_QUALITY}`);
  }
  if (frameCount === 0) throw new Mp3VbrMetadataError('VBRI frame count must be greater than zero');
  if (tocEntryCount === 0) {
    throw new Mp3VbrMetadataError('VBRI TOC entry count must be greater than zero');
  }
  if (tocScale === 0) throw new Mp3VbrMetadataError('VBRI TOC scale must be greater than zero');
  if (framesPerEntry === 0) {
    throw new Mp3VbrMetadataError('VBRI frames per TOC entry must be greater than zero');
  }

  const coveredFrames = tocEntryCount * framesPerEntry;
  if (
    !Number.isSafeInteger(coveredFrames) ||
    frameCount > coveredFrames ||
    frameCount <= coveredFrames - framesPerEntry
  ) {
    throw new Mp3VbrMetadataError('VBRI TOC frame coverage does not match its frame count');
  }

  const tableOffset = VBRI_OFFSET + VBRI_FIXED_BYTES;
  const tableBytes = tocEntryCount * tocEntryBytes;
  requireBytes(bytes, tableOffset, tableBytes, 'VBRI TOC table');

  const tocEntries: number[] = [];
  let representedBytes = 0;
  for (let index = 0; index < tocEntryCount; index += 1) {
    const rawValue = readVariableUint(
      bytes,
      tableOffset + index * tocEntryBytes,
      tocEntryBytes,
      `VBRI TOC entry ${index}`,
    );
    if (rawValue === 0) {
      throw new Mp3VbrMetadataError(`VBRI TOC entry ${index} must be greater than zero`);
    }
    const entryBytes = rawValue * tocScale;
    representedBytes += entryBytes;
    if (!Number.isSafeInteger(entryBytes) || !Number.isSafeInteger(representedBytes)) {
      throw new Mp3VbrMetadataError('VBRI TOC byte geometry exceeds the safe-integer range');
    }
    if (representedBytes > streamBytes) {
      throw new Mp3VbrMetadataError('VBRI TOC represents more bytes than the declared stream');
    }
    tocEntries.push(rawValue);
  }

  const frozenEntries = Object.freeze(tocEntries.slice());
  return Object.freeze({
    kind: 'vbri',
    identifier: 'VBRI',
    headerOffset: VBRI_OFFSET,
    version: 1,
    delay,
    quality,
    streamBytes,
    frameCount,
    tocEntryCount,
    tocScale,
    tocEntryBytes,
    framesPerEntry,
    tocEntries: frozenEntries,
  });
}

/**
 * Parse optional VBR and gapless metadata from one exact, complete Layer III
 * first frame. No duration is inferred and unproven trim values are omitted.
 */
export function parseMp3FirstFrameVbrMetadata(
  firstFrame: Uint8Array,
  header: MpegLayer3FrameHeader,
): Mp3FirstFrameVbrMetadata | null {
  const parsedHeader = validateInput(firstFrame, header);
  const xingOffset = 4 + (parsedHeader.hasCrc ? 2 : 0) + parsedHeader.sideInfoBytes;
  const hasXing =
    markerAt(firstFrame, xingOffset, 'Xing') || markerAt(firstFrame, xingOffset, 'Info');
  const hasVbri = markerAt(firstFrame, VBRI_OFFSET, 'VBRI');

  if (hasXing && hasVbri) {
    throw new Mp3VbrMetadataError('First MPEG frame contains conflicting Xing and VBRI headers');
  }
  if (hasXing) return parseXing(firstFrame, parsedHeader, xingOffset);
  if (hasVbri) return parseVbri(firstFrame, parsedHeader);
  return null;
}
