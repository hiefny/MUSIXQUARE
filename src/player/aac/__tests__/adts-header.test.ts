import { describe, expect, it } from 'vitest';

import {
  AdtsHeaderError,
  adtsCoreSampleRateHzForIndex,
  UnsupportedAdtsProgramConfigElementError,
  UnsupportedAdtsRawDataBlocksError,
  parseAdtsHeader,
  type AdtsChannelConfiguration,
} from '../adts-header.ts';

interface HeaderOptions {
  readonly mpegId?: 0 | 1;
  readonly layer?: 0 | 1 | 2 | 3;
  readonly protectionAbsent?: boolean;
  readonly profile?: 0 | 1 | 2 | 3;
  readonly sampleRateIndex?: number;
  readonly privateBit?: boolean;
  readonly channelConfiguration?: number;
  readonly originalCopy?: boolean;
  readonly home?: boolean;
  readonly copyrightIdentificationBit?: boolean;
  readonly copyrightIdentificationStart?: boolean;
  readonly frameLengthBytes?: number;
  readonly bufferFullness?: number;
  readonly rawDataBlocks?: 1 | 2 | 3 | 4;
  readonly crcCheck?: number;
}

function makeHeader(options: HeaderOptions = {}): Uint8Array {
  const mpegId = options.mpegId ?? 0;
  const layer = options.layer ?? 0;
  const protectionAbsent = options.protectionAbsent ?? true;
  const profile = options.profile ?? 1;
  const sampleRateIndex = options.sampleRateIndex ?? 4;
  const privateBit = options.privateBit ?? false;
  const channelConfiguration = options.channelConfiguration ?? 2;
  const originalCopy = options.originalCopy ?? false;
  const home = options.home ?? false;
  const copyrightIdentificationBit = options.copyrightIdentificationBit ?? false;
  const copyrightIdentificationStart = options.copyrightIdentificationStart ?? false;
  const frameLengthBytes = options.frameLengthBytes ?? (protectionAbsent ? 107 : 109);
  const bufferFullness = options.bufferFullness ?? 0x7ff;
  const rawDataBlocks = options.rawDataBlocks ?? 1;
  const crcCheck = options.crcCheck ?? 0;

  const bytes = new Uint8Array(protectionAbsent ? 7 : 9);
  bytes[0] = 0xff;
  bytes[1] = 0xf0 | (mpegId << 3) | (layer << 1) | (protectionAbsent ? 1 : 0);
  bytes[2] =
    (profile << 6) |
    (sampleRateIndex << 2) |
    (privateBit ? 0b10 : 0) |
    ((channelConfiguration >>> 2) & 1);
  bytes[3] =
    ((channelConfiguration & 0b11) << 6) |
    (originalCopy ? 0b10_0000 : 0) |
    (home ? 0b1_0000 : 0) |
    (copyrightIdentificationBit ? 0b1000 : 0) |
    (copyrightIdentificationStart ? 0b100 : 0) |
    ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | ((bufferFullness >>> 6) & 0b1_1111);
  bytes[6] = ((bufferFullness & 0b11_1111) << 2) | ((rawDataBlocks - 1) & 0b11);
  if (!protectionAbsent) {
    bytes[7] = crcCheck >>> 8;
    bytes[8] = crcCheck & 0xff;
  }
  return bytes;
}

