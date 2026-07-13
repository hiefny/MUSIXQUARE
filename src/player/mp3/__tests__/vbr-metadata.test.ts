import { describe, expect, it } from 'vitest';

import { parseMpegLayer3FrameHeader, type MpegLayer3FrameHeader } from '../frame-header.ts';
import {
  Mp3VbrMetadataError,
  parseMp3FirstFrameVbrMetadata,
  type VbriTocEntryBytes,
} from '../vbr-metadata.ts';

interface HeaderOptions {
  readonly versionBits?: 0 | 2 | 3;
  readonly protectionBit?: 0 | 1;
  readonly bitrateIndex?: number;
  readonly sampleRateIndex?: 0 | 1 | 2;
  readonly paddingBit?: 0 | 1;
  readonly channelModeBits?: 0 | 1 | 2 | 3;
}

interface FrameFixture {
  readonly bytes: Uint8Array;
  readonly header: MpegLayer3FrameHeader;
}

interface XingFixtureOptions {
  readonly identifier?: 'Xing' | 'Info';
  readonly flags?: number;
  readonly frameCount?: number;
  readonly streamBytes?: number;
  readonly toc?: readonly number[];
  readonly quality?: number;
  readonly encoderTag?: string;
  readonly encoderDelaySamples?: number;
  readonly endPaddingSamples?: number;
}

interface VbriFixtureOptions {
  readonly version?: number;
  readonly delay?: number;
  readonly quality?: number;
  readonly streamBytes?: number;
  readonly frameCount?: number;
  readonly tocEntryCount?: number;
  readonly tocScale?: number;
  readonly tocEntryBytes?: number;
  readonly framesPerEntry?: number;
  readonly entries?: readonly number[];
}

function makeHeader(options: HeaderOptions = {}): Uint8Array {
  const versionBits = options.versionBits ?? 3;
  const protectionBit = options.protectionBit ?? 1;
  const bitrateIndex = options.bitrateIndex ?? 9;
  const sampleRateIndex = options.sampleRateIndex ?? 0;
  const paddingBit = options.paddingBit ?? 0;
  const channelModeBits = options.channelModeBits ?? 0;
  return Uint8Array.of(
    0xff,
    0xe0 | (versionBits << 3) | (1 << 1) | protectionBit,
    (bitrateIndex << 4) | (sampleRateIndex << 2) | (paddingBit << 1),
    channelModeBits << 6,
  );
}

function makeFrame(options: HeaderOptions = {}): FrameFixture {
  const headerBytes = makeHeader(options);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const bytes = new Uint8Array(header.frameLengthBytes);
  bytes.set(headerBytes);
  return { bytes, header };
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  bytes.set(
    Uint8Array.from(value, (character) => character.charCodeAt(0)),
    offset,
  );
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = Math.floor(value / 0x1_00_00_00) & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x1_00_00) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function setVariableUint(
  bytes: Uint8Array,
  offset: number,
  width: VbriTocEntryBytes,
  value: number,
): void {
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[offset + index] = value & 0xff;
    value = Math.floor(value / 0x100);
  }
}

function xingOffset(header: MpegLayer3FrameHeader): number {
  return 4 + (header.hasCrc ? 2 : 0) + header.sideInfoBytes;
}

function writeXing(fixture: FrameFixture, options: XingFixtureOptions = {}): number {
  const offset = xingOffset(fixture.header);
  const flags = options.flags ?? 0x0f;
  setAscii(fixture.bytes, offset, options.identifier ?? 'Xing');
  setUint32(fixture.bytes, offset + 4, flags);
  let cursor = offset + 8;

  if ((flags & 0x01) !== 0) {
    setUint32(fixture.bytes, cursor, options.frameCount ?? 100);
    cursor += 4;
  }
  if ((flags & 0x02) !== 0) {
    setUint32(fixture.bytes, cursor, options.streamBytes ?? 50_000);
    cursor += 4;
  }
  if ((flags & 0x04) !== 0) {
    const toc = options.toc ?? Array.from({ length: 100 }, (_, index) => index * 2);
    fixture.bytes.set(toc.slice(0, Math.max(0, fixture.bytes.byteLength - cursor)), cursor);
    cursor += 100;
  }
  if ((flags & 0x08) !== 0) {
    setUint32(fixture.bytes, cursor, options.quality ?? 37);
    cursor += 4;
  }

  if (options.encoderTag !== undefined) {
    setAscii(fixture.bytes, cursor, options.encoderTag);
    const delay = options.encoderDelaySamples ?? 576;
    const padding = options.endPaddingSamples ?? 1_100;
    const packed = delay * 0x1000 + padding;
    const delayOffset = cursor + 21;
    if (delayOffset + 3 <= fixture.bytes.byteLength) {
      fixture.bytes[delayOffset] = Math.floor(packed / 0x1_00_00) & 0xff;
      fixture.bytes[delayOffset + 1] = Math.floor(packed / 0x100) & 0xff;
      fixture.bytes[delayOffset + 2] = packed & 0xff;
    }
  }
  return cursor;
}

