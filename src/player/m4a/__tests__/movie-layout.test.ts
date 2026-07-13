import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { M4A_MAX_TRACK_BOXES, readM4aMovieLayout } from '../movie-layout.ts';

const IDENTITY_MATRIX = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] as const;

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type: string, body = new Uint8Array(0)): Uint8Array {
  if (type.length !== 4) throw new Error('Fixture type must contain four characters');
  const result = new Uint8Array(8 + body.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(body, 8);
  return result;
}

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

function movieHeader(version: 0 | 1, duration = 6_000): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 100 : 112);
  const view = writeFullBox(bytes, version);
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  const rateOffset = version === 0 ? 20 : 32;
  const matrixOffset = version === 0 ? 36 : 48;
  const nextTrackIdOffset = version === 0 ? 96 : 108;
  view.setUint32(timescaleOffset, 1_000, false);
  if (version === 0) view.setUint32(durationOffset, duration, false);
  else view.setBigUint64(durationOffset, BigInt(duration), false);
  view.setUint32(rateOffset, 0x0001_0000, false);
  view.setUint16(rateOffset + 4, 0x0100, false);
  writeIdentityMatrix(view, matrixOffset);
  view.setUint32(nextTrackIdOffset, 3, false);
  return bytes;
}

function trackHeader(version: 0 | 1, duration = 0, flags = 3): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 84 : 96);
  const view = writeFullBox(bytes, version, flags);
  const trackIdOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 20 : 28;
  const matrixOffset = version === 0 ? 40 : 52;
  view.setUint32(trackIdOffset, 2, false);
  if (version === 0) view.setUint32(durationOffset, duration, false);
  else view.setBigUint64(durationOffset, BigInt(duration), false);
  view.setInt16(version === 0 ? 36 : 48, 0x0100, false);
  writeIdentityMatrix(view, matrixOffset);
  return bytes;
}

function mediaHeader(version: 0 | 1): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 24 : 36);
  const view = writeFullBox(bytes, version);
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  view.setUint32(timescaleOffset, 48_000, false);
  if (version === 0) view.setUint32(durationOffset, 96_000, false);
  else view.setBigUint64(durationOffset, 96_000n, false);
  view.setUint16(version === 0 ? 20 : 32, 0x55c4, false);
  return bytes;
}

function handlerBody(handlerType: string, name = new Uint8Array(0)): Uint8Array {
  const bytes = new Uint8Array(24 + name.byteLength);
  writeFullBox(bytes, 0);
  for (let index = 0; index < 4; index += 1) {
    bytes[8 + index] = handlerType.charCodeAt(index);
  }
  bytes.set(name, 24);
  return bytes;
}

function editList(version: 0 | 1, duration = 6_000, mediaTime = 1_024): Uint8Array {
  const bytes = new Uint8Array(version === 0 ? 20 : 28);
  const view = writeFullBox(bytes, version);
  view.setUint32(4, 1, false);
  if (version === 0) {
    view.setUint32(8, duration, false);
    view.setInt32(12, mediaTime, false);
    view.setInt16(16, 1, false);
  } else {
    view.setBigUint64(8, BigInt(duration), false);
    view.setBigInt64(16, BigInt(mediaTime), false);
    view.setInt16(24, 1, false);
  }
  return bytes;
}

function selfContainedDataReference(
  entryType = 'url ',
  urlPayload = Uint8Array.of(0, 0, 0, 1),
  entryCount = 1,
  suffix = new Uint8Array(0),
): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(4, entryCount, false);
  return box('dref', concatenate(header, box(entryType, urlPayload), suffix));
}

function soundMediaHeader(bytes = new Uint8Array(8)): Uint8Array {
  return box('smhd', bytes);
}

function mediaInformation(
  options: {
    readonly smhd?: Uint8Array | null;
    readonly dinf?: Uint8Array | null;
    readonly stbl?: Uint8Array | null;
    readonly extra?: readonly Uint8Array[];
  } = {},
): Uint8Array {
  const smhd = options.smhd === undefined ? soundMediaHeader() : options.smhd;
  const dinf =
    options.dinf === undefined ? box('dinf', selfContainedDataReference()) : options.dinf;
  const stbl = options.stbl === undefined ? box('stbl') : options.stbl;
  return box(
    'minf',
    concatenate(
      ...(smhd === null ? [] : [smhd]),
      ...(dinf === null ? [] : [dinf]),
      ...(stbl === null ? [] : [stbl]),
      ...(options.extra ?? []),
    ),
  );
}

