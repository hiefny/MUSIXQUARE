import { describe, expect, it } from 'vitest';

import {
  ADTS_AAC_LC_TIMELINE_POINT_BYTES,
  CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
  CODEC_TIMELINE_MANIFEST_MAX_BYTES,
  CODEC_TIMELINE_MANIFEST_MAX_POINTS,
  MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES,
  encodeCodecTimelineManifest,
  parseCodecTimelineManifest,
  type AdtsAacLcTimelineManifest,
  type Mp3NoFrameCountTimelineManifest,
} from '../codec-timeline-manifest.ts';

const HEADER = {
  version: 8,
  codec: 10,
  flags: 11,
  headerBytes: 12,
  recordBytes: 14,
  pointCount: 16,
  reserved: 20,
  sourceBinding: 24,
  sourceSize: 56,
  audioStart: 64,
  audioEnd: 72,
  frameCount: 80,
  sampleRate: 88,
  samplesPerFrame: 92,
  channels: 94,
  commonReservedByte: 95,
  codecConfiguration: 96,
} as const;

function digest(): number[] {
  return Array.from({ length: 32 }, (_, index) => index);
}

function adtsManifest(patch: Partial<AdtsAacLcTimelineManifest> = {}): AdtsAacLcTimelineManifest {
  return {
    manifestVersion: 1,
    codec: 'adts-aac-lc',
    sourceBindingSha256: digest(),
    sourceSize: 24,
    audioStartByte: 0,
    audioEndByte: 24,
    frameCount: 3,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_024,
    channels: 2,
    mpegId: 0,
    profile: 1,
    audioObjectType: 2,
    sampleRateIndex: 4,
    channelConfiguration: 2,
    protectionAbsent: true,
    rawDataBlocks: 1,
    points: [
      { frameOrdinal: 0, byteOffset: 0 },
      { frameOrdinal: 1, byteOffset: 8 },
      { frameOrdinal: 2, byteOffset: 16 },
    ],
    ...patch,
  };
}

function mp3Manifest(
  patch: Partial<Mp3NoFrameCountTimelineManifest> = {},
): Mp3NoFrameCountTimelineManifest {
  return {
    manifestVersion: 1,
    codec: 'mp3-no-frame-count',
    sourceBindingSha256: digest(),
    sourceSize: 300,
    audioStartByte: 12,
    audioEndByte: 300,
    frameCount: 3,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_152,
    channels: 2,
    mpegVersion: '1',
    layer: 3,
    hasFrameCountDeclaration: false,
    points: [
      { frameOrdinal: 0, byteOffset: 12, mainDataCapacityBytes: 75, mainDataBeginBytes: 0 },
      { frameOrdinal: 1, byteOffset: 108, mainDataCapacityBytes: 75, mainDataBeginBytes: 5 },
      { frameOrdinal: 2, byteOffset: 204, mainDataCapacityBytes: 75, mainDataBeginBytes: 10 },
    ],
    ...patch,
  };
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function mutate(
  bytes: Uint8Array,
  callback: (copy: Uint8Array, view: DataView) => void,
): Uint8Array {
  const copy = bytes.slice();
  callback(copy, dataView(copy));
  return copy;
}

function setUint64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(offset + 4, value >>> 0, false);
}

