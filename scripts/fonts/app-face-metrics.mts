/**
 * The vertical metrics of an sfnt (TrueType or CFF) font, and the patch that
 * bakes a line box into them (scripts/fonts/build-app-faces.mts).
 *
 * Browsers draw a line-height: normal line from a face's ascent, descent and
 * line gap. With USE_TYPO_METRICS (OS/2 fsSelection bit 7) set, every current
 * engine takes them from the OS/2 typo metrics (DirectWrite, FreeType,
 * HarfBuzz, Fontations); CoreText takes them from hhea. The patch writes the
 * same box into both and sets the bit, so every engine reads one box. It
 * leaves the win metrics (usWinAscent, usWinDescent), which only GDI uses for
 * line spacing and some renderers to clip glyphs, and every other byte, so the
 * outlines, advances, cmap and layout tables stay as they were. The table
 * checksums and head.checkSumAdjustment are computed again.
 *
 * Descenders are positive here, as the distance below the baseline; the
 * tables store hhea.descender and sTypoDescender negated.
 */

/** A line box in font units. */
export interface LineBox {
  readonly ascender: number;
  /** The distance below the baseline, positive. */
  readonly descender: number;
  readonly lineGap: number;
}

/** The line box to bake, for files of one units-per-em. */
export interface BakedLineBox extends LineBox {
  readonly unitsPerEm: number;
}

export interface SfntLineMetrics {
  readonly unitsPerEm: number;
  readonly hhea: LineBox;
  readonly typo: LineBox;
  /** OS/2 fsSelection bit 7. */
  readonly useTypoMetrics: boolean;
  readonly winAscent: number;
  readonly winDescent: number;
}

/** MVAR value tags that would vary the typo or win metrics across a variable font's instances. */
export const LINE_METRIC_MVAR_TAGS: readonly string[] = ['hasc', 'hdsc', 'hlgp', 'hcla', 'hcld'];

/** The sfnt versions: TrueType outlines, 'true' and CFF ('OTTO'). */
const SFNT_VERSIONS = new Set([0x00010000, 0x74727565, 0x4f54544f]);
const USE_TYPO_METRICS = 0x80;
const CHECKSUM_MAGIC = 0xb1b0afba;

interface TableRecord {
  /** Offset of the table's directory record. */
  readonly record: number;
  readonly offset: number;
  readonly length: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The table directory of an sfnt, by tag. Throws unless the bytes are one. */
export function sfntTables(sfnt: Uint8Array): Map<string, TableRecord> {
  if (sfnt.byteLength < 12 || !SFNT_VERSIONS.has(viewOf(sfnt).getUint32(0))) {
    throw new Error('not an sfnt font (TrueType or CFF): decode WOFF2 first');
  }
  const view = viewOf(sfnt);
  const count = view.getUint16(4);
  if (12 + count * 16 > sfnt.byteLength) throw new Error('the sfnt table directory is truncated');
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...sfnt.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > sfnt.byteLength) throw new Error(`the ${tag} table is truncated`);
    tables.set(tag, { record, offset, length });
  }
  return tables;
}

function requireTable(
  tables: ReadonlyMap<string, TableRecord>,
  tag: string,
  minimumLength: number,
): TableRecord {
  const table = tables.get(tag);
  if (!table) throw new Error(`no ${tag} table`);
  if (table.length < minimumLength) {
    throw new Error(`the ${tag} table is ${table.length} bytes, shorter than ${minimumLength}`);
  }
  return table;
}

/** The sum of big-endian 32-bit words of a byte range, the last word padded with zeros. */
function wordSum(view: DataView, offset: number, length: number): number {
  let sum = 0;
  const end = offset + length;
  for (let position = offset; position < end; position += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte += 1) {
      word = word * 256 + (position + byte < end ? view.getUint8(position + byte) : 0);
    }
    sum = (sum + word) % 0x100000000;
  }
  return sum;
}

/** A table's checksum, with head.checkSumAdjustment counted as zero. */
function tableChecksum(view: DataView, tag: string, table: TableRecord): number {
  const sum = wordSum(view, table.offset, table.length);
  if (tag !== 'head' || table.length < 12) return sum;
  return (sum - view.getUint32(table.offset + 8) + 0x100000000) % 0x100000000;
}

/** The value tags of the face's MVAR table, if it has one. */
function mvarTags(sfnt: Uint8Array, tables: ReadonlyMap<string, TableRecord>): string[] {
  const mvar = tables.get('MVAR');
  if (!mvar) return [];
  const view = viewOf(sfnt);
  const size = view.getUint16(mvar.offset + 6);
  const count = view.getUint16(mvar.offset + 8);
  return Array.from({ length: count }, (_, index) => {
    const start = mvar.offset + 12 + index * size;
    return String.fromCharCode(...sfnt.subarray(start, start + 4));
  });
}

