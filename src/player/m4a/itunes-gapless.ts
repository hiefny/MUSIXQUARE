import { type IsoBmffBoxRef } from '../mp4/box.ts';
import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import type { M4aAacITunEvidence } from './timeline.ts';

export const M4A_ITUN_SMPB_MAX_TEXT_CHARACTERS = 256;
export const M4A_ITUN_SMPB_MAX_CUSTOM_ITEMS = 128;
export const M4A_ITUN_SMPB_MAX_FIELD_BODY_BYTES = 4 * 1_024;

const META_FULL_BOX_PREFIX_BYTES = 4;
const HDLR_FIXED_PREFIX_BYTES = 24;
const CUSTOM_FULL_BOX_PREFIX_BYTES = 4;
const DATA_TYPE_AND_LOCALE_BYTES = 8;
const MIN_DATA_BODY_BYTES = DATA_TYPE_AND_LOCALE_BYTES + 1;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const ITUNES_MEAN = 'com.apple.iTunes';
const ITUNES_NAME = 'iTunSMPB';
const ITUNES_HANDLER_TYPE = 'mdir';
const ITUNES_HANDLER_MANUFACTURER = 'appl';

const TextDecoderIntrinsic = TextDecoder;
const textDecoderDecode = TextDecoderIntrinsic.prototype.decode;

/** Authenticated iTunSMPB evidence accepted by the M4A AAC timeline normalizer. */
export type M4aITunSmpbEvidence = M4aAacITunEvidence;

export class M4aITunSmpbError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aITunSmpbError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function tokenizeBoundedAscii(text: unknown): readonly string[] {
  if (typeof text !== 'string') {
    throw new TypeError('M4A iTunSMPB metadata must be a string');
  }
  if (text.length === 0 || text.length > M4A_ITUN_SMPB_MAX_TEXT_CHARACTERS) {
    throw new M4aITunSmpbError(
      `M4A iTunSMPB text must contain 1 through ${M4A_ITUN_SMPB_MAX_TEXT_CHARACTERS} ASCII characters`,
    );
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      throw new M4aITunSmpbError('M4A iTunSMPB text must contain ASCII only');
    }
  }

  let start = 0;
  let end = text.length;
  while (start < end && isAsciiWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && isAsciiWhitespace(text.charCodeAt(end - 1))) end -= 1;
  if (start === end) {
    throw new M4aITunSmpbError('M4A iTunSMPB text is empty after outer whitespace');
  }

  const fields: string[] = [];
  let offset = start;
  while (offset < end) {
    const fieldStart = offset;
    while (offset < end && !isAsciiWhitespace(text.charCodeAt(offset))) offset += 1;
    fields.push(text.slice(fieldStart, offset));
    if (offset === end) break;
    while (offset < end && isAsciiWhitespace(text.charCodeAt(offset))) offset += 1;
  }
  return fields;
}

function isExactHexField(value: string, width: 8 | 16): boolean {
  if (value.length !== width) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isUpper = code >= 0x41 && code <= 0x46;
    const isLower = code >= 0x61 && code <= 0x66;
    if (!isDigit && !isUpper && !isLower) return false;
  }
  return true;
}

function parseSafeHexField(value: string, width: 8 | 16, label: string): number {
  if (!isExactHexField(value, width)) {
    throw new M4aITunSmpbError(
      `M4A iTunSMPB ${label} must contain exactly ${width} hexadecimal digits`,
    );
  }
  const parsed = BigInt(`0x${value}`);
  if (parsed > MAX_SAFE_BIGINT) {
    throw new M4aITunSmpbError(`M4A iTunSMPB ${label} exceeds the browser safe-integer range`);
  }
  return Number(parsed);
}

/** Parse the bounded ASCII form written by Apple's `iTunSMPB` custom item. */
export function parseM4aITunSmpbText(text: string): Readonly<M4aITunSmpbEvidence> {
  const fields = tokenizeBoundedAscii(text);
  if (fields.length < 4) {
    throw new M4aITunSmpbError('M4A iTunSMPB text must contain at least four hexadecimal fields');
  }

  const unknown = parseSafeHexField(fields[0]!, 8, 'reserved field');
  if (unknown !== 0) {
    throw new M4aITunSmpbError('M4A iTunSMPB reserved field must be zero');
  }
  const primingCoreFrames = parseSafeHexField(fields[1]!, 8, 'priming field');
  const remainderCoreFrames = parseSafeHexField(fields[2]!, 8, 'remainder field');
  const audibleCoreFrames = parseSafeHexField(fields[3]!, 16, 'audible-length field');
  if (audibleCoreFrames === 0) {
    throw new M4aITunSmpbError('M4A iTunSMPB audible length must be positive');
  }

  for (let index = 4; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!isExactHexField(field, 8) && !isExactHexField(field, 16)) {
      throw new M4aITunSmpbError(
        'M4A iTunSMPB trailing fields must contain exactly 8 or 16 hexadecimal digits',
      );
    }
  }

  return Object.freeze({ primingCoreFrames, remainderCoreFrames, audibleCoreFrames });
}

function decodeUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    const decoder = new TextDecoderIntrinsic('utf-8', { fatal: true, ignoreBOM: true });
    return Reflect.apply(textDecoderDecode, decoder, [bytes]);
  } catch {
    return null;
  }
}

function isZeroFullBoxPrefix(bytes: Uint8Array): boolean {
  return bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
}

function readFourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function isAllZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) return false;
  }
  return true;
}

/**
 * Accept both ISO-style zero reserved fields and the QuickTime/iTunes
 * manufacturer `appl`. This parser is deliberately local to metadata:
 * media-track `hdlr` boxes retain their stricter ISO parser.
 */
function isSupportedITunesMetadataHandlerPrefix(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== HDLR_FIXED_PREFIX_BYTES) return false;
  if (!isZeroFullBoxPrefix(bytes) || !isAllZero(bytes, 4, 8)) return false;
  if (readFourCc(bytes, 8) !== ITUNES_HANDLER_TYPE) return false;

  const manufacturer = readFourCc(bytes, 12);
  if (manufacturer !== '\0\0\0\0' && manufacturer !== ITUNES_HANDLER_MANUFACTURER) {
    return false;
  }
  return isAllZero(bytes, 16, HDLR_FIXED_PREFIX_BYTES);
}

type CustomItemResult =
  | Readonly<{ status: 'unrelated' }>
  | Readonly<{ status: 'invalid-target' }>
  | Readonly<{ status: 'valid'; evidence: Readonly<M4aITunSmpbEvidence> }>;

const UNRELATED_CUSTOM_ITEM: CustomItemResult = Object.freeze({ status: 'unrelated' });
const INVALID_CUSTOM_ITEM: CustomItemResult = Object.freeze({ status: 'invalid-target' });

type MetaScanResult =
  | Readonly<{ status: 'unrelated' }>
  | Readonly<{ status: 'invalid-target' }>
  | Readonly<{ status: 'valid'; evidence: Readonly<M4aITunSmpbEvidence> }>;

const UNRELATED_META: MetaScanResult = Object.freeze({ status: 'unrelated' });
const INVALID_META: MetaScanResult = Object.freeze({ status: 'invalid-target' });

