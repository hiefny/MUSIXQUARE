import { describe, expect, it } from 'vitest';

import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  M4A_FTYP_MAX_BODY_BYTES,
  M4A_MAX_MDAT_BOXES,
  readM4aContainerLayout,
} from '../container-layout.ts';

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function writeType(bytes: Uint8Array, type: string): void {
  if (type.length !== 4) throw new Error('Fixture type must contain four characters');
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
}

function writeFourCc(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function header(type: string, size: number): Uint8Array {
  const headerBytes = type === 'uuid' ? 24 : 8;
  const bytes = new Uint8Array(headerBytes);
  new DataView(bytes.buffer).setUint32(0, size, false);
  writeType(bytes, type);
  if (type === 'uuid') bytes.fill(0x4d, 8);
  return bytes;
}

function largeHeader(type: string, size: number): Uint8Array {
  const bytes = new Uint8Array(type === 'uuid' ? 32 : 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, false);
  writeType(bytes, type);
  view.setBigUint64(8, BigInt(size), false);
  if (type === 'uuid') bytes.fill(0x61, 16);
  return bytes;
}

function box(type: string, body = new Uint8Array(0)): Uint8Array {
  const headerBytes = type === 'uuid' ? 24 : 8;
  return concatenate(header(type, headerBytes + body.byteLength), body);
}

function sizeZeroBox(type: string, body = new Uint8Array(0)): Uint8Array {
  return concatenate(header(type, 0), body);
}

function fileTypeBody(
  majorBrand = 'M4A ',
  minorVersion = 0x0000_0200,
  compatibleBrands: readonly string[] = ['M4A ', 'isom'],
): Uint8Array {
  const bytes = new Uint8Array(8 + compatibleBrands.length * 4);
  const view = new DataView(bytes.buffer);
  writeFourCc(bytes, 0, majorBrand);
  view.setUint32(4, minorVersion, false);
  compatibleBrands.forEach((brand, index) => writeFourCc(bytes, 8 + index * 4, brand));
  return bytes;
}

function ftyp(body = fileTypeBody()): Uint8Array {
  return box('ftyp', body);
}

function moov(...children: readonly Uint8Array[]): Uint8Array {
  return box('moov', concatenate(...children));
}

function mdat(payloadBytes = 4): Uint8Array {
  return box('mdat', new Uint8Array(payloadBytes));
}

class SparseSource implements EncodedRandomAccessSource {
  identity = 'm4a-layout-fixture';
  readonly reads: ReadRecord[] = [];
  closeCalls = 0;

  constructor(
    public size: number,
    private readonly regions: readonly SparseRegion[],
  ) {
    validateExactRead(size, 0, 0);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    const region = this.regions.find(
      (candidate) =>
        offset >= candidate.offset && end <= candidate.offset + candidate.bytes.byteLength,
    );
    if (!region) throw new Error(`No sparse fixture bytes for [${offset}, ${end})`);
    const start = offset - region.offset;
    return region.bytes.slice(start, start + length);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function sourceFrom(bytes: Uint8Array): SparseSource {
  return new SparseSource(bytes.byteLength, [{ offset: 0, bytes }]);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function read(bytes: Uint8Array) {
  const source = sourceFrom(bytes);
  const reader = new IsoBmffBoxReader(source);
  return {
    source,
    reader,
    layout: await readM4aContainerLayout(reader, signal()),
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('M4A top-level container layout', () => {
  it.each([
    ['fast-start', concatenate(ftyp(), moov(), mdat(5)), 24, 32, 40, 45],
    ['tail-moov', concatenate(ftyp(), mdat(5), moov()), 37, 45, 32, 37],
  ])(
    'maps a %s file and freezes its bounded manifest',
    async (_name, bytes, moovStart, moovEnd, mediaStart, mediaEnd) => {
      const { source, layout } = await read(bytes);

      expect(layout).toMatchObject({
        majorBrand: 'M4A ',
        minorVersion: 0x200,
        compatibleBrands: ['M4A ', 'isom'],
        moov: { type: 'moov', start: moovStart, end: moovEnd },
        mediaDataRanges: [{ start: mediaStart, end: mediaEnd }],
        ignoredTopLevelBoxCount: 0,
      });
      expect(Object.isFrozen(layout)).toBe(true);
      expect(Object.isFrozen(layout.compatibleBrands)).toBe(true);
      expect(Object.isFrozen(layout.mediaDataRanges)).toBe(true);
      expect(Object.isFrozen(layout.mediaDataRanges[0])).toBe(true);
      expect(source.closeCalls).toBe(0);
    },
  );

  it('jumps over a greater-than-5-GiB mdat and reads only headers plus ftyp', async () => {
    const fileType = ftyp();
    const mdatStart = fileType.byteLength;
    const mdatSize = 5 * 1_024 * 1_024 * 1_024 + 123;
    const moovStart = mdatStart + mdatSize;
    const movie = moov();
    const source = new SparseSource(moovStart + movie.byteLength, [
      { offset: 0, bytes: fileType },
      { offset: mdatStart, bytes: largeHeader('mdat', mdatSize) },
      { offset: moovStart, bytes: movie },
    ]);
    const layout = await readM4aContainerLayout(new IsoBmffBoxReader(source), signal());

    expect(layout.moov.start).toBe(moovStart);
    expect(layout.mediaDataRanges).toEqual([{ start: mdatStart + 16, end: moovStart }]);
    expect(source.reads).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: fileType.byteLength - 8 },
      { offset: mdatStart, length: 8 },
      { offset: mdatStart + 8, length: 8 },
      { offset: moovStart, length: 8 },
    ]);
  });

  it('retains multiple mdat payload ranges and requires only one to be non-empty', async () => {
    const bytes = concatenate(ftyp(), mdat(0), box('free'), mdat(3), moov());
    const { layout } = await read(bytes);

    expect(layout.mediaDataRanges).toEqual([
      { start: 32, end: 32 },
      { start: 48, end: 51 },
    ]);
    expect(layout.ignoredTopLevelBoxCount).toBe(1);
  });

  it('skips padding, uuid, and unknown top-level boxes by their exact ends', async () => {
    const bytes = concatenate(
      box('free', Uint8Array.of(1, 2)),
      ftyp(),
      box('uuid'),
      box('junk', new Uint8Array(17)),
      moov(),
      mdat(1),
    );
    const { layout } = await read(bytes);

    expect(layout.ignoredTopLevelBoxCount).toBe(3);
  });

  it('does not recognize a fake moov header inside mdat payload', async () => {
    const fakeMovie = moov(box('trak'));
    const bytes = concatenate(ftyp(), box('mdat', fakeMovie), moov());
    const { layout, source } = await read(bytes);

    expect(layout.moov.start).toBe(ftyp().byteLength + 8 + fakeMovie.byteLength);
    expect(source.reads.some((entry) => entry.offset === ftyp().byteLength + 8)).toBe(false);
  });

  it.each([
    ['ftyp', concatenate(ftyp(), ftyp(), moov(), mdat()), /more than one top-level ftyp/],
    ['moov', concatenate(ftyp(), moov(), moov(), mdat()), /more than one top-level moov/],
  ])('rejects a duplicate %s box', async (_name, bytes, message) => {
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(message);
  });

  it.each([
    ['ftyp', concatenate(moov(), mdat()), /ftyp box is missing/],
    ['moov', concatenate(ftyp(), mdat()), /moov box is missing/],
    ['mdat', concatenate(ftyp(), moov()), /mdat box is missing/],
  ])('rejects a missing %s box', async (_name, bytes, message) => {
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(message);
  });

  it.each([
    ['after moov', concatenate(moov(), ftyp(), mdat())],
    ['after mdat', concatenate(mdat(), ftyp(), moov())],
  ])('rejects ftyp %s', async (_name, bytes) => {
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(/ftyp must precede the first moov or mdat/);
  });

  it.each(['moof', 'mfra', 'sidx', 'styp'])('fails closed on top-level %s', async (type) => {
    const bytes = concatenate(ftyp(), box(type), moov(), mdat());
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(/fragmented or segmented/);
  });

  it('allows only a terminal size-zero mdat and still requires non-empty media data', async () => {
    const accepted = concatenate(ftyp(), moov(), sizeZeroBox('mdat', Uint8Array.of(1, 2, 3)));
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(accepted)), signal()),
    ).resolves.toMatchObject({ mediaDataRanges: [{ end: accepted.byteLength }] });

    const empty = concatenate(ftyp(), moov(), sizeZeroBox('mdat'));
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(empty)), signal()),
    ).rejects.toThrow(/no non-empty media-data payload/);

    const hiddenMovie = concatenate(ftyp(), sizeZeroBox('mdat', moov()));
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(hiddenMovie)), signal()),
    ).rejects.toThrow(/moov box is missing/);
  });

  it.each(['free', 'uuid', 'junk', 'moov', 'ftyp'])(
    'rejects a size-zero top-level %s',
    async (type) => {
      const bytes = concatenate(ftyp(), moov(), mdat(1), sizeZeroBox(type));
      await expect(
        readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
      ).rejects.toThrow(/size-zero top-level box/);
    },
  );

  it(`rejects more than ${M4A_MAX_MDAT_BOXES} media-data boxes`, async () => {
    const boxes = Array.from({ length: M4A_MAX_MDAT_BOXES + 1 }, () => mdat(1));
    const bytes = concatenate(ftyp(), moov(), ...boxes);
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(/more than 64 top-level mdat/);
  });

  it.each([
    ['short', new Uint8Array(7), /must contain 8 through 4096/],
    ['misaligned', new Uint8Array(9), /not a whole number/],
    ['oversized', new Uint8Array(M4A_FTYP_MAX_BODY_BYTES + 1), /must contain 8 through 4096/],
  ])('rejects a %s ftyp body', async (_name, body, message) => {
    const bytes = concatenate(ftyp(body), moov(), mdat());
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(message);
  });

  it('rejects a top-level box whose declared end is truncated', async () => {
    const declared = header('ftyp', 32);
    const bytes = concatenate(declared, new Uint8Array(8));
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(sourceFrom(bytes)), signal()),
    ).rejects.toThrow(/escapes its parent span/);
  });

  it('preserves exact abort before and during a source read', async () => {
    const before = new AbortController();
    const beforeReason = Object.freeze({ phase: 'before-layout' });
    before.abort(beforeReason);
    const untouched = sourceFrom(concatenate(ftyp(), moov(), mdat()));
    await expect(
      readM4aContainerLayout(new IsoBmffBoxReader(untouched), before.signal),
    ).rejects.toBe(beforeReason);
    expect(untouched.reads).toHaveLength(0);

    const gate = deferred<Uint8Array>();
    const duringSource: EncodedRandomAccessSource = {
      size: 8,
      identity: 'm4a-abort-during',
      async readAt(): Promise<Uint8Array> {
        return gate.promise;
      },
      async close(): Promise<void> {},
    };
    const during = new AbortController();
    const duringReason = Object.freeze({ phase: 'during-layout' });
    const pending = readM4aContainerLayout(new IsoBmffBoxReader(duringSource), during.signal);
    during.abort(duringReason);
    gate.resolve(header('free', 8));
    await expect(pending).rejects.toBe(duringReason);
  });

  it('fails if the encoded source identity mutates during traversal', async () => {
    const bytes = concatenate(ftyp(), moov(), mdat());
    const source = sourceFrom(bytes);
    const originalRead = source.readAt.bind(source);
    source.readAt = async (offset, length, abortSignal) => {
      const result = await originalRead(offset, length, abortSignal);
      source.identity = 'mutated-m4a-source';
      return result;
    };

    await expect(readM4aContainerLayout(new IsoBmffBoxReader(source), signal())).rejects.toThrow(
      /source changed/,
    );
    expect(source.closeCalls).toBe(0);
  });

  it('returns the same reader-issued moov reference for subsequent child parsing', async () => {
    const bytes = concatenate(ftyp(), moov(box('trak')), mdat());
    const source = sourceFrom(bytes);
    const reader = new IsoBmffBoxReader(source);
    const layout = await readM4aContainerLayout(reader, signal());

    await expect(reader.createChildCursor(layout.moov).next(signal())).resolves.toMatchObject({
      type: 'trak',
    });
    expect(() => new IsoBmffBoxReader(source).createChildCursor(layout.moov)).toThrow(
      /not issued by this reader/,
    );
  });
});
