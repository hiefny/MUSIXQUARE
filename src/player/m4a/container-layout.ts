import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import type { IsoBmffBoxRef } from '../mp4/box.ts';

export const M4A_FTYP_MIN_BODY_BYTES = 8;
export const M4A_FTYP_MAX_BODY_BYTES = 4 * 1_024;
export const M4A_MAX_MDAT_BOXES = 64;

const FRAGMENTED_OR_SEGMENTED_BOX_TYPES = new Set(['moof', 'mfra', 'sidx', 'styp']);

export interface M4aMediaDataRange {
  readonly start: number;
  readonly end: number;
}

export interface M4aContainerLayout {
  readonly majorBrand: string;
  readonly minorVersion: number;
  readonly compatibleBrands: readonly string[];
  /** Exact provenance-bearing reference issued by the supplied reader. */
  readonly moov: Readonly<IsoBmffBoxRef>;
  readonly mediaDataRanges: readonly Readonly<M4aMediaDataRange>[];
  readonly ignoredTopLevelBoxCount: number;
}

const containerLayoutAuthorities = new WeakMap<object, IsoBmffBoxReader>();

export class M4aContainerLayoutError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aContainerLayoutError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function readFourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function parseFileTypeBody(bytes: Uint8Array): Readonly<{
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: readonly string[];
}> {
  if (bytes.byteLength < M4A_FTYP_MIN_BODY_BYTES || bytes.byteLength > M4A_FTYP_MAX_BODY_BYTES) {
    throw new M4aContainerLayoutError(
      `M4A ftyp body must contain ${M4A_FTYP_MIN_BODY_BYTES} through ${M4A_FTYP_MAX_BODY_BYTES} bytes`,
    );
  }
  if ((bytes.byteLength - M4A_FTYP_MIN_BODY_BYTES) % 4 !== 0) {
    throw new M4aContainerLayoutError(
      'M4A ftyp compatible-brand bytes are not a whole number of four-character codes',
    );
  }

  const majorBrand = readFourCc(bytes, 0);
  const minorVersion = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    4,
    false,
  );
  const compatibleBrands: string[] = [];
  for (let offset = 8; offset < bytes.byteLength; offset += 4) {
    compatibleBrands.push(readFourCc(bytes, offset));
  }
  return Object.freeze({
    majorBrand,
    minorVersion,
    compatibleBrands: Object.freeze(compatibleBrands),
  });
}

/**
 * Traverse the complete top-level ISO BMFF box sequence and retain only the
 * bounded metadata needed to start a later M4A `moov` manifest parse.
 *
 * The supplied reader and its encoded source remain caller-owned. Only the
 * `ftyp` body is read; `mdat` and ignored box bodies are skipped by their exact
 * validated ends. The returned `moov` object is the same reference issued by
 * the reader, preserving its child-cursor provenance.
 */
