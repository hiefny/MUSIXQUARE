import { describe, expect, it } from 'vitest';

import { IsoBmffBoxError, parseIsoBmffBoxHeader, requiredIsoBmffBoxHeaderBytes } from '../box.ts';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function writeType(bytes: Uint8Array, type: string): void {
  if (type.length !== 4) throw new Error('Fixture type must contain four characters');
  for (let index = 0; index < 4; index += 1) {
    bytes[4 + index] = type.charCodeAt(index);
  }
}

function standardHeader(type: string, size: number): Uint8Array {
  const headerBytes = type === 'uuid' ? 24 : 8;
  const bytes = new Uint8Array(headerBytes);
  new DataView(bytes.buffer).setUint32(0, size, false);
  writeType(bytes, type);
  if (type === 'uuid') {
    for (let index = 0; index < 16; index += 1) bytes[8 + index] = index + 1;
  }
  return bytes;
}

function largeHeader(type: string, size: bigint): Uint8Array {
  const headerBytes = type === 'uuid' ? 32 : 16;
  const bytes = new Uint8Array(headerBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, false);
  writeType(bytes, type);
  view.setBigUint64(8, size, false);
  if (type === 'uuid') {
    for (let index = 0; index < 16; index += 1) bytes[16 + index] = 0xf0 + index;
  }
  return bytes;
}

function sizeZeroHeader(type: string): Uint8Array {
  return standardHeader(type, 0);
}

const ROOT = Object.freeze({ parentStart: 0, parentEnd: 1_000, start: 100 });

describe('ISO BMFF box header parser', () => {
  it('returns one frozen canonical reference for an ordinary box', () => {
    const ref = parseIsoBmffBoxHeader(standardHeader('moov', 40), ROOT);

    expect(ref).toEqual({
      type: 'moov',
      start: 100,
      size: 40,
      headerBytes: 8,
      dataStart: 108,
      end: 140,
      extendsToEnd: false,
    });
    expect(Object.keys(ref)).toEqual([
      'type',
      'start',
      'size',
      'headerBytes',
      'dataStart',
      'end',
      'extendsToEnd',
    ]);
    expect(Object.isFrozen(ref)).toBe(true);
  });

  it('parses a multi-gibibyte large-size box with safe BigInt conversion', () => {
    const size = 5 * 1_024 * 1_024 * 1_024;
    const ref = parseIsoBmffBoxHeader(largeHeader('mdat', BigInt(size)), {
      parentStart: 0,
      parentEnd: size + 32,
      start: 0,
    });

    expect(ref).toMatchObject({
      type: 'mdat',
      size,
      headerBytes: 16,
      dataStart: 16,
      end: size,
      extendsToEnd: false,
    });
  });

  it('accounts exactly for standard and large uuid user types', () => {
    expect(requiredIsoBmffBoxHeaderBytes(standardHeader('uuid', 24).slice(0, 8))).toBe(24);
    expect(requiredIsoBmffBoxHeaderBytes(largeHeader('uuid', 32n).slice(0, 8))).toBe(32);

    expect(parseIsoBmffBoxHeader(standardHeader('uuid', 28), ROOT)).toMatchObject({
      type: 'uuid',
      headerBytes: 24,
      dataStart: 124,
      end: 128,
    });
    expect(parseIsoBmffBoxHeader(largeHeader('uuid', 40n), ROOT)).toMatchObject({
      type: 'uuid',
      headerBytes: 32,
      dataStart: 132,
      end: 140,
    });
  });

  it('requires explicit permission for size-zero and extends it exactly to the parent end', () => {
    expect(() => parseIsoBmffBoxHeader(sizeZeroHeader('mdat'), ROOT)).toThrow(
      /size-zero box is not allowed/,
    );

    const ref = parseIsoBmffBoxHeader(sizeZeroHeader('mdat'), {
      ...ROOT,
      allowExtendsToEnd: true,
    });
    expect(ref).toEqual({
      type: 'mdat',
      start: 100,
      size: 900,
      headerBytes: 8,
      dataStart: 108,
      end: 1_000,
      extendsToEnd: true,
    });
  });

  it.each([
    ['ordinary box smaller than its header', standardHeader('free', 7), /smaller than its 8-byte/],
    ['large box smaller than its header', largeHeader('free', 15n), /smaller than its 16-byte/],
    ['uuid box smaller than its header', standardHeader('uuid', 23), /smaller than its 24-byte/],
    ['large uuid smaller than its header', largeHeader('uuid', 31n), /smaller than its 32-byte/],
  ])('rejects an undersized %s', (_name, header, message) => {
    expect(() => parseIsoBmffBoxHeader(header, ROOT)).toThrow(message);
  });

  it('rejects unsafe 64-bit sizes before converting them to Number', () => {
    expect(() => parseIsoBmffBoxHeader(largeHeader('mdat', MAX_SAFE_BIGINT + 1n), ROOT)).toThrow(
      /safe-integer range/,
    );
  });

  it('rejects safe operands whose absolute box end would overflow', () => {
    const start = Number.MAX_SAFE_INTEGER - 4;
    expect(() =>
      parseIsoBmffBoxHeader(standardHeader('free', 8), {
        parentStart: 0,
        parentEnd: Number.MAX_SAFE_INTEGER,
        start,
      }),
    ).toThrow(/box end exceeds the browser safe-integer range/);
  });

  it('rejects parent escape, inverted bounds, and starts outside the parent', () => {
    expect(() =>
      parseIsoBmffBoxHeader(standardHeader('free', 80), {
        parentStart: 100,
        parentEnd: 150,
        start: 100,
      }),
    ).toThrow(/escapes its parent/);
    expect(() =>
      parseIsoBmffBoxHeader(standardHeader('free', 8), {
        parentStart: 200,
        parentEnd: 100,
        start: 150,
      }),
    ).toThrow(/inverted boundary/);
    expect(() =>
      parseIsoBmffBoxHeader(standardHeader('free', 8), {
        parentStart: 100,
        parentEnd: 200,
        start: 99,
      }),
    ).toThrow(/outside its parent/);
  });

  it('rejects truncated, overlong, shared, and non-byte header snapshots', () => {
    expect(() => requiredIsoBmffBoxHeaderBytes(new Uint8Array(7))).toThrow(/invalid bounded/);
    expect(() => parseIsoBmffBoxHeader(largeHeader('mdat', 16n).slice(0, 8), ROOT)).toThrow(
      /expected 16/,
    );
    expect(() =>
      parseIsoBmffBoxHeader(Uint8Array.from([...standardHeader('free', 8), 0, 0, 0, 0]), ROOT),
    ).toThrow(/expected 8/);
    expect(() =>
      parseIsoBmffBoxHeader(new DataView(new ArrayBuffer(8)) as unknown as Uint8Array, ROOT),
    ).toThrow(IsoBmffBoxError);

    const shared = new Uint8Array(new SharedArrayBuffer(8));
    shared.set(standardHeader('free', 8));
    expect(() => parseIsoBmffBoxHeader(shared, ROOT)).toThrow(/non-shared/);
  });
});