function writeVbri(fixture: FrameFixture, options: VbriFixtureOptions = {}): void {
  const offset = 36;
  const entries = options.entries ?? [10, 20, 30];
  const tocEntryCount = options.tocEntryCount ?? entries.length;
  const tocEntryBytes = options.tocEntryBytes ?? 2;
  setAscii(fixture.bytes, offset, 'VBRI');
  setUint16(fixture.bytes, offset + 4, options.version ?? 1);
  setUint16(fixture.bytes, offset + 6, options.delay ?? 576);
  setUint16(fixture.bytes, offset + 8, options.quality ?? 73);
  setUint32(fixture.bytes, offset + 10, options.streamBytes ?? 50_000);
  setUint32(fixture.bytes, offset + 14, options.frameCount ?? 10);
  setUint16(fixture.bytes, offset + 18, tocEntryCount);
  setUint16(fixture.bytes, offset + 20, options.tocScale ?? 2);
  setUint16(fixture.bytes, offset + 22, tocEntryBytes);
  setUint16(fixture.bytes, offset + 24, options.framesPerEntry ?? 4);

  if (tocEntryBytes >= 1 && tocEntryBytes <= 4) {
    for (let index = 0; index < entries.length; index += 1) {
      setVariableUint(
        fixture.bytes,
        offset + 26 + index * tocEntryBytes,
        tocEntryBytes as VbriTocEntryBytes,
        entries[index] ?? 0,
      );
    }
  }
}

function parseFixture(fixture: FrameFixture) {
  return parseMp3FirstFrameVbrMetadata(fixture.bytes, fixture.header);
}