export async function readM4aContainerLayout(
  reader: IsoBmffBoxReader,
  signal: AbortSignal,
): Promise<Readonly<M4aContainerLayout>> {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A container layout requires an ISO BMFF box reader');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A container layout requires an AbortSignal');
  }

  const cursor = reader.createCursor({ allowExtendsToEnd: true });
  let fileType: ReturnType<typeof parseFileTypeBody> | null = null;
  let moov: Readonly<IsoBmffBoxRef> | null = null;
  const mediaDataRanges: Readonly<M4aMediaDataRange>[] = [];
  let ignoredTopLevelBoxCount = 0;
  let encounteredMovieOrMediaData = false;

  for (;;) {
    const box = await cursor.next(signal);
    if (box === null) break;

    if (FRAGMENTED_OR_SEGMENTED_BOX_TYPES.has(box.type)) {
      throw new M4aContainerLayoutError(
        `M4A fragmented or segmented top-level box ${JSON.stringify(box.type)} is not supported`,
      );
    }

    if (box.extendsToEnd && box.type !== 'mdat') {
      throw new M4aContainerLayoutError(
        `M4A size-zero top-level box ${JSON.stringify(box.type)} is not allowed`,
      );
    }

    if (box.type === 'ftyp') {
      if (fileType !== null) {
        throw new M4aContainerLayoutError('M4A contains more than one top-level ftyp box');
      }
      if (encounteredMovieOrMediaData) {
        throw new M4aContainerLayoutError('M4A ftyp must precede the first moov or mdat box');
      }
      const bodyBytes = box.end - box.dataStart;
      if (bodyBytes < M4A_FTYP_MIN_BODY_BYTES || bodyBytes > M4A_FTYP_MAX_BODY_BYTES) {
        throw new M4aContainerLayoutError(
          `M4A ftyp body must contain ${M4A_FTYP_MIN_BODY_BYTES} through ${M4A_FTYP_MAX_BODY_BYTES} bytes`,
        );
      }
      fileType = parseFileTypeBody(await reader.readBytes(box.dataStart, bodyBytes, signal));
      continue;
    }

    if (box.type === 'moov') {
      encounteredMovieOrMediaData = true;
      if (moov !== null) {
        throw new M4aContainerLayoutError('M4A contains more than one top-level moov box');
      }
      moov = box;
      continue;
    }

    if (box.type === 'mdat') {
      encounteredMovieOrMediaData = true;
      if (mediaDataRanges.length >= M4A_MAX_MDAT_BOXES) {
        throw new M4aContainerLayoutError(
          `M4A contains more than ${M4A_MAX_MDAT_BOXES} top-level mdat boxes`,
        );
      }
      if (box.extendsToEnd && box.end !== reader.sourceSize) {
        throw new M4aContainerLayoutError('M4A size-zero mdat is not the terminal top-level box');
      }
      mediaDataRanges.push(Object.freeze({ start: box.dataStart, end: box.end }));
      continue;
    }

    // Unknown and padding boxes are deliberately ignored only after the exact
    // header parser has proved their complete top-level extent. A size-zero
    // unknown was rejected above so it cannot hide later structure.
    ignoredTopLevelBoxCount += 1;
  }

  if (fileType === null) {
    throw new M4aContainerLayoutError('M4A top-level ftyp box is missing');
  }
  if (moov === null) {
    throw new M4aContainerLayoutError('M4A top-level moov box is missing');
  }
  if (mediaDataRanges.length === 0) {
    throw new M4aContainerLayoutError('M4A top-level mdat box is missing');
  }
  if (!mediaDataRanges.some((range) => range.end > range.start)) {
    throw new M4aContainerLayoutError('M4A has no non-empty media-data payload');
  }

  reader.assertReadable(signal);
  const result = Object.freeze({
    majorBrand: fileType.majorBrand,
    minorVersion: fileType.minorVersion,
    compatibleBrands: fileType.compatibleBrands,
    moov,
    mediaDataRanges: Object.freeze(mediaDataRanges),
    ignoredTopLevelBoxCount,
  });
  containerLayoutAuthorities.set(result, reader);
  return result;
}

/**
 * Recover only the exact immutable layout issued for this source reader.
 * Callers cannot manufacture trusted `mdat` ranges by cloning public fields.
 */
export function assertM4aContainerLayoutProvenance(
  reader: IsoBmffBoxReader,
  layout: Readonly<M4aContainerLayout>,
  signal: AbortSignal,
): Readonly<M4aContainerLayout> {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A container-layout provenance requires an ISO BMFF box reader');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A container-layout provenance requires an AbortSignal');
  }
  reader.assertReadable(signal);
  const authority =
    layout !== null && (typeof layout === 'object' || typeof layout === 'function')
      ? containerLayoutAuthorities.get(layout)
      : undefined;
  if (authority === undefined) {
    throw new M4aContainerLayoutError('M4A container layout lacks module provenance');
  }
  if (authority !== reader) {
    throw new M4aContainerLayoutError('M4A container layout belongs to a different source reader');
  }
  return layout;
}