describe('ADTS fixed and variable header parser', () => {
  it('returns a frozen canonical MPEG-4 AAC-LC stereo descriptor', () => {
    const parsed = parseAdtsHeader(
      makeHeader({
        privateBit: true,
        originalCopy: true,
        home: true,
        copyrightIdentificationBit: true,
        copyrightIdentificationStart: true,
        frameLengthBytes: 1_024,
        bufferFullness: 321,
      }),
    );

    expect(parsed).toEqual({
      mpegId: 0,
      mpegVersion: 'MPEG-4',
      layer: 0,
      protectionAbsent: true,
      hasCrc: false,
      crcCheck: null,
      profile: 1,
      coreAudioObjectType: 2,
      profileName: 'low-complexity',
      sampleRateIndex: 4,
      coreSampleRateHz: 44_100,
      privateBit: true,
      channelConfiguration: 2,
      coreChannelCount: 2,
      coreChannelLayout: 'stereo',
      originalCopy: true,
      home: true,
      copyrightIdentificationBit: true,
      copyrightIdentificationStart: true,
      frameLengthBytes: 1_024,
      headerLengthBytes: 7,
      payloadLengthBytes: 1_017,
      bufferFullness: 321,
      rawDataBlocks: 1,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('parses the complete MPEG-4 sampling-frequency table', () => {
    const expected = [
      96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
      7_350,
    ];

    for (let sampleRateIndex = 0; sampleRateIndex < expected.length; sampleRateIndex += 1) {
      expect(adtsCoreSampleRateHzForIndex(sampleRateIndex)).toBe(expected[sampleRateIndex]);
      expect(parseAdtsHeader(makeHeader({ sampleRateIndex })).coreSampleRateHz).toBe(
        expected[sampleRateIndex],
      );
    }
  });

  it.each([-1, -0, 1.5, 13, 14, 15, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects noncanonical direct sample-rate index %s',
    (sampleRateIndex) => {
      expect(() => adtsCoreSampleRateHzForIndex(sampleRateIndex)).toThrowError(AdtsHeaderError);
    },
  );

  it('maps mono, stereo, 5.1-back, and configuration 7 to wide-back 7.1', () => {
    const mappings: ReadonlyArray<readonly [AdtsChannelConfiguration, number, string]> = [
      [1, 1, 'mono'],
      [2, 2, 'stereo'],
      [6, 6, '5.1-back'],
      [7, 8, '7.1-wide-back'],
    ];

    for (const [channelConfiguration, coreChannelCount, coreChannelLayout] of mappings) {
      expect(parseAdtsHeader(makeHeader({ channelConfiguration }))).toMatchObject({
        channelConfiguration,
        coreChannelCount,
        coreChannelLayout,
      });
    }
  });

  it('maps every non-PCE channel configuration deterministically', () => {
    const expected = [
      [1, 1, 'mono'],
      [2, 2, 'stereo'],
      [3, 3, '3.0-front'],
      [4, 4, '4.0-back-center'],
      [5, 5, '5.0-back'],
      [6, 6, '5.1-back'],
      [7, 8, '7.1-wide-back'],
    ] as const;

    for (const [configuration, count, layout] of expected) {
      expect(parseAdtsHeader(makeHeader({ channelConfiguration: configuration }))).toMatchObject({
        channelConfiguration: configuration,
        coreChannelCount: count,
        coreChannelLayout: layout,
      });
    }
  });

  it('parses a CRC-protected MPEG-2 frame and accounts for its two-byte CRC header', () => {
    expect(
      parseAdtsHeader(
        makeHeader({
          mpegId: 1,
          protectionAbsent: false,
          profile: 0,
          sampleRateIndex: 3,
          channelConfiguration: 6,
          frameLengthBytes: 4_095,
          bufferFullness: 0x456,
          crcCheck: 0xabcd,
        }),
      ),
    ).toMatchObject({
      mpegId: 1,
      mpegVersion: 'MPEG-2',
      protectionAbsent: false,
      hasCrc: true,
      crcCheck: 0xabcd,
      profile: 0,
      coreAudioObjectType: 1,
      profileName: 'main',
      coreSampleRateHz: 48_000,
      coreChannelCount: 6,
      frameLengthBytes: 4_095,
      headerLengthBytes: 9,
      payloadLengthBytes: 4_086,
      bufferFullness: 0x456,
    });
  });

  it('accepts MPEG-4 LTP but rejects profile value 3 where MPEG-2 reserves it', () => {
    expect(parseAdtsHeader(makeHeader({ mpegId: 0, profile: 3 }))).toMatchObject({
      mpegVersion: 'MPEG-4',
      profile: 3,
      coreAudioObjectType: 4,
      profileName: 'long-term-prediction',
    });
    expect(() => parseAdtsHeader(makeHeader({ mpegId: 1, profile: 3 }))).toThrow(
      /profile value 3 is reserved/,
    );
  });

  it('rejects a broken syncword and every nonzero layer', () => {
    const badFirst = makeHeader();
    badFirst[0] = 0xfe;
    const badSecond = makeHeader();
    badSecond[1] &= 0x7f;

    expect(() => parseAdtsHeader(badFirst)).toThrow(/syncword/);
    expect(() => parseAdtsHeader(badSecond)).toThrow(/syncword/);
    for (const layer of [1, 2, 3] as const) {
      expect(() => parseAdtsHeader(makeHeader({ layer }))).toThrow(/layer must be zero/);
    }
  });

  it('rejects reserved and forbidden sampling-frequency indices', () => {
    for (const sampleRateIndex of [13, 14, 15]) {
      expect(() => parseAdtsHeader(makeHeader({ sampleRateIndex }))).toThrowError(AdtsHeaderError);
      expect(() => parseAdtsHeader(makeHeader({ sampleRateIndex }))).toThrow(/sample-rate index/);
    }
  });

  it('rejects channel_configuration 0 instead of pretending to parse an in-band PCE', () => {
    expect(() => parseAdtsHeader(makeHeader({ channelConfiguration: 0 }))).toThrowError(
      UnsupportedAdtsProgramConfigElementError,
    );
    expect(() => parseAdtsHeader(makeHeader({ channelConfiguration: 0 }))).toThrow(
      /Program Config Element/,
    );
  });

  it('rejects multiple raw_data_blocks as an explicit atomic-frame policy', () => {
    for (const rawDataBlocks of [2, 3, 4] as const) {
      expect(() => parseAdtsHeader(makeHeader({ rawDataBlocks }))).toThrowError(
        UnsupportedAdtsRawDataBlocksError,
      );
      expect(() => parseAdtsHeader(makeHeader({ rawDataBlocks }))).toThrow(
        new RegExp(`${rawDataBlocks} raw_data_blocks`),
      );
    }
  });

  it('rejects frame lengths that cannot contain both the selected header and AAC payload', () => {
    expect(() => parseAdtsHeader(makeHeader({ frameLengthBytes: 6 }))).toThrow(/frame length/);
    expect(() => parseAdtsHeader(makeHeader({ frameLengthBytes: 7 }))).toThrow(/AAC payload/);
    expect(() =>
      parseAdtsHeader(makeHeader({ protectionAbsent: false, frameLengthBytes: 8 })),
    ).toThrow(/frame length/);
    expect(() =>
      parseAdtsHeader(makeHeader({ protectionAbsent: false, frameLengthBytes: 9 })),
    ).toThrow(/AAC payload/);
  });

  it('requires exactly the fixed or CRC-bearing header length', () => {
    expect(() => parseAdtsHeader(null as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => parseAdtsHeader(new Uint8Array(6))).toThrow(/exactly 7 or 9 bytes/);
    expect(() => parseAdtsHeader(new Uint8Array(8))).toThrow(/exactly 7 or 9 bytes/);
    expect(() => parseAdtsHeader(new Uint8Array(10))).toThrow(/exactly 7 or 9 bytes/);

    expect(() => parseAdtsHeader(makeHeader().slice(0, 6))).toThrow(/exactly 7 or 9 bytes/);
    expect(() => parseAdtsHeader(makeHeader({ protectionAbsent: false }).slice(0, 7))).toThrow(
      /CRC header is truncated/,
    );
    expect(() => {
      const noCrcWithExtraBytes = new Uint8Array(9);
      noCrcWithExtraBytes.set(makeHeader());
      parseAdtsHeader(noCrcWithExtraBytes);
    }).toThrow(/without CRC must contain exactly 7 bytes/);
  });

  it('copies typed-array bytes without invoking caller accessors or iterators', () => {
    const bytes = makeHeader();
    let accessorCalls = 0;
    Object.defineProperty(bytes, 'byteLength', {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error('must not run');
      },
    });
    Object.defineProperty(bytes, Symbol.iterator, {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error('must not run');
      },
    });

    expect(parseAdtsHeader(bytes).frameLengthBytes).toBe(107);
    expect(accessorCalls).toBe(0);

    const proxy = new Proxy(makeHeader(), {
      get() {
        accessorCalls += 1;
        throw new Error('must not run');
      },
      getPrototypeOf() {
        accessorCalls += 1;
        throw new Error('must not run');
      },
    });
    expect(() => parseAdtsHeader(proxy)).toThrow(TypeError);
    expect(accessorCalls).toBe(0);
  });

  it('rejects SharedArrayBuffer-backed views instead of accepting a torn snapshot', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const shared = new Uint8Array(new SharedArrayBuffer(7));
    shared.set(makeHeader());

    expect(() => parseAdtsHeader(shared)).toThrow(TypeError);
    expect(() => parseAdtsHeader(shared)).toThrow(/non-shared/);
  });

  it('does not depend on the size of the input view backing buffer', () => {
    const backing = new Uint8Array(32).fill(0x55);
    backing.set(makeHeader({ frameLengthBytes: 8_191 }), 11);
    expect(parseAdtsHeader(backing.subarray(11, 18))).toMatchObject({
      frameLengthBytes: 8_191,
      payloadLengthBytes: 8_184,
    });
  });
});