describe('parseMp3FirstFrameVbrMetadata Xing and Info', () => {
  it('parses all known fields and proven LAME gapless values canonically', () => {
    const fixture = makeFrame();
    const toc = Array.from({ length: 100 }, (_, index) => Math.min(255, index * 2));
    writeXing(fixture, {
      frameCount: 1_234,
      streamBytes: 987_654,
      toc,
      quality: 42,
      encoderTag: 'LAME3.100',
      encoderDelaySamples: 576,
      endPaddingSamples: 1_337,
    });

    const metadata = parseFixture(fixture);

    expect(metadata).toEqual({
      kind: 'xing',
      identifier: 'Xing',
      headerOffset: 36,
      flags: 0x0f,
      frameCount: 1_234,
      streamBytes: 987_654,
      toc,
      quality: 42,
      gapless: {
        encoderFamily: 'LAME',
        encoderTag: 'LAME3.100',
        encoderDelaySamples: 576,
        endPaddingSamples: 1_337,
      },
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(metadata?.kind === 'xing' && Object.isFrozen(metadata.toc)).toBe(true);
    expect(metadata?.kind === 'xing' && Object.isFrozen(metadata.gapless)).toBe(true);
  });

  it('uses CRC- and generation-aware Xing offsets', () => {
    const cases: ReadonlyArray<{
      readonly options: HeaderOptions;
      readonly expectedOffset: number;
    }> = [
      { options: {}, expectedOffset: 36 },
      { options: { protectionBit: 0 }, expectedOffset: 38 },
      { options: { channelModeBits: 3 }, expectedOffset: 21 },
      { options: { versionBits: 2 }, expectedOffset: 21 },
      { options: { versionBits: 2, channelModeBits: 3 }, expectedOffset: 13 },
      { options: { versionBits: 0, protectionBit: 0, channelModeBits: 3 }, expectedOffset: 15 },
    ];

    for (const { options, expectedOffset } of cases) {
      const fixture = makeFrame(options);
      writeXing(fixture, { flags: 0x01, frameCount: 7 });
      expect(parseFixture(fixture)).toMatchObject({
        kind: 'xing',
        headerOffset: expectedOffset,
        frameCount: 7,
      });
    }
  });

  it('parses Info and every legal optional-field combination in flag order', () => {
    for (let flags = 0; flags <= 0x0f; flags += 1) {
      const fixture = makeFrame();
      writeXing(fixture, {
        identifier: 'Info',
        flags,
        frameCount: 9,
        streamBytes: 4_000,
        quality: 100,
      });

      expect(parseFixture(fixture)).toMatchObject({
        identifier: 'Info',
        flags,
        frameCount: (flags & 0x01) !== 0 ? 9 : null,
        streamBytes: (flags & 0x02) !== 0 ? 4_000 : null,
        quality: (flags & 0x08) !== 0 ? 100 : null,
      });
    }
  });

  it.each(['LAME3.100', 'L3.99r   ', 'Lavf60.16', 'Lavc60.31'] as const)(
    'recognizes the %s encoder family for trim metadata',
    (encoderTag) => {
      const fixture = makeFrame();
      writeXing(fixture, { flags: 0x01, frameCount: 10, encoderTag });

      expect(parseFixture(fixture)).toMatchObject({
        gapless: {
          encoderFamily: encoderTag.startsWith('L3.99') ? 'L3.99' : encoderTag.slice(0, 4),
          encoderTag,
          encoderDelaySamples: 576,
          endPaddingSamples: 1_100,
        },
      });
    },
  );

  it('omits unproven gapless data instead of trimming playback', () => {
    const noFrameCount = makeFrame();
    writeXing(noFrameCount, { flags: 0, encoderTag: 'LAME3.100' });
    expect(parseFixture(noFrameCount)).toMatchObject({ gapless: null });

    const unrecognized = makeFrame();
    writeXing(unrecognized, { flags: 0x01, encoderTag: 'Other3.10' });
    expect(parseFixture(unrecognized)).toMatchObject({ gapless: null });

    const unprintable = makeFrame();
    const encoderOffset = writeXing(unprintable, {
      flags: 0x01,
      encoderTag: 'LAME3.100',
    });
    unprintable.bytes[encoderOffset + 8] = 0;
    expect(parseFixture(unprintable)).toMatchObject({ gapless: null });

    const sentinel = makeFrame();
    writeXing(sentinel, {
      flags: 0x01,
      encoderTag: 'LAME3.100',
      encoderDelaySamples: 0x0fff,
    });
    expect(parseFixture(sentinel)).toMatchObject({ gapless: null });

    const unsupportedRevision = makeFrame();
    const revisionOffset = writeXing(unsupportedRevision, {
      flags: 0x01,
      encoderTag: 'LAME3.100',
    });
    unsupportedRevision.bytes[revisionOffset + 9] = 0x10;
    expect(parseFixture(unsupportedRevision)).toMatchObject({ gapless: null });

    const impossibleTrim = makeFrame();
    writeXing(impossibleTrim, {
      flags: 0x01,
      frameCount: 1,
      encoderTag: 'LAME3.100',
      encoderDelaySamples: 1_000,
      endPaddingSamples: 152,
    });
    expect(parseFixture(impossibleTrim)).toMatchObject({ gapless: null });
  });

  it('omits a recognized but truncated LAME extension', () => {
    const fixture = makeFrame({
      versionBits: 2,
      bitrateIndex: 2,
      sampleRateIndex: 1,
    });
    expect(fixture.header.frameLengthBytes).toBe(48);
    writeXing(fixture, { flags: 0x01, frameCount: 10, encoderTag: 'LAME3.100' });

    expect(parseFixture(fixture)).toMatchObject({
      kind: 'xing',
      frameCount: 10,
      gapless: null,
    });
  });

  it('rejects unknown flags and invalid scalar fields', () => {
    const unknownFlag = makeFrame();
    writeXing(unknownFlag, { flags: 0x10 });
    expect(() => parseFixture(unknownFlag)).toThrow(/unknown flag/i);

    const zeroFrames = makeFrame();
    writeXing(zeroFrames, { flags: 0x01, frameCount: 0 });
    expect(() => parseFixture(zeroFrames)).toThrow(/frame count.*greater than zero/i);

    const shortStream = makeFrame();
    writeXing(shortStream, { flags: 0x02, streamBytes: shortStream.header.frameLengthBytes - 1 });
    expect(() => parseFixture(shortStream)).toThrow(/shorter than its first frame/i);

    const badQuality = makeFrame();
    writeXing(badQuality, { flags: 0x08, quality: 101 });
    expect(() => parseFixture(badQuality)).toThrow(/quality.*0.*100/i);
  });

  it('rejects truncated claimed fields and unsafe Xing TOCs', () => {
    const truncated = makeFrame({ bitrateIndex: 1, sampleRateIndex: 1 });
    expect(truncated.header.frameLengthBytes).toBe(96);
    writeXing(truncated, { flags: 0x04 });
    expect(() => parseFixture(truncated)).toThrow(/TOC.*truncated/i);

    const nonzeroStart = makeFrame();
    writeXing(nonzeroStart, {
      flags: 0x04,
      toc: [1, ...Array.from({ length: 99 }, (_, index) => index + 1)],
    });
    expect(() => parseFixture(nonzeroStart)).toThrow(/begin.*zero/i);

    const descending = makeFrame();
    const toc = Array.from({ length: 100 }, (_, index) => index);
    toc[50] = 1;
    writeXing(descending, { flags: 0x04, toc });
    expect(() => parseFixture(descending)).toThrow(/monotonic/i);
  });
});

describe('parseMp3FirstFrameVbrMetadata VBRI', () => {
  it('parses and freezes a canonical VBRI v1 table', () => {
    const fixture = makeFrame();
    writeVbri(fixture, {
      delay: 321,
      quality: 84,
      streamBytes: 40_000,
      frameCount: 10,
      tocScale: 3,
      tocEntryBytes: 2,
      framesPerEntry: 4,
      entries: [100, 200, 300],
    });

    const metadata = parseFixture(fixture);

    expect(metadata).toEqual({
      kind: 'vbri',
      identifier: 'VBRI',
      headerOffset: 36,
      version: 1,
      delay: 321,
      quality: 84,
      streamBytes: 40_000,
      frameCount: 10,
      tocEntryCount: 3,
      tocScale: 3,
      tocEntryBytes: 2,
      framesPerEntry: 4,
      tocEntries: [100, 200, 300],
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(metadata?.kind === 'vbri' && Object.isFrozen(metadata.tocEntries)).toBe(true);
  });

  it.each([1, 2, 3, 4] as const)('reads %i-byte big-endian TOC entries', (width) => {
    const fixture = makeFrame({ bitrateIndex: 14 });
    const values =
      width === 1
        ? [1, 127, 255]
        : width === 2
          ? [1, 0x0102, 0xffff]
          : width === 3
            ? [1, 0x0102, 0x010203]
            : [1, 0x0102, 0x01020304];
    writeVbri(fixture, {
      tocEntryBytes: width,
      entries: values,
      streamBytes: 100_000_000,
    });

    expect(parseFixture(fixture)).toMatchObject({
      tocEntryBytes: width,
      tocEntries: values,
    });
  });

  it('accepts only the final TOC entry as a partial frame group', () => {
    const exact = makeFrame();
    writeVbri(exact, { frameCount: 12, framesPerEntry: 4 });
    expect(parseFixture(exact)).toMatchObject({ frameCount: 12 });

    const partial = makeFrame();
    writeVbri(partial, { frameCount: 9, framesPerEntry: 4 });
    expect(parseFixture(partial)).toMatchObject({ frameCount: 9 });

    const uncovered = makeFrame();
    writeVbri(uncovered, { frameCount: 13, framesPerEntry: 4 });
    expect(() => parseFixture(uncovered)).toThrow(/frame coverage/i);

    const redundantEntry = makeFrame();
    writeVbri(redundantEntry, { frameCount: 8, framesPerEntry: 4 });
    expect(() => parseFixture(redundantEntry)).toThrow(/frame coverage/i);
  });

  it('rejects unsupported versions and zero/impossible scalar geometry', () => {
    const cases: ReadonlyArray<{
      readonly options: VbriFixtureOptions;
      readonly message: RegExp;
    }> = [
      { options: { version: 2 }, message: /version 2.*unsupported/i },
      { options: { quality: 101 }, message: /quality.*0.*100/i },
      { options: { streamBytes: 1 }, message: /shorter than its first frame/i },
      { options: { frameCount: 0 }, message: /frame count.*greater than zero/i },
      { options: { tocEntryCount: 0, entries: [] }, message: /entry count.*greater than zero/i },
      { options: { tocScale: 0 }, message: /scale.*greater than zero/i },
      { options: { tocEntryBytes: 0 }, message: /entry width/i },
      { options: { tocEntryBytes: 5 }, message: /entry width/i },
      { options: { framesPerEntry: 0 }, message: /frames per.*greater than zero/i },
    ];

    for (const { options, message } of cases) {
      const fixture = makeFrame();
      writeVbri(fixture, options);
      expect(() => parseFixture(fixture)).toThrow(message);
    }
  });

  it('rejects truncated, zero, and out-of-declaration TOC entries', () => {
    const truncatedFixedHeader = makeFrame({
      versionBits: 2,
      bitrateIndex: 2,
      sampleRateIndex: 1,
    });
    expect(truncatedFixedHeader.header.frameLengthBytes).toBe(48);
    setAscii(truncatedFixedHeader.bytes, 36, 'VBRI');
    expect(() => parseFixture(truncatedFixedHeader)).toThrow(/VBRI header.*truncated/i);

    const truncated = makeFrame({ bitrateIndex: 1, sampleRateIndex: 1 });
    writeVbri(truncated, {
      tocEntryCount: 20,
      tocEntryBytes: 4,
      framesPerEntry: 1,
      frameCount: 20,
      entries: [],
    });
    expect(() => parseFixture(truncated)).toThrow(/TOC table.*truncated/i);

    const zero = makeFrame();
    writeVbri(zero, { entries: [10, 0, 30] });
    expect(() => parseFixture(zero)).toThrow(/entry 1.*greater than zero/i);

    const tooManyBytes = makeFrame();
    writeVbri(tooManyBytes, { streamBytes: 500, tocScale: 100, entries: [2, 2, 2] });
    expect(() => parseFixture(tooManyBytes)).toThrow(/more bytes than.*stream/i);
  });
});

describe('parseMp3FirstFrameVbrMetadata input and conflict checks', () => {
  it('returns null when neither canonical marker exists', () => {
    const fixture = makeFrame();
    expect(parseFixture(fixture)).toBeNull();
  });

  it('rejects conflicting canonical Xing and VBRI headers', () => {
    const fixture = makeFrame({ channelModeBits: 3 });
    writeXing(fixture, { flags: 0 });
    writeVbri(fixture);
    expect(() => parseFixture(fixture)).toThrow(/conflicting Xing and VBRI/i);
  });

  it('requires an exact complete frame matching the supplied parsed header', () => {
    const fixture = makeFrame();
    expect(() =>
      parseMp3FirstFrameVbrMetadata(null as unknown as Uint8Array, fixture.header),
    ).toThrow(TypeError);
    expect(() =>
      parseMp3FirstFrameVbrMetadata(fixture.bytes.subarray(0, 3), fixture.header),
    ).toThrow(/shorter than.*four-byte header/i);
    expect(() =>
      parseMp3FirstFrameVbrMetadata(fixture.bytes.subarray(0, -1), fixture.header),
    ).toThrow(/expected exactly/i);

    const different = makeFrame({ channelModeBits: 3 });
    expect(() => parseMp3FirstFrameVbrMetadata(fixture.bytes, different.header)).toThrow(
      /does not match/i,
    );
  });

  it('parses an exact frame view without depending on backing-buffer size', () => {
    const fixture = makeFrame();
    writeXing(fixture, { flags: 0x01, frameCount: 17 });
    const backing = new Uint8Array(fixture.bytes.byteLength + 20).fill(0xaa);
    backing.set(fixture.bytes, 10);

    expect(
      parseMp3FirstFrameVbrMetadata(
        backing.subarray(10, 10 + fixture.bytes.byteLength),
        fixture.header,
      ),
    ).toMatchObject({ kind: 'xing', frameCount: 17 });
  });

  it('uses the metadata domain error for claimed structural failures', () => {
    const fixture = makeFrame();
    writeXing(fixture, { flags: 0x10 });
    expect(() => parseFixture(fixture)).toThrowError(Mp3VbrMetadataError);
  });
});