function audioTrack(
  options: {
    readonly version?: 0 | 1;
    readonly duration?: number;
    readonly flags?: number;
    readonly edit?: Uint8Array | null;
    readonly minf?: Uint8Array | null;
    readonly handler?: Uint8Array;
    readonly trackExtra?: readonly Uint8Array[];
    readonly mediaExtra?: readonly Uint8Array[];
    readonly omitTrackHeader?: boolean;
    readonly omitMediaHeader?: boolean;
  } = {},
): Uint8Array {
  const version = options.version ?? 0;
  const edit = options.edit === undefined ? null : options.edit;
  const minf = options.minf === undefined ? mediaInformation() : options.minf;
  const mediaChildren = concatenate(
    ...(options.omitMediaHeader ? [] : [box('mdhd', mediaHeader(version))]),
    box('hdlr', options.handler ?? handlerBody('soun')),
    ...(minf === null ? [] : [minf]),
    ...(options.mediaExtra ?? []),
  );
  return box(
    'trak',
    concatenate(
      ...(options.omitTrackHeader
        ? []
        : [box('tkhd', trackHeader(version, options.duration ?? 0, options.flags ?? 3))]),
      box('mdia', mediaChildren),
      ...(edit === null ? [] : [box('edts', edit)]),
      ...(options.trackExtra ?? []),
    ),
  );
}

function videoTrack(markers = { tkhd: 0xa1, mdhd: 0xa2, minf: 0xa3 }): Uint8Array {
  return box(
    'trak',
    concatenate(
      box('tkhd', Uint8Array.of(markers.tkhd)),
      box(
        'mdia',
        concatenate(
          box('mdhd', Uint8Array.of(markers.mdhd)),
          box('hdlr', handlerBody('vide')),
          box('minf', Uint8Array.of(markers.minf)),
        ),
      ),
    ),
  );
}

function movie(...children: readonly Uint8Array[]): Uint8Array {
  return box('moov', concatenate(...children));
}

class MemorySource implements EncodedRandomAccessSource {
  identity = 'm4a-movie-layout-fixture';
  readonly reads: ReadRecord[] = [];
  mutateIdentityAfterRead = false;

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    const result = this.bytes.slice(offset, end);
    if (this.mutateIdentityAfterRead) this.identity = 'mutated-m4a-movie-layout-fixture';
    return result;
  }

  async close(): Promise<void> {}
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function findMoov(reader: IsoBmffBoxReader, abortSignal = signal()) {
  const cursor = reader.createCursor();
  for (;;) {
    const ref = await cursor.next(abortSignal);
    if (ref === null) throw new Error('Fixture moov is missing');
    if (ref.type === 'moov') return ref;
  }
}

async function parseFixture(bytes: Uint8Array) {
  const source = new MemorySource(bytes);
  const reader = new IsoBmffBoxReader(source);
  const moov = await findMoov(reader);
  return {
    source,
    reader,
    moov,
    layout: await readM4aMovieLayout(reader, moov, signal()),
  };
}

function readTouches(read: ReadRecord, offset: number): boolean {
  return read.offset <= offset && offset < read.offset + read.length;
}

