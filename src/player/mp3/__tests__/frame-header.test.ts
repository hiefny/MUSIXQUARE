import { describe, expect, it } from 'vitest';

import {
  MpegLayer3FrameHeaderError,
  parseMpegLayer3FrameHeader,
  type MpegLayer3ChannelMode,
  type MpegLayer3Version,
} from '../frame-header.ts';

interface HeaderOptions {
  readonly versionBits?: 0 | 1 | 2 | 3;
  readonly layerBits?: 0 | 1 | 2 | 3;
  readonly protectionBit?: 0 | 1;
  readonly bitrateIndex?: number;
  readonly sampleRateIndex?: 0 | 1 | 2 | 3;
  readonly paddingBit?: 0 | 1;
  readonly channelModeBits?: 0 | 1 | 2 | 3;
  readonly emphasisBits?: 0 | 1 | 2 | 3;
}

function makeHeader(options: HeaderOptions = {}): Uint8Array {
  const versionBits = options.versionBits ?? 3;
  const layerBits = options.layerBits ?? 1;
  const protectionBit = options.protectionBit ?? 1;
  const bitrateIndex = options.bitrateIndex ?? 9;
  const sampleRateIndex = options.sampleRateIndex ?? 0;
  const paddingBit = options.paddingBit ?? 0;
  const channelModeBits = options.channelModeBits ?? 0;
  const emphasisBits = options.emphasisBits ?? 0;
  return Uint8Array.of(
    0xff,
    0xe0 | (versionBits << 3) | (layerBits << 1) | protectionBit,
    (bitrateIndex << 4) | (sampleRateIndex << 2) | (paddingBit << 1),
    (channelModeBits << 6) | emphasisBits,
  );
}