export function readLineMetrics(sfnt: Uint8Array): SfntLineMetrics {
  const tables = sfntTables(sfnt);
  const view = viewOf(sfnt);
  const head = requireTable(tables, 'head', 54);
  const hhea = requireTable(tables, 'hhea', 36);
  const os2 = requireTable(tables, 'OS/2', 78);
  return {
    unitsPerEm: view.getUint16(head.offset + 18),
    hhea: {
      ascender: view.getInt16(hhea.offset + 4),
      descender: -view.getInt16(hhea.offset + 6),
      lineGap: view.getInt16(hhea.offset + 8),
    },
    typo: {
      ascender: view.getInt16(os2.offset + 68),
      descender: -view.getInt16(os2.offset + 70),
      lineGap: view.getInt16(os2.offset + 72),
    },
    useTypoMetrics: (view.getUint16(os2.offset + 62) & USE_TYPO_METRICS) !== 0,
    winAscent: view.getUint16(os2.offset + 74),
    winDescent: view.getUint16(os2.offset + 76),
  };
}

/** Whether every table checksum and head.checkSumAdjustment are right. */
export function sfntChecksumsValid(sfnt: Uint8Array): boolean {
  const tables = sfntTables(sfnt);
  const view = viewOf(sfnt);
  for (const [tag, table] of tables) {
    if (view.getUint32(table.record + 4) !== tableChecksum(view, tag, table)) return false;
  }
  return wordSum(view, 0, sfnt.byteLength) === CHECKSUM_MAGIC;
}

/**
 * A copy of the font with the box in hhea and the OS/2 typo metrics,
 * USE_TYPO_METRICS set, and its checksums computed again. It refuses a face
 * the patch would not describe exactly: a units-per-em other than the box's,
 * an OS/2 table older than version 4 (the bit is defined from version 4), or
 * an MVAR table that varies the typo or win metrics.
 */
export function bakeLineMetrics(sfnt: Uint8Array, box: BakedLineBox): Uint8Array {
  const tables = sfntTables(sfnt);
  const head = requireTable(tables, 'head', 54);
  const hhea = requireTable(tables, 'hhea', 36);
  const os2 = requireTable(tables, 'OS/2', 78);
  const baked = Uint8Array.from(sfnt);
  const view = viewOf(baked);

  const unitsPerEm = view.getUint16(head.offset + 18);
  if (unitsPerEm !== box.unitsPerEm) {
    throw new Error(`the face has unitsPerEm ${unitsPerEm}, the box is for ${box.unitsPerEm}`);
  }
  const os2Version = view.getUint16(os2.offset);
  if (os2Version < 4) {
    throw new Error(`OS/2 version ${os2Version} has no USE_TYPO_METRICS bit; version 4 or later`);
  }
  const varied = mvarTags(sfnt, tables).filter((tag) => LINE_METRIC_MVAR_TAGS.includes(tag));
  if (varied.length) throw new Error(`MVAR varies ${varied.join(', ')} across instances`);
  for (const [name, value] of Object.entries({
    ascender: box.ascender,
    descender: box.descender,
    lineGap: box.lineGap,
  })) {
    if (!Number.isInteger(value) || value < 0 || value > 0x7fff) {
      throw new Error(`${name} ${value} is not a font unit count`);
    }
  }

  view.setInt16(hhea.offset + 4, box.ascender);
  view.setInt16(hhea.offset + 6, -box.descender);
  view.setInt16(hhea.offset + 8, box.lineGap);
  view.setUint16(os2.offset + 62, view.getUint16(os2.offset + 62) | USE_TYPO_METRICS);
  view.setInt16(os2.offset + 68, box.ascender);
  view.setInt16(os2.offset + 70, -box.descender);
  view.setInt16(os2.offset + 72, box.lineGap);

  view.setUint32(head.offset + 8, 0);
  for (const [tag, table] of tables) {
    view.setUint32(table.record + 4, tableChecksum(view, tag, table));
  }
  const sum = wordSum(view, 0, baked.byteLength);
  view.setUint32(head.offset + 8, (CHECKSUM_MAGIC - sum + 0x100000000) % 0x100000000);
  return baked;
}

/**
 * Where two fonts with the same tables differ outside the bytes the patch
 * writes: tables added, removed or resized, and the first other byte of each
 * changed table. Empty when the only differences are the patched fields,
 * head.checkSumAdjustment and the table checksums.
 */
export function unpatchedDifferences(before: Uint8Array, after: Uint8Array): string[] {
  const left = sfntTables(before);
  const right = sfntTables(after);
  const patched: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
    head: [[8, 12]],
    hhea: [[4, 10]],
    'OS/2': [
      [62, 64],
      [68, 74],
    ],
  };
  const found: string[] = [];
  for (const tag of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(tag);
    const b = right.get(tag);
    if (!a || !b || a.length !== b.length) {
      found.push(`${tag} added, removed or resized`);
      continue;
    }
    const ranges = patched[tag] ?? [];
    for (let index = 0; index < a.length; index += 1) {
      if (before[a.offset + index] === after[b.offset + index]) continue;
      if (ranges.some(([start, end]) => index >= start && index < end)) continue;
      found.push(`${tag} byte ${index}`);
      break;
    }
  }
  return found;
}
