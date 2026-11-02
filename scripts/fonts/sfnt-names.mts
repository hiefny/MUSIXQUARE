/**
 * The name table of an sfnt (TrueType or CFF) font: read its records, rename
 * text in them, and write the font again with the new table.
 *
 * scripts/fonts/build-hangul-faces.mts uses it to give its subsets of a
 * font with a Reserved Font Name (SIL OFL 1.1) a name of their own: a
 * Modified Version must not use the Reserved Font Name as its primary font
 * name. The subsetter has no way to override names, so the generator rewrites
 * the records it kept.
 *
 * Supported: name table format 0 and format 1 (with language tags), and the
 * UTF-16BE encodings of the Unicode (0) and Windows (3) platforms. A record of
 * any other encoding (the Macintosh platform's, say) is kept byte for byte and
 * can only be renamed when its bytes are ASCII. writeSfnt lays the tables out
 * in tag order, each on a four-byte boundary with zero padding, and computes
 * every table checksum and head.checkSumAdjustment, so its output is a
 * function of the tables alone.
 */

import { sfntTables } from './app-face-metrics.mts';

export interface SfntNameRecord {
  readonly platformId: number;
  readonly encodingId: number;
  readonly languageId: number;
  readonly nameId: number;
  /** The string's bytes as the table stores them. */
  readonly bytes: Uint8Array;
}

export interface SfntNameTable {
  /** 0, or 1 when the table carries language tags. */
  readonly format: 0 | 1;
  /** The records in table order. */
  readonly records: readonly SfntNameRecord[];
  /** Format 1: the language tags' bytes (UTF-16BE), for language IDs 0x8000 and up. */
  readonly languageTags: readonly Uint8Array[];
}

const CHECKSUM_MAGIC = 0xb1b0afba;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Whether a record's string is UTF-16BE: the Unicode platform and the Windows platform. */
const isUtf16 = (record: Pick<SfntNameRecord, 'platformId'>): boolean =>
  record.platformId === 0 || record.platformId === 3;

const isAscii = (bytes: Uint8Array): boolean => bytes.every((byte) => byte < 0x80);

/** A record's text, or null when its encoding is not one this module reads. */
export function nameText(record: SfntNameRecord): string | null {
  if (isUtf16(record)) {
    if (record.bytes.byteLength % 2 !== 0) return null;
    const view = viewOf(record.bytes);
    const units: number[] = [];
    for (let offset = 0; offset < record.bytes.byteLength; offset += 2) {
      units.push(view.getUint16(offset));
    }
    return String.fromCharCode(...units);
  }
  return isAscii(record.bytes) ? String.fromCharCode(...record.bytes) : null;
}

function encodeText(record: SfntNameRecord, text: string): Uint8Array {
  if (isUtf16(record)) {
    const bytes = new Uint8Array(text.length * 2);
    const view = viewOf(bytes);
    for (let index = 0; index < text.length; index += 1) {
      view.setUint16(index * 2, text.charCodeAt(index));
    }
    return bytes;
  }
  if ([...text].some((character) => (character.codePointAt(0) ?? 0) > 0x7f)) {
    throw new Error(
      `name ID ${record.nameId} (platform ${record.platformId}) cannot hold non-ASCII text`,
    );
  }
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** The name table of an sfnt. Throws unless it is format 0 or 1 and every string lies in it. */
export function readNameTable(sfnt: Uint8Array): SfntNameTable {
  const table = sfntTables(sfnt).get('name');
  if (!table) throw new Error('no name table');
  const bytes = sfnt.subarray(table.offset, table.offset + table.length);
  const view = viewOf(bytes);
  if (bytes.byteLength < 6) throw new Error('the name table is truncated');
  const format = view.getUint16(0);
  if (format !== 0 && format !== 1) throw new Error(`name table format ${format} is not supported`);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  const string = (length: number, offset: number, where: string): Uint8Array => {
    const start = storage + offset;
    if (start + length > bytes.byteLength) throw new Error(`${where} lies outside the name table`);
    return Uint8Array.from(bytes.subarray(start, start + length));
  };
  const records: SfntNameRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 12;
    if (at + 12 > bytes.byteLength) throw new Error('the name records are truncated');
    const nameId = view.getUint16(at + 6);
    records.push({
      platformId: view.getUint16(at),
      encodingId: view.getUint16(at + 2),
      languageId: view.getUint16(at + 4),
      nameId,
      bytes: string(view.getUint16(at + 8), view.getUint16(at + 10), `name ID ${nameId}`),
    });
  }
  const languageTags: Uint8Array[] = [];
  if (format === 1) {
    const at = 6 + count * 12;
    const tagCount = view.getUint16(at);
    for (let index = 0; index < tagCount; index += 1) {
      const record = at + 2 + index * 4;
      languageTags.push(
        string(view.getUint16(record), view.getUint16(record + 2), `language tag ${index}`),
      );
    }
  }
  return { format, records, languageTags };
}

/**
 * A name table's bytes: the records in the order given, each string stored
 * once (records with the same bytes share it), in record order, then the
 * language tags.
 */
