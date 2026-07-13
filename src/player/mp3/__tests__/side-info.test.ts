import { describe, expect, it } from 'vitest';

import { parseMpegLayer3FrameHeader, type MpegLayer3FrameHeader } from '../frame-header.ts';
import { Mp3SideInfoError, parseMpegLayer3MainDataBegin } from '../side-info.ts';

interface HeaderOptions {
  readonly versionBits?: 0 | 2 | 3;
  readonly protectionBit?: 0 | 1;
  readonly channelModeBits?: 0 | 1 | 2 | 3;
}

function makeHeaderBytes(options: HeaderOptions = {}): Uint8Array {
  const versionBits = options.versionBits ?? 3;
  const protectionBit = options.protectionBit ?? 1;
  const channelModeBits = options.channelModeBits ?? 0;
  return Uint8Array.of(
    0xff,
    0xe0 | (versionBits << 3) | (1 << 1) | protectionBit,
    9 << 4,
    channelModeBits << 6,
  );
}

function makeFramePrefix(
  headerBytes: Uint8Array,
  mainDataBegin: number,
  complete = false,
): { readonly header: MpegLayer3FrameHeader; readonly bytes: Uint8Array } {
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const sideInfoOffset = 4 + (header.hasCrc ? 2 : 0);
  const requiredBytes = header.version === '1' ? 2 : 1;
  const bytes = new Uint8Array(complete ? header.frameLengthBytes : sideInfoOffset + requiredBytes);
  bytes.set(headerBytes);
  if (header.hasCrc) {
    bytes[4] = 0xa5;
    bytes[5] = 0x5a;
  }
  if (header.version === '1') {
    bytes[sideInfoOffset] = mainDataBegin >>> 1;
    bytes[sideInfoOffset + 1] = (mainDataBegin & 1) << 7;
  } else {
    bytes[sideInfoOffset] = mainDataBegin;
  }
  return { header, bytes };
}

describe('MPEG Layer III side-info parser', () => {
  it('reads both boundary values for every version, channel mode, and CRC layout', () => {
    for (const versionBits of [3, 2, 0] as const) {
      for (const channelModeBits of [0, 1, 2, 3] as const) {
        for (const protectionBit of [0, 1] as const) {
          const maximum = versionBits === 3 ? 511 : 255;
          for (const mainDataBegin of [0, maximum]) {
            const fixture = makeFramePrefix(
              makeHeaderBytes({ versionBits, channelModeBits, protectionBit }),
              mainDataBegin,
            );
            expect(parseMpegLayer3MainDataBegin(fixture.bytes, fixture.header)).toBe(mainDataBegin);
          }
        }
      }
    }
  });

  it('uses all nine MPEG-1 bits without interpreting the remaining side-info', () => {
    const fixture = makeFramePrefix(makeHeaderBytes(), 0x101);
    const sideInfoOffset = 4;
    fixture.bytes[sideInfoOffset + 1] |= 0x7f;

    expect(parseMpegLayer3MainDataBegin(fixture.bytes, fixture.header)).toBe(0x101);
  });

  it('uses the first eight side-info bits for MPEG-2 and MPEG-2.5', () => {
    for (const versionBits of [2, 0] as const) {
      const fixture = makeFramePrefix(makeHeaderBytes({ versionBits }), 0x80, true);
      const sideInfoOffset = 4;
      fixture.bytes[sideInfoOffset + 1] = 0xff;

      expect(parseMpegLayer3MainDataBegin(fixture.bytes, fixture.header)).toBe(0x80);
    }
  });

  it('accepts both the minimum bounded prefix and a complete frame', () => {
    const minimum = makeFramePrefix(
      makeHeaderBytes({ versionBits: 3, protectionBit: 0, channelModeBits: 1 }),
      347,
    );
    const complete = makeFramePrefix(
      makeHeaderBytes({ versionBits: 3, protectionBit: 0, channelModeBits: 1 }),
      347,
      true,
    );

    expect(parseMpegLayer3MainDataBegin(minimum.bytes, minimum.header)).toBe(347);
    expect(parseMpegLayer3MainDataBegin(complete.bytes, complete.header)).toBe(347);
  });

  it('accounts for both CRC bytes before reading side-info', () => {
    const fixture = makeFramePrefix(makeHeaderBytes({ versionBits: 2, protectionBit: 0 }), 173);

    expect(fixture.bytes.subarray(4, 6)).toEqual(Uint8Array.of(0xa5, 0x5a));
    expect(parseMpegLayer3MainDataBegin(fixture.bytes, fixture.header)).toBe(173);
  });

  it('rejects truncation before every byte required by main_data_begin', () => {
    for (const versionBits of [3, 2, 0] as const) {
      for (const protectionBit of [0, 1] as const) {
        const fixture = makeFramePrefix(
          makeHeaderBytes({ versionBits, protectionBit }),
          versionBits === 3 ? 511 : 255,
        );
        const truncated = fixture.bytes.subarray(0, fixture.bytes.byteLength - 1);

        expect(() => parseMpegLayer3MainDataBegin(truncated, fixture.header)).toThrowError(
          Mp3SideInfoError,
        );
        expect(() => parseMpegLayer3MainDataBegin(truncated, fixture.header)).toThrow(/truncates/);
      }
    }
  });

  it('rejects a parsed header that differs from the supplied header', () => {
    const fixture = makeFramePrefix(makeHeaderBytes(), 0);
    const otherHeader = parseMpegLayer3FrameHeader(makeHeaderBytes({ channelModeBits: 3 }));

    expect(() => parseMpegLayer3MainDataBegin(fixture.bytes, otherHeader)).toThrow(
      /does not match/,
    );

    const forgedHeader = {
      ...fixture.header,
      mainDataCapacityBytes: fixture.header.mainDataCapacityBytes - 1,
    };
    expect(() => parseMpegLayer3MainDataBegin(fixture.bytes, forgedHeader)).toThrow(
      /does not match/,
    );
  });

  it('rejects an input that extends beyond one declared frame', () => {
    const fixture = makeFramePrefix(makeHeaderBytes(), 0, true);
    const oversized = new Uint8Array(fixture.bytes.byteLength + 1);
    oversized.set(fixture.bytes);

    expect(() => parseMpegLayer3MainDataBegin(oversized, fixture.header)).toThrow(
      /beyond its declared frame boundary/,
    );
  });

  it('rejects invalid input types, short headers, and malformed frame headers', () => {
    const header = parseMpegLayer3FrameHeader(makeHeaderBytes());
    expect(() => parseMpegLayer3MainDataBegin(null as unknown as Uint8Array, header)).toThrow(
      TypeError,
    );
    expect(() => parseMpegLayer3MainDataBegin(new Uint8Array(3), header)).toThrowError(
      Mp3SideInfoError,
    );

    const malformed = new Uint8Array(6);
    expect(() => parseMpegLayer3MainDataBegin(malformed, header)).toThrow(/sync/);
  });
});