describe('MPEG Layer III frame header parser', () => {
  it('parses a canonical MPEG-1 joint-stereo header', () => {
    const header = parseMpegLayer3FrameHeader(
      makeHeader({ bitrateIndex: 9, sampleRateIndex: 0, channelModeBits: 1 }),
    );

    expect(header).toEqual({
      version: '1',
      layer: 3,
      bitrateIndex: 9,
      bitrateKbps: 128,
      sampleRateIndex: 0,
      sampleRateHz: 44_100,
      channelMode: 'joint-stereo',
      channelCount: 2,
      samplesPerFrame: 1_152,
      hasCrc: false,
      padding: false,
      frameLengthBytes: 417,
      sideInfoBytes: 32,
      mainDataCapacityBytes: 381,
    });
    expect(Object.isFrozen(header)).toBe(true);
  });

  it('accounts for MPEG-2 mono side-info, CRC, and one-byte padding', () => {
    expect(
      parseMpegLayer3FrameHeader(
        makeHeader({
          versionBits: 2,
          protectionBit: 0,
          bitrateIndex: 8,
          sampleRateIndex: 1,
          paddingBit: 1,
          channelModeBits: 3,
        }),
      ),
    ).toEqual({
      version: '2',
      layer: 3,
      bitrateIndex: 8,
      bitrateKbps: 64,
      sampleRateIndex: 1,
      sampleRateHz: 24_000,
      channelMode: 'mono',
      channelCount: 1,
      samplesPerFrame: 576,
      hasCrc: true,
      padding: true,
      frameLengthBytes: 193,
      sideInfoBytes: 9,
      mainDataCapacityBytes: 178,
    });
  });

  it('parses MPEG-2.5 with its own sample-rate table and MPEG-2 bitrate table', () => {
    expect(
      parseMpegLayer3FrameHeader(
        makeHeader({
          versionBits: 0,
          bitrateIndex: 14,
          sampleRateIndex: 2,
          channelModeBits: 2,
        }),
      ),
    ).toMatchObject({
      version: '2.5',
      bitrateKbps: 160,
      sampleRateHz: 8_000,
      channelMode: 'dual-channel',
      channelCount: 2,
      samplesPerFrame: 576,
      frameLengthBytes: 1_440,
      sideInfoBytes: 17,
      mainDataCapacityBytes: 1_419,
    });
  });

  it('uses every Layer III bitrate-table entry for each MPEG generation', () => {
    const generations: ReadonlyArray<{
      readonly versionBits: 0 | 2 | 3;
      readonly expected: readonly number[];
    }> = [
      {
        versionBits: 3,
        expected: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      },
      {
        versionBits: 2,
        expected: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
      },
      {
        versionBits: 0,
        expected: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
      },
    ];

    for (const generation of generations) {
      for (let index = 1; index <= 14; index += 1) {
        expect(
          parseMpegLayer3FrameHeader(
            makeHeader({ versionBits: generation.versionBits, bitrateIndex: index }),
          ).bitrateKbps,
        ).toBe(generation.expected[index - 1]);
      }
    }
  });

  it('uses every sample-rate entry for MPEG-1, MPEG-2, and MPEG-2.5', () => {
    const generations: ReadonlyArray<{
      readonly version: MpegLayer3Version;
      readonly versionBits: 0 | 2 | 3;
      readonly rates: readonly [number, number, number];
    }> = [
      { version: '1', versionBits: 3, rates: [44_100, 48_000, 32_000] },
      { version: '2', versionBits: 2, rates: [22_050, 24_000, 16_000] },
      { version: '2.5', versionBits: 0, rates: [11_025, 12_000, 8_000] },
    ];

    for (const generation of generations) {
      for (const sampleRateIndex of [0, 1, 2] as const) {
        const parsed = parseMpegLayer3FrameHeader(
          makeHeader({ versionBits: generation.versionBits, sampleRateIndex }),
        );
        expect(parsed.version).toBe(generation.version);
        expect(parsed.sampleRateIndex).toBe(sampleRateIndex);
        expect(parsed.sampleRateHz).toBe(generation.rates[sampleRateIndex]);
      }
    }
  });

  it('maps all four channel modes and their version-specific side-info sizes', () => {
    const modes: ReadonlyArray<{
      readonly bits: 0 | 1 | 2 | 3;
      readonly mode: MpegLayer3ChannelMode;
      readonly channels: 1 | 2;
    }> = [
      { bits: 0, mode: 'stereo', channels: 2 },
      { bits: 1, mode: 'joint-stereo', channels: 2 },
      { bits: 2, mode: 'dual-channel', channels: 2 },
      { bits: 3, mode: 'mono', channels: 1 },
    ];

    for (const mode of modes) {
      const mpeg1 = parseMpegLayer3FrameHeader(makeHeader({ channelModeBits: mode.bits }));
      const mpeg2 = parseMpegLayer3FrameHeader(
        makeHeader({ versionBits: 2, channelModeBits: mode.bits }),
      );
      const mpeg25 = parseMpegLayer3FrameHeader(
        makeHeader({ versionBits: 0, channelModeBits: mode.bits }),
      );
      expect(mpeg1).toMatchObject({
        channelMode: mode.mode,
        channelCount: mode.channels,
        sideInfoBytes: mode.channels === 1 ? 17 : 32,
      });
      expect(mpeg2).toMatchObject({
        channelMode: mode.mode,
        channelCount: mode.channels,
        sideInfoBytes: mode.channels === 1 ? 9 : 17,
      });
      expect(mpeg25.sideInfoBytes).toBe(mpeg2.sideInfoBytes);
    }
  });

  it('maps the protection bit to CRC presence without changing any other field', () => {
    const withCrc = parseMpegLayer3FrameHeader(makeHeader({ protectionBit: 0 }));
    const withoutCrc = parseMpegLayer3FrameHeader(makeHeader({ protectionBit: 1 }));

    expect(withCrc.hasCrc).toBe(true);
    expect(withoutCrc.hasCrc).toBe(false);
    expect(withCrc.frameLengthBytes).toBe(withoutCrc.frameLengthBytes);
    expect(withCrc.mainDataCapacityBytes).toBe(withoutCrc.mainDataCapacityBytes - 2);
  });

  it('adds exactly one byte when the padding bit is set', () => {
    const unpadded = parseMpegLayer3FrameHeader(makeHeader({ paddingBit: 0 }));
    const padded = parseMpegLayer3FrameHeader(makeHeader({ paddingBit: 1 }));

    expect(unpadded.padding).toBe(false);
    expect(padded.padding).toBe(true);
    expect(padded.frameLengthBytes).toBe(unpadded.frameLengthBytes + 1);
    expect(padded.mainDataCapacityBytes).toBe(unpadded.mainDataCapacityBytes + 1);
  });

  it('keeps every admitted header geometry finite, bounded, and structurally possible', () => {
    for (const versionBits of [0, 2, 3] as const) {
      for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex += 1) {
        for (const sampleRateIndex of [0, 1, 2] as const) {
          for (const channelModeBits of [0, 1, 2, 3] as const) {
            for (const protectionBit of [0, 1] as const) {
              for (const paddingBit of [0, 1] as const) {
                const parsed = parseMpegLayer3FrameHeader(
                  makeHeader({
                    versionBits,
                    bitrateIndex,
                    sampleRateIndex,
                    channelModeBits,
                    protectionBit,
                    paddingBit,
                  }),
                );
                expect(Number.isSafeInteger(parsed.frameLengthBytes)).toBe(true);
                expect(parsed.frameLengthBytes).toBeLessThanOrEqual(1_441);
                expect(parsed.mainDataCapacityBytes).toBeGreaterThanOrEqual(1);
                expect(parsed.mainDataCapacityBytes).toBe(
                  parsed.frameLengthBytes - 4 - (parsed.hasCrc ? 2 : 0) - parsed.sideInfoBytes,
                );
              }
            }
          }
        }
      }
    }
  });

  it('requires an exact four-byte Uint8Array without depending on its backing buffer size', () => {
    expect(() => parseMpegLayer3FrameHeader(null as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => parseMpegLayer3FrameHeader(new Uint8Array(3))).toThrow(/exactly 4 bytes/);
    expect(() => parseMpegLayer3FrameHeader(new Uint8Array(5))).toThrow(/exactly 4 bytes/);

    const backing = new Uint8Array(12).fill(0x55);
    backing.set(makeHeader(), 4);
    expect(parseMpegLayer3FrameHeader(backing.subarray(4, 8)).bitrateKbps).toBe(128);
  });

  it('rejects either broken frame-sync region', () => {
    const badFirst = makeHeader();
    badFirst[0] = 0xfe;
    const badSecond = makeHeader();
    badSecond[1] &= 0xdf;

    expect(() => parseMpegLayer3FrameHeader(badFirst)).toThrow(/sync/);
    expect(() => parseMpegLayer3FrameHeader(badSecond)).toThrow(/sync/);
  });

  it('rejects the reserved MPEG version ID', () => {
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ versionBits: 1 }))).toThrow(
      /reserved version/,
    );
  });

  it('rejects Layer I, Layer II, and the reserved layer value', () => {
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ layerBits: 3 }))).toThrow(/Layer I /);
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ layerBits: 2 }))).toThrow(/Layer II /);
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ layerBits: 0 }))).toThrow(
      /reserved layer/,
    );
  });

  it('rejects free-format and reserved bitrate indices', () => {
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ bitrateIndex: 0 }))).toThrow(
      /Free-format/,
    );
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ bitrateIndex: 15 }))).toThrow(
      /reserved bitrate/,
    );
  });

  it('rejects the reserved sample-rate index with the domain error type', () => {
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ sampleRateIndex: 3 }))).toThrowError(
      MpegLayer3FrameHeaderError,
    );
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ sampleRateIndex: 3 }))).toThrow(
      /reserved sample-rate/,
    );
  });

  it('rejects the reserved emphasis value', () => {
    expect(() => parseMpegLayer3FrameHeader(makeHeader({ emphasisBits: 2 }))).toThrow(
      /reserved emphasis/,
    );
  });
});
