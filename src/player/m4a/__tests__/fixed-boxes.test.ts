import { describe, expect, it } from 'vitest';

import {
  M4aFixedBoxError,
  parseM4aEditList,
  parseM4aHandlerHeader,
  parseM4aMediaHeader,
  parseM4aMovieHeader,
  parseM4aTrackHeader,
} from '../fixed-boxes.ts';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const IDENTITY_MATRIX = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] as const;

function writeFullBox(bytes: Uint8Array, version: number, flags = 0): DataView {
  bytes[0] = version;
  bytes[1] = (flags >>> 16) & 0xff;
  bytes[2] = (flags >>> 8) & 0xff;
  bytes[3] = flags & 0xff;
  return new DataView(bytes.buffer);
}

function writeIdentityMatrix(view: DataView, offset: number): void {
  IDENTITY_MATRIX.forEach((value, index) => view.setUint32(offset + index * 4, value, false));
}

function movieHeader(
  version: 0 | 1,
  options: Readonly<{
    timescale?: number;
    duration?: bigint;
    nextTrackId?: number;
  }> = {},
): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 100 : 112);
  const view = writeFullBox(bytes, version);
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  const rateOffset = version === 0 ? 20 : 32;
  const matrixOffset = version === 0 ? 36 : 48;
  const nextTrackIdOffset = version === 0 ? 96 : 108;
  view.setUint32(timescaleOffset, options.timescale ?? 1_000, false);
  if (version === 0) {
    view.setUint32(durationOffset, Number(options.duration ?? 12_345n), false);
  } else {
    view.setBigUint64(durationOffset, options.duration ?? 0x1_0000_3039n, false);
  }
  view.setUint32(rateOffset, 0x0001_0000, false);
  view.setUint16(rateOffset + 4, 0x0100, false);
  writeIdentityMatrix(view, matrixOffset);
  view.setUint32(nextTrackIdOffset, options.nextTrackId ?? 2, false);
  return bytes;
}

function mediaHeader(
  version: 0 | 1,
  options: Readonly<{
    timescale?: number;
    duration?: bigint;
    languagePacked?: number;
  }> = {},
): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 24 : 36);
  const view = writeFullBox(bytes, version);
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  const languageOffset = version === 0 ? 20 : 32;
  view.setUint32(timescaleOffset, options.timescale ?? 48_000, false);
  if (version === 0) {
    view.setUint32(durationOffset, Number(options.duration ?? 96_000n), false);
  } else {
    view.setBigUint64(durationOffset, options.duration ?? 0x1_0001_7700n, false);
  }
  view.setUint16(languageOffset, options.languagePacked ?? 0x55c4, false);
  return bytes;
}

function trackHeader(
  version: 0 | 1,
  options: Readonly<{
    flags?: number;
    trackId?: number;
    duration?: bigint;
    layer?: number;
    alternateGroup?: number;
  }> = {},
): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 84 : 96);
  const view = writeFullBox(bytes, version, options.flags ?? 0x0000_0003);
  const trackIdOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 20 : 28;
  const layerOffset = version === 0 ? 32 : 44;
  const matrixOffset = version === 0 ? 40 : 52;
  view.setUint32(trackIdOffset, options.trackId ?? 7, false);
  if (version === 0) {
    view.setUint32(durationOffset, Number(options.duration ?? 0n), false);
  } else {
    view.setBigUint64(durationOffset, options.duration ?? 0x1_0000_0007n, false);
  }
  view.setInt16(layerOffset, options.layer ?? -2, false);
  view.setInt16(layerOffset + 2, options.alternateGroup ?? 3, false);
  view.setInt16(layerOffset + 4, 0x0100, false);
  writeIdentityMatrix(view, matrixOffset);
  return bytes;
}

function handlerHeader(handlerType = 'soun'): Uint8Array {
  const bytes = new Uint8Array(24);
  writeFullBox(bytes, 0);
  for (let index = 0; index < 4; index += 1) {
    bytes[8 + index] = handlerType.charCodeAt(index);
  }
  return bytes;
}

