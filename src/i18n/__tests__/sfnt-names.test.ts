/**
 * The name-table helper of the Hangul face generator
 * (scripts/fonts/sfnt-names.mts): it reads a font's name records, renames
 * text in them, and writes the font again in tag order with every checksum
 * computed. Renaming must change the name table and nothing else.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { sfntChecksumsValid, sfntTables } from '../../../scripts/fonts/app-face-metrics.mts';
import { decodeFontBytes, openFontBytes } from '../../../scripts/fonts/font-files.mts';
import {
  encodeNameTable,
  nameText,
  readNameTable,
  renameRecords,
  withNameRecords,
  writeSfnt,
  type SfntNameRecord,
} from '../../../scripts/fonts/sfnt-names.mts';

const ROOT = resolve('.');
const SOURCE = 'fonts/PretendardVariable.woff2';

let source: Uint8Array;

/** The font renamed the way the Hangul face generator renames its subsets. */
function renamed(sfnt: Uint8Array, replacements: readonly (readonly [string, string])[]) {
  return withNameRecords(sfnt, renameRecords(readNameTable(sfnt).records, replacements));
}

beforeAll(async () => {
  source = Uint8Array.from(await decodeFontBytes(await readFile(join(ROOT, SOURCE))));
}, 30_000);

function tableBytes(sfnt: Uint8Array): Map<string, string> {
  return new Map(
    [...sfntTables(sfnt)].map(([tag, { offset, length }]) => [
      tag,
      Buffer.from(sfnt.subarray(offset, offset + length)).toString('hex'),
    ]),
  );
}

const texts = (records: readonly SfntNameRecord[], nameId: number): (string | null)[] =>
  records.filter((record) => record.nameId === nameId).map(nameText);

describe('sfnt name tables', () => {
  it('reads every record of the Pretendard source, in both its languages', () => {
    const table = readNameTable(source);
    expect(table.format).toBe(0);
    expect(table.records).toHaveLength(167);
    expect(texts(table.records, 1)).toEqual(['Pretendard Variable']);
    expect(texts(table.records, 6)).toEqual(['PretendardVariable-Regular']);
    expect(texts(table.records, 5)).toEqual(['Version 1.309;Glyphs 3.2 (3225)']);
    expect(texts(table.records, 0)).toEqual([
      'Copyright © 2023 Kil Hyung-jin',
      'Copyright © 2023 길형진',
    ]);
    // Macintosh records (feature names) are read as ASCII.
    expect(
      table.records.find((record) => record.platformId === 1 && record.nameId === 277),
    ).toSatisfy((record: SfntNameRecord) => nameText(record) === 'Korean localization');
  });

  it('encodes a table that reads back to the same records', () => {
    const table = readNameTable(source);
    const encoded = encodeNameTable(table);
    const again = readNameTable(writeSfnt(source, new Map([['name', encoded]])));
    expect(again.records.map((record) => [record.nameId, nameText(record)])).toEqual(
      table.records.map((record) => [record.nameId, nameText(record)]),
    );
    // Records with the same bytes share one string, as in the source.
    const { offset, length } = sfntTables(source).get('name')!;
    expect(Buffer.from(encoded).toString('hex')).toBe(
      Buffer.from(source.subarray(offset, offset + length)).toString('hex'),
    );
  });

  it('round-trips format 1 with its language tags', () => {
    const utf16 = (text: string): Uint8Array =>
      Uint8Array.from(Buffer.from(text, 'utf16le').swap16());
    const table = {
      format: 1 as const,
      records: [
        { platformId: 3, encodingId: 1, languageId: 0x8000, nameId: 1, bytes: utf16('Family') },
        { platformId: 3, encodingId: 1, languageId: 0x0409, nameId: 2, bytes: utf16('Regular') },
      ],
      languageTags: [utf16('ko-KR')],
    };
    const again = readNameTable(writeSfnt(source, new Map([['name', encodeNameTable(table)]])));
    expect(again.format).toBe(1);
    expect(again.records.map(nameText)).toEqual(['Family', 'Regular']);
    expect(again.languageTags.map((tag) => Buffer.from(tag).swap16().toString('utf16le'))).toEqual([
      'ko-KR',
    ]);
  });

  it('writes the font again with every table as it was and valid checksums', () => {
    const written = writeSfnt(source, new Map());
    expect(sfntChecksumsValid(written)).toBe(true);
    const before = tableBytes(source);
    const after = tableBytes(written);
    // head differs only in checkSumAdjustment, which writeSfnt computes again.
    const strip = (hex: string | undefined) => `${hex?.slice(0, 16)}${hex?.slice(24)}`;
    expect(strip(after.get('head'))).toBe(strip(before.get('head')));
    before.delete('head');
    after.delete('head');
    expect(after).toEqual(before);
    // Tables in tag order, four-byte aligned.
    const records = [...sfntTables(written)];
    expect(records.map(([tag]) => tag)).toEqual(records.map(([tag]) => tag).sort());
    expect(records.every(([, { offset }]) => offset % 4 === 0)).toBe(true);
  });

  it('renames text in every record and changes nothing else', async () => {
    const font = renamed(source, [
      ['Pretendard Variable', 'MUSIXQUARE Hangul'],
      ['PretendardVariable', 'MUSIXQUAREHangul'],
    ]);
    expect(sfntChecksumsValid(font)).toBe(true);
    const { records } = readNameTable(font);
    expect(texts(records, 1)).toEqual(['MUSIXQUARE Hangul']);
    expect(texts(records, 3)).toEqual(['1.309;CTUS;MUSIXQUAREHangul']);
    expect(texts(records, 6)).toEqual(['MUSIXQUAREHangul-Regular']);
    expect(texts(records, 258)).toEqual(['MUSIXQUAREHangul-Thin']);
    // The trademark notice (ID 7) names the font as prose and keeps it.
    expect(texts(records, 7)[0]).toMatch(/^Pretendard is a trademark/u);
    expect(texts(records, 0)).toEqual(texts(readNameTable(source).records, 0));
    const before = tableBytes(source);
    const after = tableBytes(font);
    for (const tag of ['name', 'head']) {
      before.delete(tag);
      after.delete(tag);
    }
    expect(after).toEqual(before);
    const face = await openFontBytes(font);
    expect(face.getName(1, 'en')).toBe('MUSIXQUARE Hangul');
    expect(face.getName(4, 'en')).toBe('MUSIXQUARE Hangul');
  });

  it('writes a chosen set of records in the order the name table requires', () => {
    const { records } = readNameTable(source);
    const chosen = records.filter(({ nameId }) => [0, 1, 2, 6].includes(nameId)).reverse();
    const written = withNameRecords(source, chosen);
    expect(sfntChecksumsValid(written)).toBe(true);
    const again = readNameTable(written);
    expect(again.format).toBe(0);
    expect(again.records.map((record) => [record.languageId, record.nameId])).toEqual([
      [0x409, 0],
      [0x409, 1],
      [0x409, 2],
      [0x409, 6],
      [0x412, 0],
    ]);
  });

  it('refuses text a Macintosh record cannot hold', () => {
    expect(() => renamed(source, [['Korean localization', '한국어 형태']])).toThrow(
      /cannot hold non-ASCII text/u,
    );
  });
});