describe('codec timeline manifest canonical binary codec', () => {
  it('round-trips canonical ADTS AAC-LC and MP3 no-frame-count manifests', () => {
    for (const manifest of [adtsManifest(), mp3Manifest()]) {
      const encoded = encodeCodecTimelineManifest(manifest);
      const parsed = parseCodecTimelineManifest(encoded);

      expect(parsed).toEqual(manifest);
      expect(parsed).not.toBe(manifest);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.sourceBindingSha256)).toBe(true);
      expect(Object.isFrozen(parsed.points)).toBe(true);
      expect(parsed.points.every(Object.isFrozen)).toBe(true);
      expect(encodeCodecTimelineManifest(parsed)).toEqual(encoded);
    }
  });

  it('writes exact fixed-width, big-endian headers and point records', () => {
    const adts = encodeCodecTimelineManifest(adtsManifest());
    const adtsView = dataView(adts);
    expect(Array.from(adts.subarray(0, 8))).toEqual([
      0x4d, 0x58, 0x51, 0x52, 0x43, 0x54, 0x4d, 0x31,
    ]);
    expect(adtsView.getUint16(HEADER.version, false)).toBe(1);
    expect(adtsView.getUint16(HEADER.headerBytes, false)).toBe(
      CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
    );
    expect(adtsView.getUint16(HEADER.recordBytes, false)).toBe(ADTS_AAC_LC_TIMELINE_POINT_BYTES);
    expect(adts.byteLength).toBe(
      CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 3 * ADTS_AAC_LC_TIMELINE_POINT_BYTES,
    );
    expect(
      adtsView.getUint32(
        CODEC_TIMELINE_MANIFEST_HEADER_BYTES + ADTS_AAC_LC_TIMELINE_POINT_BYTES + 12,
        false,
      ),
    ).toBe(8);

    const mp3 = encodeCodecTimelineManifest(mp3Manifest());
    const mp3View = dataView(mp3);
    expect(mp3View.getUint16(HEADER.recordBytes, false)).toBe(
      MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES,
    );
    expect(mp3.byteLength).toBe(
      CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 3 * MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES,
    );
    expect(mp3View.getUint16(CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 16, false)).toBe(75);
    expect(mp3View.getUint32(CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 20, false)).toBe(0);
  });

  it('accepts the maximum retained-point count while remaining below 256 KiB', () => {
    const adtsPoints = Array.from({ length: CODEC_TIMELINE_MANIFEST_MAX_POINTS }, (_, index) => ({
      frameOrdinal: index,
      byteOffset: index * 8,
    }));
    const adts = encodeCodecTimelineManifest(
      adtsManifest({
        sourceSize: CODEC_TIMELINE_MANIFEST_MAX_POINTS * 8,
        audioEndByte: CODEC_TIMELINE_MANIFEST_MAX_POINTS * 8,
        frameCount: CODEC_TIMELINE_MANIFEST_MAX_POINTS,
        points: adtsPoints,
      }),
    );

    expect(adts.byteLength).toBe(
      CODEC_TIMELINE_MANIFEST_HEADER_BYTES +
        CODEC_TIMELINE_MANIFEST_MAX_POINTS * ADTS_AAC_LC_TIMELINE_POINT_BYTES,
    );
    expect(adts.byteLength).toBeLessThanOrEqual(CODEC_TIMELINE_MANIFEST_MAX_BYTES);
    expect(parseCodecTimelineManifest(adts).points).toHaveLength(
      CODEC_TIMELINE_MANIFEST_MAX_POINTS,
    );

    const mp3Points = Array.from({ length: CODEC_TIMELINE_MANIFEST_MAX_POINTS }, (_, index) => ({
      frameOrdinal: index,
      byteOffset: 12 + index * 96,
      mainDataCapacityBytes: 75,
      mainDataBeginBytes: index === 0 ? 0 : 1,
    }));
    const mp3 = encodeCodecTimelineManifest(
      mp3Manifest({
        sourceSize: 12 + CODEC_TIMELINE_MANIFEST_MAX_POINTS * 96,
        audioEndByte: 12 + CODEC_TIMELINE_MANIFEST_MAX_POINTS * 96,
        frameCount: CODEC_TIMELINE_MANIFEST_MAX_POINTS,
        points: mp3Points,
      }),
    );
    expect(mp3.byteLength).toBe(
      CODEC_TIMELINE_MANIFEST_HEADER_BYTES +
        CODEC_TIMELINE_MANIFEST_MAX_POINTS * MP3_NO_FRAME_COUNT_TIMELINE_POINT_BYTES,
    );
    expect(mp3.byteLength).toBeLessThanOrEqual(CODEC_TIMELINE_MANIFEST_MAX_BYTES);
    expect(parseCodecTimelineManifest(mp3).points).toHaveLength(CODEC_TIMELINE_MANIFEST_MAX_POINTS);

    expect(() =>
      encodeCodecTimelineManifest(
        adtsManifest({
          frameCount: CODEC_TIMELINE_MANIFEST_MAX_POINTS + 1,
          sourceSize: (CODEC_TIMELINE_MANIFEST_MAX_POINTS + 1) * 8,
          audioEndByte: (CODEC_TIMELINE_MANIFEST_MAX_POINTS + 1) * 8,
          points: [
            ...adtsPoints,
            {
              frameOrdinal: CODEC_TIMELINE_MANIFEST_MAX_POINTS,
              byteOffset: CODEC_TIMELINE_MANIFEST_MAX_POINTS * 8,
            },
          ],
        }),
      ),
    ).toThrow(/8192/i);
  });

  it('preserves safe uint64 coordinates near Number.MAX_SAFE_INTEGER and rejects 2^53', () => {
    const sourceSize = Number.MAX_SAFE_INTEGER;
    const audioStartByte = sourceSize - 288;
    const nearLimit = mp3Manifest({
      sourceSize,
      audioStartByte,
      audioEndByte: sourceSize,
      points: [
        {
          frameOrdinal: 0,
          byteOffset: audioStartByte,
          mainDataCapacityBytes: 75,
          mainDataBeginBytes: 0,
        },
        {
          frameOrdinal: 1,
          byteOffset: audioStartByte + 96,
          mainDataCapacityBytes: 75,
          mainDataBeginBytes: 1,
        },
        {
          frameOrdinal: 2,
          byteOffset: audioStartByte + 192,
          mainDataCapacityBytes: 75,
          mainDataBeginBytes: 1,
        },
      ],
    });
    expect(parseCodecTimelineManifest(encodeCodecTimelineManifest(nearLimit))).toEqual(nearLimit);
    expect(() => encodeCodecTimelineManifest({ ...nearLimit, sourceSize: 2 ** 53 })).toThrow(
      /safe-integer/i,
    );

    const over = mutate(encodeCodecTimelineManifest(mp3Manifest()), (_copy, view) => {
      view.setUint32(HEADER.sourceSize, 0x20_0000, false);
      view.setUint32(HEADER.sourceSize + 4, 0, false);
    });
    expect(() => parseCodecTimelineManifest(over)).toThrow(/MAX_SAFE_INTEGER/i);
  });

  it.each([
    ['magic', 0, 0],
    ['version', HEADER.version + 1, 2],
    ['codec', HEADER.codec, 99],
    ['flags', HEADER.flags, 1],
    ['header size', HEADER.headerBytes + 1, 127],
    ['record size', HEADER.recordBytes + 1, 15],
    ['common reserved field', HEADER.reserved, 1],
    ['common reserved byte', HEADER.commonReservedByte, 1],
    ['ADTS reserved field', HEADER.codecConfiguration + 7, 1],
  ])('rejects malformed %s bytes', (_label, offset, byte) => {
    const encoded = encodeCodecTimelineManifest(adtsManifest());
    encoded[offset] = byte;
    expect(() => parseCodecTimelineManifest(encoded)).toThrow();
  });

  it('rejects zero, excessive, truncated, trailing, and oversized record layouts', () => {
    const encoded = encodeCodecTimelineManifest(adtsManifest());
    expect(() =>
      parseCodecTimelineManifest(
        mutate(encoded, (_copy, view) => view.setUint32(HEADER.pointCount, 0, false)),
      ),
    ).toThrow(/point count/i);
    expect(() =>
      parseCodecTimelineManifest(
        mutate(encoded, (_copy, view) =>
          view.setUint32(HEADER.pointCount, CODEC_TIMELINE_MANIFEST_MAX_POINTS + 1, false),
        ),
      ),
    ).toThrow(/point count/i);
    expect(() => parseCodecTimelineManifest(encoded.subarray(0, encoded.length - 1))).toThrow(
      /length/i,
    );
    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);
    expect(() => parseCodecTimelineManifest(trailing)).toThrow(/length/i);
    expect(() =>
      parseCodecTimelineManifest(new Uint8Array(CODEC_TIMELINE_MANIFEST_MAX_BYTES + 1)),
    ).toThrow(/bounded/i);
  });

  it.each([
    ['MPEG id', HEADER.codecConfiguration, 1],
    ['profile', HEADER.codecConfiguration + 1, 0],
    ['audio object type', HEADER.codecConfiguration + 2, 3],
    ['sample-rate index', HEADER.codecConfiguration + 3, 13],
    ['channel configuration', HEADER.codecConfiguration + 4, 1],
    ['CRC mode', HEADER.codecConfiguration + 5, 0],
    ['raw block count', HEADER.codecConfiguration + 6, 2],
  ])('rejects noncanonical ADTS %s', (_label, offset, byte) => {
    const encoded = encodeCodecTimelineManifest(adtsManifest());
    encoded[offset] = byte;
    expect(() => parseCodecTimelineManifest(encoded)).toThrow(/ADTS/i);
  });

  it('rejects noncanonical ADTS anchors, ordering, and frame geometry', () => {
    expect(() =>
      encodeCodecTimelineManifest(
        adtsManifest({
          points: [
            { frameOrdinal: 1, byteOffset: 0 },
            { frameOrdinal: 2, byteOffset: 16 },
          ],
        }),
      ),
    ).toThrow(/begin/i);
    expect(() =>
      encodeCodecTimelineManifest(
        adtsManifest({
          points: [
            { frameOrdinal: 0, byteOffset: 1 },
            { frameOrdinal: 2, byteOffset: 16 },
          ],
        }),
      ),
    ).toThrow(/begin/i);
    expect(() =>
      encodeCodecTimelineManifest(
        adtsManifest({
          points: [
            { frameOrdinal: 0, byteOffset: 0 },
            { frameOrdinal: 1, byteOffset: 8 },
          ],
        }),
      ),
    ).toThrow(/terminal/i);
    expect(() =>
      encodeCodecTimelineManifest(
        adtsManifest({
          points: [
            { frameOrdinal: 0, byteOffset: 0 },
            { frameOrdinal: 1, byteOffset: 8 },
            { frameOrdinal: 2, byteOffset: 8 },
          ],
        }),
      ),
    ).toThrow(/increasing/i);
    expect(() =>
      encodeCodecTimelineManifest(adtsManifest({ sourceSize: 23, audioEndByte: 23 })),
    ).toThrow(/span|geometry/i);
  });

  it.each([
    ['MPEG version', HEADER.codecConfiguration, 0],
    ['layer', HEADER.codecConfiguration + 1, 2],
    ['frame-count flag', HEADER.codecConfiguration + 2, 0],
    ['header reserved field', HEADER.codecConfiguration + 3, 1],
  ])('rejects noncanonical MP3 %s', (_label, offset, byte) => {
    const encoded = encodeCodecTimelineManifest(mp3Manifest());
    encoded[offset] = byte;
    expect(() => parseCodecTimelineManifest(encoded)).toThrow();
  });

  it('rejects MP3 record reserved fields, reservoir bounds, and impossible capacities', () => {
    const encoded = encodeCodecTimelineManifest(mp3Manifest());
    expect(() =>
      parseCodecTimelineManifest(
        mutate(encoded, (_copy, view) =>
          view.setUint32(CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 20, 1, false),
        ),
      ),
    ).toThrow(/reserved/i);
    expect(() =>
      parseCodecTimelineManifest(
        mutate(encoded, (_copy, view) =>
          view.setUint16(CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 18, 1, false),
        ),
      ),
    ).toThrow(/frame zero/i);
    expect(() =>
      encodeCodecTimelineManifest(
        mp3Manifest({
          mpegVersion: '2',
          sampleRateHz: 22_050,
          samplesPerFrame: 576,
          points: [
            { frameOrdinal: 0, byteOffset: 12, mainDataCapacityBytes: 75, mainDataBeginBytes: 0 },
            {
              frameOrdinal: 1,
              byteOffset: 108,
              mainDataCapacityBytes: 75,
              mainDataBeginBytes: 256,
            },
            { frameOrdinal: 2, byteOffset: 204, mainDataCapacityBytes: 75, mainDataBeginBytes: 1 },
          ],
        }),
      ),
    ).toThrow(/version bound/i);
    expect(() =>
      encodeCodecTimelineManifest(
        mp3Manifest({
          points: [
            { frameOrdinal: 0, byteOffset: 12, mainDataCapacityBytes: 74, mainDataBeginBytes: 0 },
            { frameOrdinal: 1, byteOffset: 108, mainDataCapacityBytes: 75, mainDataBeginBytes: 1 },
            { frameOrdinal: 2, byteOffset: 204, mainDataCapacityBytes: 75, mainDataBeginBytes: 1 },
          ],
        }),
      ),
    ).toThrow(/capacity/i);
  });

  it('rejects inconsistent MP3 version/sample geometry and source spans', () => {
    expect(() =>
      encodeCodecTimelineManifest(
        mp3Manifest({ mpegVersion: '2', sampleRateHz: 44_100, samplesPerFrame: 576 }),
      ),
    ).toThrow(/canonical Layer III/i);
    expect(() => encodeCodecTimelineManifest(mp3Manifest({ audioStartByte: 300 }))).toThrow(
      /audio span/i,
    );
    expect(() => encodeCodecTimelineManifest(mp3Manifest({ frameCount: 4 }))).toThrow(
      /terminal|span/i,
    );
  });

  it('snapshots encode input without getters, mutation, or extra shape', () => {
    const input = adtsManifest();
    const before = JSON.stringify(input);
    encodeCodecTimelineManifest(input);
    expect(JSON.stringify(input)).toBe(before);

    let getterReads = 0;
    Object.defineProperty(input, 'sourceSize', {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return 24;
      },
    });
    expect(() => encodeCodecTimelineManifest(input)).toThrow(/data property/i);
    expect(getterReads).toBe(0);

    expect(() => encodeCodecTimelineManifest({ ...adtsManifest(), extra: true })).toThrow(
      /extra fields/i,
    );
    expect(() =>
      encodeCodecTimelineManifest(
        new Proxy(adtsManifest(), {
          ownKeys: () => {
            throw new Error('trap');
          },
        }),
      ),
    ).toThrow(/snapshotted/i);
  });

  it('copies parse input and produces fresh immutable graphs', () => {
    const encoded = encodeCodecTimelineManifest(mp3Manifest());
    const storage = new Uint8Array(encoded.byteLength + 10);
    storage.set(encoded, 5);
    const view = storage.subarray(5, 5 + encoded.byteLength);
    const first = parseCodecTimelineManifest(view);
    const second = parseCodecTimelineManifest(view);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.points).not.toBe(second.points);
    expect(first.sourceBindingSha256).not.toBe(second.sourceBindingSha256);

    view.fill(0);
    expect(first.codec).toBe('mp3-no-frame-count');
    expect(first.sourceBindingSha256).toEqual(digest());
    expect(first.points[0]).toMatchObject({ frameOrdinal: 0, byteOffset: 12 });
  });

  it('rejects shared and detached typed-array storage', () => {
    const encoded = encodeCodecTimelineManifest(adtsManifest());
    if (typeof SharedArrayBuffer === 'function') {
      const shared = new Uint8Array(new SharedArrayBuffer(encoded.byteLength));
      shared.set(encoded);
      expect(() => parseCodecTimelineManifest(shared)).toThrow(/non-shared storage/i);
    }

    const detached = encoded.slice();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => parseCodecTimelineManifest(detached)).toThrow(/storage|copied|truncated/i);
  });

  it('rejects non-Uint8Array inputs without consulting iterators', () => {
    let iteratorReads = 0;
    const value = {
      get [Symbol.iterator]() {
        iteratorReads += 1;
        return function* () {
          yield 1;
        };
      },
    };
    expect(() => parseCodecTimelineManifest(value)).toThrow(/Uint8Array/i);
    expect(iteratorReads).toBe(0);
    expect(() => parseCodecTimelineManifest(new DataView(new ArrayBuffer(128)))).toThrow(
      /Uint8Array/i,
    );
  });

  it('rejects forged uint64 point coordinates and exact-EOF violations', () => {
    const encoded = encodeCodecTimelineManifest(adtsManifest());
    expect(() =>
      parseCodecTimelineManifest(
        mutate(encoded, (_copy, view) => {
          view.setUint32(CODEC_TIMELINE_MANIFEST_HEADER_BYTES, 0x20_0000, false);
          view.setUint32(CODEC_TIMELINE_MANIFEST_HEADER_BYTES + 4, 0, false);
        }),
      ),
    ).toThrow(/MAX_SAFE_INTEGER/i);
    expect(() =>
      parseCodecTimelineManifest(
        mutate(encoded, (_copy, view) => setUint64(view, HEADER.audioEnd, 25)),
      ),
    ).toThrow(/contained|canonical/i);
  });
});