describe('M4A movie/audio-track structural layout', () => {
  it.each([
    ['fast', concatenate(movie(box('mvhd', movieHeader(0)), audioTrack()), box('mdat'))],
    [
      'tail',
      concatenate(box('free'), box('mdat'), movie(audioTrack(), box('mvhd', movieHeader(0)))),
    ],
  ])(
    'parses a %s-position moov reference and freezes the retained layout',
    async (_name, bytes) => {
      const { layout, reader } = await parseFixture(bytes);

      expect(layout).toMatchObject({
        movieHeader: { version: 0, movieTimescale: 1_000, movieDurationMovieTicks: 6_000 },
        audioTrack: {
          trackHeader: { version: 0, flags: 3, trackId: 2 },
          mediaHeader: { version: 0, mediaTimescale: 48_000 },
          edit: null,
          stbl: { type: 'stbl' },
        },
        metadataRoot: null,
      });
      expect(Object.isFrozen(layout)).toBe(true);
      expect(Object.isFrozen(layout.audioTrack)).toBe(true);
      expect(() =>
        new IsoBmffBoxReader(new MemorySource(bytes)).createChildCursor(layout.audioTrack.stbl),
      ).toThrow(/not issued by this reader/);
      expect(() => reader.createChildCursor(layout.audioTrack.stbl)).not.toThrow();
    },
  );

  it.each([0, 1] as const)(
    'accepts exact version-%s fixed boxes and one matching edit',
    async (version) => {
      const edit = box('elst', editList(version, 6_000));
      const { layout } = await parseFixture(
        movie(
          box('mvhd', movieHeader(version)),
          box('free'),
          audioTrack({ version, duration: 6_000, edit }),
          box('iods'),
          box('udta', Uint8Array.of(0xfa, 0xfb)),
          box('skip'),
        ),
      );

      expect(layout.movieHeader.version).toBe(version);
      expect(layout.audioTrack.trackHeader.version).toBe(version);
      expect(layout.audioTrack.mediaHeader.version).toBe(version);
      expect(layout.audioTrack.edit).toEqual({
        mediaTimeCoreFrames: 1_024,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
        segmentDurationMovieTicks: 6_000,
      });
      expect(layout.metadataRoot?.type).toBe('udta');
    },
  );

  it('identifies a video track from hdlr without reading its fixed or minf bodies', async () => {
    const bytes = movie(box('mvhd', movieHeader(0)), videoTrack(), audioTrack());
    const { source, layout } = await parseFixture(bytes);
    const markerOffsets = [bytes.indexOf(0xa1), bytes.indexOf(0xa2), bytes.indexOf(0xa3)];

    expect(layout.audioTrack.trackHeader.trackId).toBe(2);
    for (const markerOffset of markerOffsets) {
      expect(markerOffset).toBeGreaterThan(0);
      expect(source.reads.some((read) => readTouches(read, markerOffset))).toBe(false);
    }
  });

  it('reads only the fixed hdlr prefix and skips an optional name body', async () => {
    const nameMarker = 0xe7;
    const bytes = movie(
      box('mvhd', movieHeader(0)),
      audioTrack({ handler: handlerBody('soun', Uint8Array.of(nameMarker, nameMarker)) }),
    );
    const { source } = await parseFixture(bytes);
    const nameOffset = bytes.indexOf(nameMarker);
    expect(nameOffset).toBeGreaterThan(0);
    expect(source.reads.some((read) => readTouches(read, nameOffset))).toBe(false);
  });

  it('requires exactly one selected audio track', async () => {
    for (const bytes of [
      movie(box('mvhd', movieHeader(0)), videoTrack()),
      movie(box('mvhd', movieHeader(0)), audioTrack(), audioTrack()),
    ]) {
      const source = new MemorySource(bytes);
      const reader = new IsoBmffBoxReader(source);
      await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
        /exactly one audio track/,
      );
    }
  });

  it('bounds the track count before traversing track bodies', async () => {
    const bytes = movie(
      box('mvhd', movieHeader(0)),
      ...Array.from({ length: M4A_MAX_TRACK_BOXES + 1 }, () => videoTrack()),
    );
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      /more than 64 tracks/,
    );
  });

  it.each([
    ['missing mvhd', movie(audioTrack()), /mvhd.*exactly once/],
    [
      'duplicate mvhd',
      movie(box('mvhd', movieHeader(0)), box('mvhd', movieHeader(0)), audioTrack()),
      /mvhd.*exactly once/,
    ],
    ['missing trak', movie(box('mvhd', movieHeader(0))), /at least one trak/],
    [
      'duplicate udta',
      movie(box('mvhd', movieHeader(0)), audioTrack(), box('udta'), box('udta')),
      /udta.*exactly once/,
    ],
    [
      'unknown moov child',
      movie(box('mvhd', movieHeader(0)), audioTrack(), box('meta')),
      /Unknown M4A moov box/,
    ],
  ])('rejects %s', async (_label, bytes, expected) => {
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      expected,
    );
  });

  it.each([
    ['missing tkhd', audioTrack({ omitTrackHeader: true }), /audio trak\/tkhd.*exactly once/],
    [
      'duplicate tkhd',
      audioTrack({ trackExtra: [box('tkhd', trackHeader(0))] }),
      /audio trak\/tkhd.*exactly once/,
    ],
    ['missing mdhd', audioTrack({ omitMediaHeader: true }), /audio mdia\/mdhd.*exactly once/],
    [
      'duplicate mdhd',
      audioTrack({ mediaExtra: [box('mdhd', mediaHeader(0))] }),
      /audio mdia\/mdhd.*exactly once/,
    ],
    ['missing minf', audioTrack({ minf: null }), /audio mdia\/minf.*exactly once/],
    [
      'duplicate minf',
      audioTrack({ mediaExtra: [mediaInformation()] }),
      /audio mdia\/minf.*exactly once/,
    ],
    ['missing mdia', box('trak', box('tkhd', trackHeader(0))), /trak\/mdia.*exactly once/],
    [
      'duplicate mdia',
      audioTrack({ trackExtra: [box('mdia', box('hdlr', handlerBody('vide')))] }),
      /trak\/mdia.*exactly once/,
    ],
    [
      'duplicate hdlr',
      audioTrack({ mediaExtra: [box('hdlr', handlerBody('soun'))] }),
      /mdia\/hdlr.*exactly once/,
    ],
  ])('rejects an audio structure with %s', async (_label, track, expected) => {
    const bytes = movie(box('mvhd', movieHeader(0)), track);
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      expected,
    );
  });

  it('rejects fragmented movie structure immediately without reading later fixed bodies', async () => {
    const marker = 0xd4;
    const bytes = movie(box('mvex'), box('mvhd', Uint8Array.of(marker)), audioTrack());
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      /Fragmented M4A movie box/,
    );
    const markerOffset = bytes.indexOf(marker);
    expect(source.reads.some((read) => readTouches(read, markerOffset))).toBe(false);
  });

  it.each([
    ['missing dinf', mediaInformation({ dinf: null }), /minf\/dinf.*exactly once/],
    ['missing stbl', mediaInformation({ stbl: null }), /minf\/stbl.*exactly once/],
    [
      'duplicate dinf',
      mediaInformation({ extra: [box('dinf', selfContainedDataReference())] }),
      /minf\/dinf.*exactly once/,
    ],
    ['duplicate stbl', mediaInformation({ extra: [box('stbl')] }), /minf\/stbl.*exactly once/],
    ['unknown minf', mediaInformation({ extra: [box('vmhd')] }), /Unknown M4A minf box/],
  ])('rejects %s', async (_label, minf, expected) => {
    const bytes = movie(box('mvhd', movieHeader(0)), audioTrack({ minf }));
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      expected,
    );
  });

  it.each([
    [
      'external urn',
      selfContainedDataReference('urn ', Uint8Array.of(0, 0, 0, 0)),
      /External M4A data reference/,
    ],
    [
      'external url',
      selfContainedDataReference('url ', Uint8Array.of(0, 0, 0, 0)),
      /self-contained/,
    ],
    [
      'wrong count',
      selfContainedDataReference('url ', Uint8Array.of(0, 0, 0, 1), 2),
      /declare exactly one entry/,
    ],
    [
      'extra entry',
      selfContainedDataReference(
        'url ',
        Uint8Array.of(0, 0, 0, 1),
        1,
        box('url ', Uint8Array.of(0, 0, 0, 1)),
      ),
      /exactly one self-contained url entry/,
    ],
  ])('rejects a %s data reference', async (_label, dref, expected) => {
    const minf = mediaInformation({ dinf: box('dinf', dref) });
    const bytes = movie(box('mvhd', movieHeader(0)), audioTrack({ minf }));
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      expected,
    );
  });

  it.each([
    ['flags', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0)],
    ['balance', Uint8Array.of(0, 0, 0, 0, 0, 1, 0, 0)],
    ['reserved', Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1)],
    ['length', new Uint8Array(7)],
  ])('rejects a bad smhd %s field', async (_label, smhdBody) => {
    const bytes = movie(
      box('mvhd', movieHeader(0)),
      audioTrack({ minf: mediaInformation({ smhd: soundMediaHeader(smhdBody) }) }),
    );
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      /smhd/,
    );
  });

  it.each([
    ['empty edts', box('edts'), /exactly one elst/],
    ['wrong child', box('free'), /exactly one elst/],
    ['second child', concatenate(box('elst', editList(0)), box('free')), /exactly one elst/],
  ])('rejects %s', async (_label, edit, expected) => {
    const bytes = movie(box('mvhd', movieHeader(0)), audioTrack({ edit }));
    const source = new MemorySource(bytes);
    const reader = new IsoBmffBoxReader(source);
    await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
      expected,
    );
  });

  it('rejects duplicate edits, disabled tracks, and mismatched nonzero durations', async () => {
    const cases = [
      audioTrack({
        edit: box('elst', editList(0)),
        trackExtra: [box('edts', box('elst', editList(0)))],
      }),
      audioTrack({ flags: 2 }),
      audioTrack({ duration: 5_999, edit: box('elst', editList(0, 6_000)) }),
    ];
    const expected = [/edts.*exactly once/, /enabled and present/, /duration must equal/];
    for (let index = 0; index < cases.length; index += 1) {
      const bytes = movie(box('mvhd', movieHeader(0)), cases[index]!);
      const source = new MemorySource(bytes);
      const reader = new IsoBmffBoxReader(source);
      await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
        expected[index],
      );
    }
  });

  it('rejects malformed or unsupported handlers', async () => {
    for (const handler of [
      new Uint8Array(23),
      handlerBody('soun').map((value, index) => (index === 3 ? 1 : value)),
    ]) {
      const bytes = movie(box('mvhd', movieHeader(0)), audioTrack({ handler }));
      const source = new MemorySource(bytes);
      const reader = new IsoBmffBoxReader(source);
      await expect(readM4aMovieLayout(reader, await findMoov(reader), signal())).rejects.toThrow(
        /hdlr|flags/,
      );
    }
  });

  it('authenticates moov provenance and rejects wrong parents before traversal', async () => {
    const bytes = movie(box('mvhd', movieHeader(0)), audioTrack());
    const source = new MemorySource(bytes);
    const first = new IsoBmffBoxReader(source);
    const foreign = await findMoov(first);
    await expect(
      readM4aMovieLayout(new IsoBmffBoxReader(source), foreign, signal()),
    ).rejects.toThrow(/not issued by this reader/);

    const wrongBytes = box('free');
    const wrongReader = new IsoBmffBoxReader(new MemorySource(wrongBytes));
    await expect(
      readM4aMovieLayout(wrongReader, await findFirst(wrongReader), signal()),
    ).rejects.toThrow(/must be a moov/);
  });

  it('preserves exact abort precedence and rejects source mutation', async () => {
    const bytes = movie(box('mvhd', movieHeader(0)), audioTrack());

    const abortedSource = new MemorySource(bytes);
    const abortedReader = new IsoBmffBoxReader(abortedSource);
    const moov = await findMoov(abortedReader);
    const controller = new AbortController();
    controller.abort(new DOMException('fixture-stop', 'AbortError'));
    await expect(readM4aMovieLayout(abortedReader, moov, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'fixture-stop',
    });

    const mutatedSource = new MemorySource(bytes);
    const mutatedReader = new IsoBmffBoxReader(mutatedSource);
    const mutableMoov = await findMoov(mutatedReader);
    mutatedSource.mutateIdentityAfterRead = true;
    await expect(readM4aMovieLayout(mutatedReader, mutableMoov, signal())).rejects.toThrow(
      /source changed/,
    );
  });
});

async function findFirst(reader: IsoBmffBoxReader) {
  const ref = await reader.createCursor().next(signal());
  if (ref === null) throw new Error('Fixture root is missing');
  return ref;
}