async function readCustomString(
  reader: IsoBmffBoxReader,
  box: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<string | null> {
  const bodyBytes = box.end - box.dataStart;
  if (bodyBytes > M4A_ITUN_SMPB_MAX_FIELD_BODY_BYTES) return null;
  if (bodyBytes < CUSTOM_FULL_BOX_PREFIX_BYTES) return null;
  const bytes = await reader.readBytes(box.dataStart, bodyBytes, signal);
  if (!isZeroFullBoxPrefix(bytes)) return null;
  return decodeUtf8OrNull(bytes.subarray(CUSTOM_FULL_BOX_PREFIX_BYTES));
}

async function readCustomItem(
  reader: IsoBmffBoxReader,
  item: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<CustomItemResult> {
  const children = reader.createChildCursor(item);
  const meanBoxes: Readonly<IsoBmffBoxRef>[] = [];
  const nameBoxes: Readonly<IsoBmffBoxRef>[] = [];
  const dataBoxes: Readonly<IsoBmffBoxRef>[] = [];

  for (;;) {
    const child = await children.next(signal);
    if (child === null) break;
    if (child.type === 'mean') {
      meanBoxes.push(child);
    } else if (child.type === 'name') {
      nameBoxes.push(child);
    } else if (child.type === 'data') {
      dataBoxes.push(child);
    }
    // Unknown custom-item children are skipped by their validated box end.
  }

  // Without one unambiguous namespace and key this is merely an unrelated or
  // unsupported freeform item. In particular, do not let a multi-value tag
  // from a metadata editor affect audio admission.
  if (meanBoxes.length !== 1 || nameBoxes.length !== 1) return UNRELATED_CUSTOM_ITEM;

  // Resolve the namespace and key before touching data. In particular, a
  // large unrelated custom value never becomes a physical source-body read.
  const decodedMean = await readCustomString(reader, meanBoxes[0]!, signal);
  if (decodedMean !== ITUNES_MEAN) return UNRELATED_CUSTOM_ITEM;
  const decodedName = await readCustomString(reader, nameBoxes[0]!, signal);
  if (decodedName !== ITUNES_NAME) return UNRELATED_CUSTOM_ITEM;

  // A matching key with zero or multiple values is ambiguous. Its bodies are
  // not read, and the complete optional record is discarded by the caller.
  if (dataBoxes.length !== 1) return INVALID_CUSTOM_ITEM;
  const data = dataBoxes[0]!;

  const bodyBytes = data.end - data.dataStart;
  if (bodyBytes < MIN_DATA_BODY_BYTES || bodyBytes > M4A_ITUN_SMPB_MAX_FIELD_BODY_BYTES) {
    return INVALID_CUSTOM_ITEM;
  }
  const bytes = await reader.readBytes(data.dataStart, bodyBytes, signal);
  if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 1) {
    return INVALID_CUSTOM_ITEM;
  }
  if (bytes[4] !== 0 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    return INVALID_CUSTOM_ITEM;
  }
  const text = decodeUtf8OrNull(bytes.subarray(DATA_TYPE_AND_LOCALE_BYTES));
  if (text === null) return INVALID_CUSTOM_ITEM;
  try {
    return Object.freeze({ status: 'valid', evidence: parseM4aITunSmpbText(text) });
  } catch (error) {
    if (error instanceof M4aITunSmpbError) return INVALID_CUSTOM_ITEM;
    throw error;
  }
}

async function scanITunesMeta(
  reader: IsoBmffBoxReader,
  meta: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<MetaScanResult> {
  if (meta.end - meta.dataStart < META_FULL_BOX_PREFIX_BYTES) return UNRELATED_META;
  const metaPrefix = await reader.readBytes(meta.dataStart, META_FULL_BOX_PREFIX_BYTES, signal);
  if (!isZeroFullBoxPrefix(metaPrefix)) return UNRELATED_META;

  const metaChildren = reader.createChildCursor(meta, {
    start: meta.dataStart + META_FULL_BOX_PREFIX_BYTES,
    end: meta.end,
  });
  const handlers: Readonly<IsoBmffBoxRef>[] = [];
  const itemLists: Readonly<IsoBmffBoxRef>[] = [];
  for (;;) {
    const child = await metaChildren.next(signal);
    if (child === null) break;
    if (child.type === 'hdlr') handlers.push(child);
    else if (child.type === 'ilst') itemLists.push(child);
    // `keys`, `free`, and future metadata children are optional and skipped
    // by their already-validated box end without reading their bodies.
  }

  if (handlers.length !== 1 || itemLists.length !== 1) return UNRELATED_META;
  const handler = handlers[0]!;
  if (handler.end - handler.dataStart < HDLR_FIXED_PREFIX_BYTES) return UNRELATED_META;
  const handlerPrefix = await reader.readBytes(handler.dataStart, HDLR_FIXED_PREFIX_BYTES, signal);
  if (!isSupportedITunesMetadataHandlerPrefix(handlerPrefix)) return UNRELATED_META;

  const items = reader.createChildCursor(itemLists[0]!);
  let customItemCount = 0;
  let evidence: Readonly<M4aITunSmpbEvidence> | null = null;
  let invalidTarget = false;
  for (;;) {
    const item = await items.next(signal);
    if (item === null) break;
    if (item.type !== '----') continue;
    customItemCount += 1;
    if (customItemCount > M4A_ITUN_SMPB_MAX_CUSTOM_ITEMS) return INVALID_META;

    const candidate = await readCustomItem(reader, item, signal);
    if (candidate.status === 'unrelated') continue;
    if (candidate.status === 'invalid-target') {
      invalidTarget = true;
      continue;
    }
    if (evidence !== null) {
      invalidTarget = true;
      continue;
    }
    evidence = candidate.evidence;
  }

  if (invalidTarget) return INVALID_META;
  return evidence === null ? UNRELATED_META : Object.freeze({ status: 'valid', evidence });
}

/**
 * Read one bounded iTunes gapless record from `moov/udta/meta/ilst`.
 *
 * The reader and encoded source remain caller-owned. Non-iTunes item bodies,
 * including cover art, are skipped without being read or retained.
 */
export async function readM4aITunSmpb(
  reader: IsoBmffBoxReader,
  udtaRef: Readonly<IsoBmffBoxRef> | null,
  signal: AbortSignal,
): Promise<Readonly<M4aITunSmpbEvidence> | null> {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A iTunSMPB metadata requires an IsoBmffBoxReader');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A iTunSMPB metadata requires an AbortSignal');
  }
  reader.assertReadable(signal);
  if (udtaRef === null) return null;

  const udtaChildren = reader.createChildCursor(udtaRef);
  if (udtaRef.type !== 'udta') {
    throw new M4aITunSmpbError('M4A iTunSMPB metadata parent must be a udta box');
  }

  const metadataBoxes: Readonly<IsoBmffBoxRef>[] = [];
  for (;;) {
    const child = await udtaChildren.next(signal);
    if (child === null) break;
    if (child.type !== 'meta') continue;
    metadataBoxes.push(child);
  }
  if (metadataBoxes.length === 0) {
    reader.assertReadable(signal);
    return null;
  }

  let evidence: Readonly<M4aITunSmpbEvidence> | null = null;
  let invalidTarget = false;
  for (const meta of metadataBoxes) {
    const candidate = await scanITunesMeta(reader, meta, signal);
    if (candidate.status === 'unrelated') continue;
    if (candidate.status === 'invalid-target') {
      invalidTarget = true;
      continue;
    }
    if (evidence !== null) {
      invalidTarget = true;
      continue;
    }
    evidence = candidate.evidence;
  }

  reader.assertReadable(signal);
  return invalidTarget ? null : evidence;
}