export function encodeNameTable(table: SfntNameTable): Uint8Array {
  const { format, records, languageTags } = table;
  if (format === 0 && languageTags.length) throw new Error('format 0 carries no language tags');
  const header = 6 + records.length * 12 + (format === 1 ? 2 + languageTags.length * 4 : 0);
  const pieces: Uint8Array[] = [];
  const offsets = new Map<string, number>();
  let storageLength = 0;
  const place = (bytes: Uint8Array): number => {
    const key = Buffer.from(bytes).toString('hex');
    const known = offsets.get(key);
    if (known !== undefined) return known;
    const offset = storageLength;
    offsets.set(key, offset);
    pieces.push(bytes);
    storageLength += bytes.byteLength;
    return offset;
  };
  const recordOffsets = records.map((record) => place(record.bytes));
  const tagOffsets = languageTags.map((tag) => place(tag));
  if (header > 0xffff || storageLength > 0xffff) throw new Error('the name strings exceed 64 KiB');
  const out = new Uint8Array(header + storageLength);
  const view = viewOf(out);
  view.setUint16(0, format);
  view.setUint16(2, records.length);
  view.setUint16(4, header);
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    view.setUint16(at, record.platformId);
    view.setUint16(at + 2, record.encodingId);
    view.setUint16(at + 4, record.languageId);
    view.setUint16(at + 6, record.nameId);
    view.setUint16(at + 8, record.bytes.byteLength);
    view.setUint16(at + 10, recordOffsets[index] ?? 0);
  });
  if (format === 1) {
    const at = 6 + records.length * 12;
    view.setUint16(at, languageTags.length);
    languageTags.forEach((tag, index) => {
      view.setUint16(at + 2 + index * 4, tag.byteLength);
      view.setUint16(at + 4 + index * 4, tagOffsets[index] ?? 0);
    });
  }
  let position = header;
  for (const piece of pieces) {
    out.set(piece, position);
    position += piece.byteLength;
  }
  return out;
}

/** The sum of big-endian 32-bit words, the last word padded with zeros. */
function wordSum(bytes: Uint8Array): number {
  const view = viewOf(bytes);
  let sum = 0;
  for (let position = 0; position < bytes.byteLength; position += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte += 1) {
      word = word * 256 + (position + byte < bytes.byteLength ? view.getUint8(position + byte) : 0);
    }
    sum = (sum + word) % 0x100000000;
  }
  return sum;
}

/**
 * The font with the given tables replaced (or added), laid out again in tag
 * order with every checksum and head.checkSumAdjustment computed.
 */
export function writeSfnt(sfnt: Uint8Array, replaced: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tables = new Map<string, Uint8Array>();
  for (const [tag, record] of sfntTables(sfnt)) {
    tables.set(tag, Uint8Array.from(sfnt.subarray(record.offset, record.offset + record.length)));
  }
  for (const [tag, bytes] of replaced) {
    if (!/^[\x20-\x7e]{4}$/u.test(tag)) throw new Error(`"${tag}" is not a table tag`);
    tables.set(tag, Uint8Array.from(bytes));
  }
  const tags = [...tables.keys()].sort();
  const head = tables.get('head');
  if (head && head.byteLength >= 12) viewOf(head).setUint32(8, 0);

  const count = tags.length;
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 ** entrySelector * 16;
  const directoryLength = 12 + count * 16;
  const padded = (length: number): number => (length + 3) & ~3;
  const total = tags.reduce(
    (sum, tag) => sum + padded(tables.get(tag)?.byteLength ?? 0),
    directoryLength,
  );
  const out = new Uint8Array(total);
  const view = viewOf(out);
  view.setUint32(0, viewOf(sfnt).getUint32(0));
  view.setUint16(4, count);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, count * 16 - searchRange);
  let offset = directoryLength;
  let headOffset = -1;
  tags.forEach((tag, index) => {
    const bytes = tables.get(tag) ?? new Uint8Array();
    const record = 12 + index * 16;
    for (let byte = 0; byte < 4; byte += 1) view.setUint8(record + byte, tag.charCodeAt(byte));
    view.setUint32(record + 4, wordSum(bytes));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, bytes.byteLength);
    out.set(bytes, offset);
    if (tag === 'head') headOffset = offset;
    offset += padded(bytes.byteLength);
  });
  if (headOffset >= 0) {
    view.setUint32(headOffset + 8, (CHECKSUM_MAGIC - wordSum(out) + 0x100000000) % 0x100000000);
  }
  return out;
}

/**
 * The records with every replacement applied, in order, to their text (each
 * `from` replaced wherever it occurs). A record whose text this module cannot
 * read is kept as it is, and so must not contain any `from` as ASCII bytes.
 */
export function renameRecords(
  records: readonly SfntNameRecord[],
  replacements: readonly (readonly [from: string, to: string])[],
): SfntNameRecord[] {
  return records.map((record) => {
    const text = nameText(record);
    if (text === null) {
      const raw = Buffer.from(record.bytes).toString('latin1');
      for (const [from] of replacements) {
        if (raw.includes(from)) {
          throw new Error(`name ID ${record.nameId} holds "${from}" in an unreadable encoding`);
        }
      }
      return record;
    }
    let renamed = text;
    for (const [from, to] of replacements) renamed = renamed.split(from).join(to);
    return renamed === text ? record : { ...record, bytes: encodeText(record, renamed) };
  });
}

/** The order the name table requires: platform, encoding, language, then name ID. */
function compareNameRecords(left: SfntNameRecord, right: SfntNameRecord): number {
  return (
    left.platformId - right.platformId ||
    left.encodingId - right.encodingId ||
    left.languageId - right.languageId ||
    left.nameId - right.nameId
  );
}

/** The font with its name table replaced by these records, sorted, as format 0. */
export function withNameRecords(sfnt: Uint8Array, records: readonly SfntNameRecord[]): Uint8Array {
  const sorted = [...records].sort(compareNameRecords);
  return writeSfnt(
    sfnt,
    new Map([['name', encodeNameTable({ format: 0, records: sorted, languageTags: [] })]]),
  );
}