function editList(
  version: 0 | 1,
  options: Readonly<{
    segmentDuration?: bigint;
    mediaTime?: bigint;
    entryCount?: number;
    rateInteger?: number;
    rateFraction?: number;
  }> = {},
): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 20 : 28);
  const view = writeFullBox(bytes, version);
  view.setUint32(4, options.entryCount ?? 1, false);
  if (version === 0) {
    view.setUint32(8, Number(options.segmentDuration ?? 44_100n), false);
    view.setInt32(12, Number(options.mediaTime ?? 1_024n), false);
    view.setInt16(16, options.rateInteger ?? 1, false);
    view.setInt16(18, options.rateFraction ?? 0, false);
  } else {
    view.setBigUint64(8, options.segmentDuration ?? 0x1_0000_ac44n, false);
    view.setBigInt64(16, options.mediaTime ?? 0x1_0000_0400n, false);
    view.setInt16(24, options.rateInteger ?? 1, false);
    view.setInt16(26, options.rateFraction ?? 0, false);
  }
  return bytes;
}

function mutate(bytes: Uint8Array, offset: number, value = 1): Uint8Array {
  const result = bytes.slice();
  result[offset] = value;
  return result;
}

describe('M4A fixed FullBox parsers', () => {
  describe('mvhd', () => {
    it('parses and freezes an exact version-zero movie header', () => {
      const parsed = parseM4aMovieHeader(movieHeader(0));
      expect(parsed).toEqual({
        version: 0,
        movieTimescale: 1_000,
        movieDurationMovieTicks: 12_345,
        nextTrackId: 2,
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('parses a safe version-one duration beyond uint32 without precision loss', () => {
      expect(parseM4aMovieHeader(movieHeader(1))).toEqual({
        version: 1,
        movieTimescale: 1_000,
        movieDurationMovieTicks: 0x1_0000_3039,
        nextTrackId: 2,
      });
    });

    it.each([
      ['flags', mutate(movieHeader(0), 3), /flags must be zero/i],
      ['timescale', movieHeader(0, { timescale: 0 }), /timescale must be a positive/i],
      ['duration', movieHeader(0, { duration: 0n }), /duration must be a positive/i],
      ['next track ID', movieHeader(0, { nextTrackId: 0 }), /next track ID must be a positive/i],
      ['rate', mutate(movieHeader(0), 23), /rate must be the standard 1\.0/i],
      ['volume', mutate(movieHeader(0), 25, 1), /volume must be the standard 1\.0/i],
      ['reserved', mutate(movieHeader(0), 28), /reserved fields must be zero/i],
      ['matrix', mutate(movieHeader(0), 36), /matrix must be the identity/i],
      ['predefined', mutate(movieHeader(0), 72), /predefined fields must be zero/i],
    ])('rejects a noncanonical %s field', (_name, bytes, expected) => {
      expect(() => parseM4aMovieHeader(bytes)).toThrow(expected);
    });

    it('rejects an unsafe version-one duration', () => {
      expect(() => parseM4aMovieHeader(movieHeader(1, { duration: MAX_SAFE_BIGINT + 1n }))).toThrow(
        /duration exceeds.*safe-integer/i,
      );
    });
  });

  describe('mdhd', () => {
    it('parses exact version-zero language and timing scalars', () => {
      const parsed = parseM4aMediaHeader(mediaHeader(0));
      expect(parsed).toEqual({
        version: 0,
        mediaTimescale: 48_000,
        mediaDurationMediaTicks: 96_000,
        languagePacked: 0x55c4,
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('parses a safe version-one duration beyond uint32 without precision loss', () => {
      expect(parseM4aMediaHeader(mediaHeader(1))).toEqual({
        version: 1,
        mediaTimescale: 48_000,
        mediaDurationMediaTicks: 0x1_0001_7700,
        languagePacked: 0x55c4,
      });
    });

    it.each([
      ['flags', mutate(mediaHeader(0), 3), /flags must be zero/i],
      ['timescale', mediaHeader(0, { timescale: 0 }), /timescale must be a positive/i],
      ['duration', mediaHeader(0, { duration: 0n }), /duration must be a positive/i],
      ['predefined', mutate(mediaHeader(0), 23), /predefined field must be zero/i],
    ])('rejects a noncanonical %s field', (_name, bytes, expected) => {
      expect(() => parseM4aMediaHeader(bytes)).toThrow(expected);
    });

    it('rejects an unsafe version-one duration', () => {
      expect(() => parseM4aMediaHeader(mediaHeader(1, { duration: MAX_SAFE_BIGINT + 1n }))).toThrow(
        /duration exceeds.*safe-integer/i,
      );
    });
  });

  describe('tkhd', () => {
    it('parses signed geometry fields and canonical 24-bit flags from version zero', () => {
      const parsed = parseM4aTrackHeader(trackHeader(0, { flags: 0xab_cdef }));
      expect(parsed).toEqual({
        version: 0,
        flags: 0xab_cdef,
        trackId: 7,
        durationMovieTicks: 0,
        layer: -2,
        alternateGroup: 3,
        volumeFixed8_8: 0x0100,
        widthFixed16_16: 0,
        heightFixed16_16: 0,
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('parses a safe version-one duration beyond uint32 without precision loss', () => {
      expect(parseM4aTrackHeader(trackHeader(1))).toMatchObject({
        version: 1,
        flags: 3,
        durationMovieTicks: 0x1_0000_0007,
      });
    });

    it.each([
      ['track ID', trackHeader(0, { trackId: 0 }), /track ID must be a positive/i],
      ['first reserved field', mutate(trackHeader(0), 16), /reserved track field must be zero/i],
      [
        'second reserved field',
        mutate(trackHeader(0), 24),
        /reserved duration fields must be zero/i,
      ],
      ['volume', mutate(trackHeader(0), 37, 1), /volume must be the standard 1\.0/i],
      ['geometry reserved', mutate(trackHeader(0), 38), /geometry reserved field must be zero/i],
      ['matrix', mutate(trackHeader(0), 40), /matrix must be the identity/i],
      ['width', mutate(trackHeader(0), 76, 1), /width and height must be zero/i],
      ['height', mutate(trackHeader(0), 80, 1), /width and height must be zero/i],
    ])('rejects a noncanonical %s field', (_name, bytes, expected) => {
      expect(() => parseM4aTrackHeader(bytes)).toThrow(expected);
    });

    it('rejects an unsafe version-one duration', () => {
      expect(() => parseM4aTrackHeader(trackHeader(1, { duration: MAX_SAFE_BIGINT + 1n }))).toThrow(
        /duration exceeds.*safe-integer/i,
      );
    });
  });

  describe('hdlr', () => {
    it('parses and freezes only the exact fixed prefix', () => {
      const parsed = parseM4aHandlerHeader(handlerHeader('soun'));
      expect(parsed).toEqual({ handlerType: 'soun' });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it.each([
      ['version', mutate(handlerHeader(), 0, 1), /version must be zero/i],
      ['flags', mutate(handlerHeader(), 3), /flags must be zero/i],
      ['predefined', mutate(handlerHeader(), 4), /predefined field must be zero/i],
      ['reserved', mutate(handlerHeader(), 12), /reserved fields must be zero/i],
    ])('rejects a noncanonical %s field', (_name, bytes, expected) => {
      expect(() => parseM4aHandlerHeader(bytes)).toThrow(expected);
    });
  });

  describe('elst', () => {
    it('parses and freezes an exact version-zero non-empty rate-1 edit', () => {
      const parsed = parseM4aEditList(editList(0));
      expect(parsed).toEqual({
        mediaTimeCoreFrames: 1_024,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
        segmentDurationMovieTicks: 44_100,
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('parses exact safe signed and unsigned version-one scalars beyond int32', () => {
      expect(parseM4aEditList(editList(1))).toEqual({
        mediaTimeCoreFrames: 0x1_0000_0400,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
        segmentDurationMovieTicks: 0x1_0000_ac44,
      });
    });

    it('preserves the exact positive int32 boundary for media time', () => {
      expect(parseM4aEditList(editList(0, { mediaTime: 0x7fff_ffffn }))).toMatchObject({
        mediaTimeCoreFrames: 0x7fff_ffff,
      });
    });

    it.each([
      ['flags', mutate(editList(0), 3), /flags must be zero/i],
      ['entry count zero', editList(0, { entryCount: 0 }), /exactly one edit entry/i],
      ['entry count two', editList(0, { entryCount: 2 }), /exactly one edit entry/i],
      ['zero duration', editList(0, { segmentDuration: 0n }), /duration must be a positive/i],
      ['empty edit', editList(0, { mediaTime: -1n }), /media time must be a non-negative/i],
      [
        'negative media time',
        editList(0, { mediaTime: -2n }),
        /media time must be a non-negative/i,
      ],
      ['integer rate', editList(0, { rateInteger: 0 }), /media rate must be exactly 1\.0/i],
      ['fractional rate', editList(0, { rateFraction: 1 }), /media rate must be exactly 1\.0/i],
    ])('rejects a noncanonical %s', (_name, bytes, expected) => {
      expect(() => parseM4aEditList(bytes)).toThrow(expected);
    });

    it.each([
      ['segment duration', editList(1, { segmentDuration: MAX_SAFE_BIGINT + 1n })],
      ['positive media time', editList(1, { mediaTime: MAX_SAFE_BIGINT + 1n })],
      ['negative media time', editList(1, { mediaTime: -MAX_SAFE_BIGINT - 1n })],
    ])('rejects an unsafe version-one %s', (_name, bytes) => {
      expect(() => parseM4aEditList(bytes)).toThrow(/exceeds.*safe-integer/i);
    });
  });

  describe('exact payload and hostile-input boundaries', () => {
    const fixtures = [
      ['mvhd v0', movieHeader(0), parseM4aMovieHeader],
      ['mvhd v1', movieHeader(1), parseM4aMovieHeader],
      ['mdhd v0', mediaHeader(0), parseM4aMediaHeader],
      ['mdhd v1', mediaHeader(1), parseM4aMediaHeader],
      ['tkhd v0', trackHeader(0), parseM4aTrackHeader],
      ['tkhd v1', trackHeader(1), parseM4aTrackHeader],
      ['hdlr', handlerHeader(), parseM4aHandlerHeader],
      ['elst v0', editList(0), parseM4aEditList],
      ['elst v1', editList(1), parseM4aEditList],
    ] as const;

    it.each(fixtures)('rejects truncated and overlong %s payloads', (_name, bytes, parse) => {
      expect(() => parse(bytes.slice(0, -1))).toThrow(/exactly .* bytes/i);
      const overlong = new Uint8Array(bytes.byteLength + 1);
      overlong.set(bytes);
      expect(() => parse(overlong)).toThrow(/exactly .* bytes/i);
    });

    it.each(fixtures)('rejects unsupported %s FullBox versions', (_name, bytes, parse) => {
      const wrongVersion = bytes.slice();
      wrongVersion[0] = 2;
      expect(() => parse(wrongVersion)).toThrow(/version must be (?:0 or 1|zero)/i);
    });

    it.each(fixtures)(
      'rejects proxied %s views without touching their traps',
      (_name, bytes, parse) => {
        let trapCalls = 0;
        const hostile = new Proxy(bytes, {
          get() {
            trapCalls += 1;
            throw new Error('hostile getter should not run');
          },
        });
        expect(() => parse(hostile)).toThrow(/readable Uint8Array/i);
        expect(trapCalls).toBe(0);
      },
    );

    it.each(fixtures)('rejects shared %s payloads', (_name, bytes, parse) => {
      const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
      shared.set(bytes);
      expect(() => parse(shared)).toThrow(/non-shared/i);
    });

    it.each(fixtures)('rejects detached %s payloads', (_name, bytes, parse) => {
      const detached = bytes.slice();
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      expect(() => parse(detached)).toThrow(M4aFixedBoxError);
    });

    it.each(fixtures)('uses an intrinsic-owned snapshot for %s', (_name, bytes, parse) => {
      class DerivedBytes extends Uint8Array {}
      const derived = new DerivedBytes(bytes);
      const result = parse(derived);
      derived.fill(0xff);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
