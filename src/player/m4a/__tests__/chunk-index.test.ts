import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import type { IsoBmffBoxRef } from '../../mp4/box.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  locateM4aAacAccessUnit,
  M4A_MAX_CHUNKS,
  readM4aChunkIndex,
  readM4aChunkOffsetAt,
  rehydrateM4aChunkIndex,
  snapshotM4aChunkIndex,
  validateM4aChunkIndexSnapshot,
} from '../chunk-index.ts';
import { readM4aContainerLayout, type M4aContainerLayout } from '../container-layout.ts';
import {
  readM4aSampleSizeIndex,
  readM4aSampleToChunkRuns,
  type M4aSampleSizeIndex,
  type M4aSampleToChunkRunTable,
} from '../sample-size-index.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + body.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(body, 8);
  return result;
}

function fileTypeBox(): Uint8Array {
  const body = new Uint8Array(8);
  body.set(Uint8Array.of(0x4d, 0x34, 0x41, 0x20));
  return box('ftyp', body);
}

function mediaDataBox(byteLength: number): Uint8Array {
  return box('mdat', new Uint8Array(byteLength));
}

function stscBody(entries: readonly (readonly [number, number, number])[]): Uint8Array {
  const result = new Uint8Array(8 + entries.length * 12);
  const view = new DataView(result.buffer);
  view.setUint32(4, entries.length, false);
  entries.forEach(([firstChunk, samplesPerChunk, description], index) => {
    const offset = 8 + index * 12;
    view.setUint32(offset, firstChunk, false);
    view.setUint32(offset + 4, samplesPerChunk, false);
    view.setUint32(offset + 8, description, false);
  });
  return result;
}

function stszBody(sizes: readonly number[], fixedSampleSize = 0): Uint8Array {
  const result = new Uint8Array(12 + (fixedSampleSize === 0 ? sizes.length * 4 : 0));
  const view = new DataView(result.buffer);
  view.setUint32(4, fixedSampleSize, false);
  view.setUint32(8, sizes.length, false);
  if (fixedSampleSize === 0) {
    sizes.forEach((size, index) => view.setUint32(12 + index * 4, size, false));
  }
  return result;
}

function chunkOffsetBody(
  width: 4 | 8,
  offsets: readonly (number | bigint)[],
  options: {
    readonly declaredCount?: number;
    readonly flags?: number;
    readonly suffix?: Uint8Array;
  } = {},
): Uint8Array {
  const suffix = options.suffix ?? new Uint8Array(0);
  const result = new Uint8Array(8 + offsets.length * width + suffix.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, options.flags ?? 0, false);
  view.setUint32(4, options.declaredCount ?? offsets.length, false);
  offsets.forEach((value, index) => {
    if (width === 4) view.setUint32(8 + index * width, Number(value), false);
    else view.setBigUint64(8 + index * width, BigInt(value), false);
  });
  result.set(suffix, 8 + offsets.length * width);
  return result;
}

class MemorySource implements EncodedRandomAccessSource {
  identity = 'm4a-chunk-index-fixture';
  readonly reads: ReadRecord[] = [];
  blockNextRead = false;
  mutateIdentityAfterRead = false;
  #releaseRead: (() => void) | null = null;

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    if (this.blockNextRead) {
      this.blockNextRead = false;
      await new Promise<void>((resolve) => {
        this.#releaseRead = resolve;
      });
      throwIfAborted(signal);
    }
    const result = this.bytes.slice(offset, end);
    if (this.mutateIdentityAfterRead) this.identity = 'mutated-m4a-chunk-index-fixture';
    return result;
  }

  releaseRead(): void {
    this.#releaseRead?.();
    this.#releaseRead = null;
  }

  async close(): Promise<void> {}
}

class SparseSource implements EncodedRandomAccessSource {
  identity = 'm4a-chunk-index-sparse-fixture';
  readonly reads: ReadRecord[] = [];

  constructor(
    readonly size: number,
    private readonly regions: readonly SparseRegion[],
  ) {}

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    const region = this.regions.find(
      (candidate) =>
        offset >= candidate.offset && end <= candidate.offset + candidate.bytes.byteLength,
    );
    if (!region) throw new Error(`No sparse fixture bytes for [${offset}, ${end})`);
    return region.bytes.slice(offset - region.offset, end - region.offset);
  }

  async close(): Promise<void> {}
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

interface IndexedFixture {
  readonly source: MemorySource;
  readonly reader: IsoBmffBoxReader;
  readonly layout: Readonly<M4aContainerLayout>;
  readonly stsc: Readonly<M4aSampleToChunkRunTable>;
  readonly stsz: Readonly<M4aSampleSizeIndex>;
  readonly chunkOffsets: Readonly<IsoBmffBoxRef>;
  readonly mediaDataRanges: readonly Readonly<{ start: number; end: number }>[];
}

interface FixtureOptions {
  readonly sizes: readonly number[];
  readonly fixedSampleSize?: number;
  readonly runs: readonly (readonly [number, number, number])[];
  readonly width?: 4 | 8;
  readonly chunkCount: number;
  readonly mdatLengths?: readonly number[];
  readonly offsetValues?: (
    ranges: readonly Readonly<{ start: number; end: number }>[],
  ) => readonly (number | bigint)[];
  readonly declaredChunkCount?: number;
  readonly chunkFlags?: number;
  readonly chunkSuffix?: Uint8Array;
  readonly chunkBoxType?: string;
}

async function indexedFixture(options: FixtureOptions): Promise<IndexedFixture> {
  const width = options.width ?? 4;
  const mdatLengths = options.mdatLengths ?? [256];
  const placeholderOffsets = Array(options.chunkCount).fill(0) as number[];
  const placeholderBody = chunkOffsetBody(width, placeholderOffsets, {
    declaredCount: options.declaredChunkCount,
    flags: options.chunkFlags,
    suffix: options.chunkSuffix,
  });
  const stscBox = box('stsc', stscBody(options.runs));
  const stszBox = box('stsz', stszBody(options.sizes, options.fixedSampleSize));
  const chunkType = options.chunkBoxType ?? (width === 4 ? 'stco' : 'co64');
  const placeholderMoov = box(
    'moov',
    concatenate(stscBox, stszBox, box(chunkType, placeholderBody)),
  );
  const ftyp = fileTypeBox();
  let nextTopLevelOffset = ftyp.byteLength + placeholderMoov.byteLength;
  const ranges = mdatLengths.map((byteLength) => {
    const range = Object.freeze({
      start: nextTopLevelOffset + 8,
      end: nextTopLevelOffset + 8 + byteLength,
    });
    nextTopLevelOffset = range.end;
    return range;
  });
  const offsets =
    options.offsetValues?.(ranges) ?? Array(options.chunkCount).fill(ranges[0]!.start);
  if (offsets.length !== options.chunkCount) throw new Error('Fixture chunk-count mismatch');
  const chunkBody = chunkOffsetBody(width, offsets, {
    declaredCount: options.declaredChunkCount,
    flags: options.chunkFlags,
    suffix: options.chunkSuffix,
  });
  const moov = box('moov', concatenate(stscBox, stszBox, box(chunkType, chunkBody)));
  if (moov.byteLength !== placeholderMoov.byteLength) throw new Error('Fixture layout changed');
  const bytes = concatenate(ftyp, moov, ...mdatLengths.map(mediaDataBox));
  const source = new MemorySource(bytes);
  const reader = new IsoBmffBoxReader(source);
  const layout = await readM4aContainerLayout(reader, signal());
  const children = reader.createChildCursor(layout.moov);
  const refs = new Map<string, Readonly<IsoBmffBoxRef>>();
  for (;;) {
    const child = await children.next(signal());
    if (child === null) break;
    refs.set(child.type, child);
  }
  const stsc = await readM4aSampleToChunkRuns(
    reader,
    refs.get('stsc')!,
    options.sizes.length,
    signal(),
  );
  const stsz = await readM4aSampleSizeIndex(
    reader,
    refs.get('stsz')!,
    options.sizes.length,
    signal(),
  );
  return {
    source,
    reader,
    layout,
    stsc,
    stsz,
    chunkOffsets: refs.get(chunkType)!,
    mediaDataRanges: ranges,
  };
}

async function buildIndex(fixture: IndexedFixture) {
  return readM4aChunkIndex(
    fixture.reader,
    fixture.layout,
    fixture.stsc,
    fixture.stsz,
    fixture.chunkOffsets,
    signal(),
  );
}

function sourceBinding(fixture: IndexedFixture) {
  return Object.freeze({
    sourceSize: fixture.reader.sourceSize,
    sourceIdentity: fixture.reader.sourceIdentity,
  });
}

describe('bounded M4A chunk geometry', () => {
  it('normalizes run boundaries and admits bounded nonmonotonic, overlapping, multi-mdat chunks', async () => {
    const sizes = [3, 5, 7, 11, 13, 17];
    const fixture = await indexedFixture({
      sizes,
      runs: [
        [1, 2, 1],
        [3, 1, 1],
      ],
      chunkCount: 4,
      mdatLengths: [64, 64],
      offsetValues: ([first, second]) => [
        first!.start + 10,
        second!.start + 20,
        first!.start + 10,
        second!.start,
      ],
    });
    const index = await buildIndex(fixture);

    expect(index).toMatchObject({
      sampleCount: 6,
      chunkCount: 4,
      chunkOffsetWidthBytes: 4,
      runs: [
        { firstChunk: 1, endChunkExclusive: 3, firstSampleOrdinal: 0, samplesPerChunk: 2 },
        { firstChunk: 3, endChunkExclusive: 5, firstSampleOrdinal: 4, samplesPerChunk: 1 },
      ],
    });
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.runs)).toBe(true);
    expect(index.runs.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(index.mediaDataRanges)).toBe(true);
    await expect(readM4aChunkOffsetAt(fixture.reader, index, 2, signal())).resolves.toBe(
      fixture.mediaDataRanges[0]!.start + 10,
    );
    await expect(locateM4aAacAccessUnit(fixture.reader, index, 3, signal())).resolves.toEqual({
      ordinal: 3,
      chunkOrdinal: 1,
      chunkOffset: fixture.mediaDataRanges[1]!.start + 20,
      offset: fixture.mediaDataRanges[1]!.start + 27,
      byteLength: 11,
    });
    expect(Object.isFrozen(await locateM4aAacAccessUnit(fixture.reader, index, 0, signal()))).toBe(
      true,
    );
    expect(fixture.source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('pages and authenticates a greater-than-64-KiB co64 table', async () => {
    const count = 20_000;
    const sizes = Array(count).fill(1);
    const fixture = await indexedFixture({
      sizes,
      fixedSampleSize: 1,
      runs: [[1, 1, 1]],
      width: 8,
      chunkCount: count,
      mdatLengths: [count],
      offsetValues: ([range]) => Array(count).fill(range!.start),
    });
    fixture.source.reads.length = 0;
    const index = await buildIndex(fixture);

    const tableReads = fixture.source.reads.filter(
      (read) => read.offset >= index.chunkOffsetTableStart,
    );
    expect(tableReads.some((read) => read.length === 64 * 1_024)).toBe(true);
    expect(tableReads.every((read) => read.length <= 64 * 1_024)).toBe(true);
    fixture.source.reads.length = 0;
    await expect(readM4aChunkOffsetAt(fixture.reader, index, count - 1, signal())).resolves.toBe(
      fixture.mediaDataRanges[0]!.start,
    );
    expect(fixture.source.reads).toHaveLength(1);
    expect(fixture.source.reads[0]!.length).toBeLessThanOrEqual(64 * 1_024);
  });

  it.each([
    ['nonzero FullBox flags', { chunkFlags: 1 }, /version and flags/],
    ['zero chunks', { chunkCount: 0 }, /chunk count/],
    [
      'too many declared chunks',
      { chunkCount: 1, declaredChunkCount: M4A_MAX_CHUNKS + 1 },
      /chunk count/,
    ],
    ['trailing bytes', { chunkSuffix: Uint8Array.of(0) }, /expected/],
  ] as const)('rejects %s', async (_label, overrides, message) => {
    const fixture = await indexedFixture({
      sizes: [1],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      ...overrides,
    });
    await expect(buildIndex(fixture)).rejects.toThrow(message);
  });

  it('rejects unsafe co64 values and wrong issued box types', async () => {
    const unsafe = await indexedFixture({
      sizes: [1],
      runs: [[1, 1, 1]],
      width: 8,
      chunkCount: 1,
      offsetValues: () => [BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    });
    await expect(buildIndex(unsafe)).rejects.toThrow(/safe-integer/);

    const wrong = await indexedFixture({
      sizes: [1],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      chunkBoxType: 'free',
      offsetValues: ([range]) => [range!.start],
    });
    await expect(buildIndex(wrong)).rejects.toThrow(/stco or co64/);
  });

  it('rejects a declared chunk count greater than the access-unit count', async () => {
    const fixture = await indexedFixture({
      sizes: [1],
      runs: [[1, 1, 1]],
      chunkCount: 2,
      offsetValues: ([range]) => [range!.start, range!.start],
    });
    await expect(buildIndex(fixture)).rejects.toThrow(/cannot exceed/);
  });

  it.each([
    ['more covered samples', [1, 1, 1], [[1, 2, 1]], 2, /cover more samples/],
    ['fewer covered samples', [1, 1, 1], [[1, 1, 1]], 2, /cover 2 samples/],
    [
      'run after final chunk',
      [1, 1],
      [
        [1, 1, 1],
        [3, 1, 1],
      ],
      2,
      /after the final declared chunk/,
    ],
  ] as const)('rejects stsc geometry with %s', async (_label, sizes, runs, chunkCount, message) => {
    const fixture = await indexedFixture({
      sizes,
      runs,
      chunkCount,
      offsetValues: ([range]) => Array(chunkCount).fill(range!.start),
    });
    await expect(buildIndex(fixture)).rejects.toThrow(message);
  });

  it('rejects a chunk outside or crossing an authentic mdat payload', async () => {
    const outside = await indexedFixture({
      sizes: [3],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      mdatLengths: [8],
      offsetValues: ([range]) => [range!.start - 1],
    });
    await expect(buildIndex(outside)).rejects.toThrow(/not wholly contained/);

    const crossing = await indexedFixture({
      sizes: [3],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      mdatLengths: [8],
      offsetValues: ([range]) => [range!.end - 2],
    });
    await expect(buildIndex(crossing)).rejects.toThrow(/not wholly contained/);
  });

  it('rejects logical sample-byte amplification beyond physical mdat capacity', async () => {
    const fixture = await indexedFixture({
      sizes: [3, 5],
      runs: [[1, 1, 1]],
      chunkCount: 2,
      mdatLengths: [5],
      offsetValues: ([range]) => [range!.start, range!.start],
    });

    await expect(buildIndex(fixture)).rejects.toThrow(/aggregate physical mdat payload capacity/);
  });
});

describe('M4A chunk-index authority and bounded lookup', () => {
  it('rejects cloned or foreign authorities and out-of-range ordinals', async () => {
    const fixture = await indexedFixture({
      sizes: [3, 5],
      runs: [[1, 2, 1]],
      chunkCount: 1,
      offsetValues: ([range]) => [range!.start],
    });
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        { ...fixture.layout },
        fixture.stsc,
        fixture.stsz,
        fixture.chunkOffsets,
        signal(),
      ),
    ).rejects.toThrow(/container layout lacks module provenance/);
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        fixture.layout,
        { ...fixture.stsc },
        fixture.stsz,
        fixture.chunkOffsets,
        signal(),
      ),
    ).rejects.toThrow(/sample-to-chunk table lacks module provenance/);
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        fixture.layout,
        fixture.stsc,
        { ...fixture.stsz },
        fixture.chunkOffsets,
        signal(),
      ),
    ).rejects.toThrow(/sample-size index lacks module provenance/);
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        fixture.layout,
        fixture.stsc,
        fixture.stsz,
        { ...fixture.chunkOffsets },
        signal(),
      ),
    ).rejects.toThrow(/not issued by this reader/);
    const foreignReader = new IsoBmffBoxReader(fixture.source);
    const foreignLayout = await readM4aContainerLayout(foreignReader, signal());
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        foreignLayout,
        fixture.stsc,
        fixture.stsz,
        fixture.chunkOffsets,
        signal(),
      ),
    ).rejects.toThrow(/container layout belongs to a different source reader/);
    const foreignChildren = foreignReader.createChildCursor(foreignLayout.moov);
    let foreignChunkOffsets: Readonly<IsoBmffBoxRef> | null = null;
    for (;;) {
      const child = await foreignChildren.next(signal());
      if (child === null) break;
      if (child.type === 'stco') foreignChunkOffsets = child;
    }
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        fixture.layout,
        fixture.stsc,
        fixture.stsz,
        foreignChunkOffsets!,
        signal(),
      ),
    ).rejects.toThrow(/not issued by this reader/);

    const index = await buildIndex(fixture);
    await expect(readM4aChunkOffsetAt(fixture.reader, { ...index }, 0, signal())).rejects.toThrow(
      /provenance/,
    );
    await expect(
      readM4aChunkOffsetAt(new IsoBmffBoxReader(fixture.source), index, 0, signal()),
    ).rejects.toThrow(/different source reader/);
    await expect(readM4aChunkOffsetAt(fixture.reader, index, 1, signal())).rejects.toThrow(
      /chunk ordinal/,
    );
    await expect(locateM4aAacAccessUnit(fixture.reader, index, 2, signal())).rejects.toThrow(
      /access-unit ordinal/,
    );
  });

  it('detects same-identity offset-table mutation and source identity mutation', async () => {
    const fixture = await indexedFixture({
      sizes: [3],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      offsetValues: ([range]) => [range!.start],
    });
    const index = await buildIndex(fixture);
    fixture.source.bytes[index.chunkOffsetTableStart + 3]! ^= 1;
    await expect(readM4aChunkOffsetAt(fixture.reader, index, 0, signal())).rejects.toThrow(
      /changed after the index/,
    );

    const identityFixture = await indexedFixture({
      sizes: [3],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      offsetValues: ([range]) => [range!.start],
    });
    const identityIndex = await buildIndex(identityFixture);
    identityFixture.source.mutateIdentityAfterRead = true;
    await expect(
      readM4aChunkOffsetAt(identityFixture.reader, identityIndex, 0, signal()),
    ).rejects.toThrow(/source changed/);
  });

  it('preserves abort reasons and permits independent concurrent bounded lookups', async () => {
    const fixture = await indexedFixture({
      sizes: [3, 5],
      runs: [[1, 1, 1]],
      chunkCount: 2,
      offsetValues: ([range]) => [range!.start, range!.start + 3],
    });
    const before = new AbortController();
    const beforeReason = Object.freeze({ phase: 'chunk-index-before' });
    before.abort(beforeReason);
    await expect(
      readM4aChunkIndex(
        fixture.reader,
        fixture.layout,
        fixture.stsc,
        fixture.stsz,
        fixture.chunkOffsets,
        before.signal,
      ),
    ).rejects.toBe(beforeReason);

    fixture.source.blockNextRead = true;
    const during = new AbortController();
    const duringReason = Object.freeze({ phase: 'chunk-index-during' });
    const interrupted = readM4aChunkIndex(
      fixture.reader,
      fixture.layout,
      fixture.stsc,
      fixture.stsz,
      fixture.chunkOffsets,
      during.signal,
    );
    await Promise.resolve();
    during.abort(duringReason);
    fixture.source.releaseRead();
    await expect(interrupted).rejects.toBe(duringReason);

    const index = await buildIndex(fixture);
    await expect(
      Promise.all([
        readM4aChunkOffsetAt(fixture.reader, index, 0, signal()),
        readM4aChunkOffsetAt(fixture.reader, index, 1, signal()),
      ]),
    ).resolves.toEqual([fixture.mediaDataRanges[0]!.start, fixture.mediaDataRanges[0]!.start + 3]);
  });
});

describe('transferable M4A chunk-index snapshots', () => {
  it('round-trips structured-clone evidence and keeps first, middle, and last pages lazy', async () => {
    const count = 20_000;
    const fixture = await indexedFixture({
      sizes: Array(count).fill(1),
      fixedSampleSize: 1,
      runs: [[1, 1, 1]],
      width: 8,
      chunkCount: count,
      mdatLengths: [count],
      offsetValues: ([range]) =>
        Array.from({ length: count }, (_, ordinal) => range!.start + ordinal),
    });
    const original = await buildIndex(fixture);
    const transferred = structuredClone(snapshotM4aChunkIndex(fixture.reader, original, signal()));
    const validated = validateM4aChunkIndexSnapshot(transferred);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.runs)).toBe(true);
    expect(validated.runs.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(validated.mediaDataRanges)).toBe(true);
    expect(validated.mediaDataRanges.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(validated.pages)).toBe(true);
    expect(validated.pages.every(Object.isFrozen)).toBe(true);

    fixture.source.reads.length = 0;
    const reopened = await rehydrateM4aChunkIndex(
      fixture.reader,
      transferred,
      fixture.stsz,
      structuredClone(sourceBinding(fixture)),
      signal(),
    );
    expect(fixture.source.reads).toEqual([
      { offset: validated.chunkOffsetTableStart - 8, length: 8 },
    ]);
    expect(Object.isFrozen(reopened)).toBe(true);

    fixture.source.reads.length = 0;
    const ordinals = [0, Math.floor(count / 2), count - 1];
    await expect(
      Promise.all(
        ordinals.map((ordinal) =>
          readM4aChunkOffsetAt(fixture.reader, reopened, ordinal, signal()),
        ),
      ),
    ).resolves.toEqual(ordinals.map((ordinal) => fixture.mediaDataRanges[0]!.start + ordinal));
    expect(fixture.source.reads).toHaveLength(3);
    expect(fixture.source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
    await expect(
      readM4aChunkOffsetAt(fixture.reader, { ...reopened }, 0, signal()),
    ).rejects.toThrow(/provenance/);
  });

  it('authenticates and reparses the exact eight-byte FullBox header', async () => {
    const fixture = await indexedFixture({
      sizes: [3, 5],
      runs: [[1, 1, 1]],
      chunkCount: 2,
      offsetValues: ([range]) => [range!.start, range!.start + 3],
    });
    const index = await buildIndex(fixture);
    const snapshot = structuredClone(snapshotM4aChunkIndex(fixture.reader, index, signal()));
    fixture.source.bytes[snapshot.chunkOffsetTableStart - 1]! ^= 1;

    fixture.source.reads.length = 0;
    await expect(
      rehydrateM4aChunkIndex(
        fixture.reader,
        snapshot,
        fixture.stsz,
        sourceBinding(fixture),
        signal(),
      ),
    ).rejects.toThrow(/header changed/);
    expect(fixture.source.reads).toEqual([
      { offset: snapshot.chunkOffsetTableStart - 8, length: 8 },
    ]);
  });

  it('strictly rejects malformed objects, nested records, arrays, bounds, and digests', async () => {
    const fixture = await indexedFixture({
      sizes: [3, 5],
      runs: [[1, 2, 1]],
      chunkCount: 1,
      offsetValues: ([range]) => [range!.start],
    });
    const index = await buildIndex(fixture);
    const snapshot = structuredClone(snapshotM4aChunkIndex(fixture.reader, index, signal()));

    const accessor = { ...snapshot };
    Object.defineProperty(accessor, 'chunkCount', {
      enumerable: true,
      get() {
        throw new Error('snapshot getter must not execute');
      },
    });
    const withSymbol = Object.assign({ ...snapshot }, { [Symbol('extra')]: true });
    class SnapshotRecord {}
    const classInstance = Object.assign(new SnapshotRecord(), snapshot);
    const sparsePages: unknown[] = [];
    sparsePages.length = snapshot.pages.length;
    const nonEnumerable = { ...snapshot };
    Object.defineProperty(nonEnumerable, 'chunkCount', {
      enumerable: false,
      value: snapshot.chunkCount,
    });

    const malformed: readonly unknown[] = [
      null,
      { ...snapshot, extra: true },
      accessor,
      withSymbol,
      classInstance,
      nonEnumerable,
      { ...snapshot, chunkOffsetWidthBytes: 5 },
      { ...snapshot, chunkOffsetTableStart: Number.MAX_SAFE_INTEGER },
      { ...snapshot, headerSha256: snapshot.headerSha256.toUpperCase() },
      { ...snapshot, runs: [{ ...snapshot.runs[0]!, extra: true }] },
      { ...snapshot, runs: [{ ...snapshot.runs[0]!, firstSampleOrdinal: 1 }] },
      { ...snapshot, runs: [{ ...snapshot.runs[0]!, samplesPerChunk: 1 }] },
      {
        ...snapshot,
        mediaDataRanges: [snapshot.mediaDataRanges[0]!, { ...snapshot.mediaDataRanges[0]! }],
      },
      { ...snapshot, pages: sparsePages },
      { ...snapshot, pages: [{ ...snapshot.pages[0]!, extra: true }] },
      { ...snapshot, pages: [{ ...snapshot.pages[0]!, entryCount: 0 }] },
      { ...snapshot, pages: [{ ...snapshot.pages[0]!, sha256: 'A'.repeat(64) }] },
    ];
    for (const candidate of malformed) {
      expect(() => validateM4aChunkIndexSnapshot(candidate)).toThrow();
    }
  });

  it('binds source geometry and the authentic same-reader sample-size authority', async () => {
    const fixture = await indexedFixture({
      sizes: [3, 5],
      runs: [[1, 2, 1]],
      chunkCount: 1,
      offsetValues: ([range]) => [range!.start],
    });
    const index = await buildIndex(fixture);
    const snapshot = structuredClone(snapshotM4aChunkIndex(fixture.reader, index, signal()));

    await expect(
      rehydrateM4aChunkIndex(
        fixture.reader,
        snapshot,
        fixture.stsz,
        { ...sourceBinding(fixture), sourceIdentity: 'foreign-m4a-source' },
        signal(),
      ),
    ).rejects.toThrow(/source binding/);

    const sameSourceForeignReader = new IsoBmffBoxReader(fixture.source);
    await expect(
      rehydrateM4aChunkIndex(
        sameSourceForeignReader,
        snapshot,
        fixture.stsz,
        sourceBinding(fixture),
        signal(),
      ),
    ).rejects.toThrow(/different source reader/);

    await expect(
      rehydrateM4aChunkIndex(
        fixture.reader,
        {
          ...snapshot,
          mediaDataRanges: [{ start: 0, end: fixture.reader.sourceSize + 1 }],
        },
        fixture.stsz,
        sourceBinding(fixture),
        signal(),
      ),
    ).rejects.toThrow(/range exceeds/);

    await expect(
      rehydrateM4aChunkIndex(
        fixture.reader,
        { ...snapshot, mediaDataRanges: [{ start: 0, end: 1 }] },
        fixture.stsz,
        sourceBinding(fixture),
        signal(),
      ),
    ).rejects.toThrow(/physical mdat payload capacity/);

    await expect(
      rehydrateM4aChunkIndex(
        fixture.reader,
        { ...snapshot, chunkOffsetTableStart: fixture.reader.sourceSize },
        fixture.stsz,
        sourceBinding(fixture),
        signal(),
      ),
    ).rejects.toThrow(/table exceeds/);
  });

  it('preserves abort reasons before and during rehydration', async () => {
    const fixture = await indexedFixture({
      sizes: [3],
      runs: [[1, 1, 1]],
      chunkCount: 1,
      offsetValues: ([range]) => [range!.start],
    });
    const index = await buildIndex(fixture);
    const snapshot = structuredClone(snapshotM4aChunkIndex(fixture.reader, index, signal()));

    const before = new AbortController();
    const beforeReason = Object.freeze({ phase: 'chunk-rehydrate-before' });
    before.abort(beforeReason);
    await expect(
      rehydrateM4aChunkIndex(
        fixture.reader,
        snapshot,
        fixture.stsz,
        sourceBinding(fixture),
        before.signal,
      ),
    ).rejects.toBe(beforeReason);

    fixture.source.blockNextRead = true;
    const during = new AbortController();
    const duringReason = Object.freeze({ phase: 'chunk-rehydrate-during' });
    const interrupted = rehydrateM4aChunkIndex(
      fixture.reader,
      snapshot,
      fixture.stsz,
      sourceBinding(fixture),
      during.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    during.abort(duringReason);
    fixture.source.releaseRead();
    await expect(interrupted).rejects.toBe(duringReason);
  });
});

describe('large sparse M4A chunk offsets', () => {
  it('locates a safe greater-than-4-GiB co64 access unit without reading media bytes', async () => {
    const hugeOffset = 5 * 1_024 * 1_024 * 1_024 + 123;
    const stscBox = box('stsc', stscBody([[1, 1, 1]]));
    const stszBox = box('stsz', stszBody([7], 7));
    const co64Box = box('co64', chunkOffsetBody(8, [hugeOffset]));
    const moov = box('moov', concatenate(stscBox, stszBox, co64Box));
    const terminalMdatHeader = new Uint8Array(8);
    terminalMdatHeader.set(Uint8Array.of(0x6d, 0x64, 0x61, 0x74), 4);
    const prefix = concatenate(fileTypeBox(), moov, terminalMdatHeader);
    const source = new SparseSource(hugeOffset + 64, [{ offset: 0, bytes: prefix }]);
    const reader = new IsoBmffBoxReader(source);
    const layout = await readM4aContainerLayout(reader, signal());
    const children = reader.createChildCursor(layout.moov);
    const refs = new Map<string, Readonly<IsoBmffBoxRef>>();
    for (;;) {
      const child = await children.next(signal());
      if (child === null) break;
      refs.set(child.type, child);
    }
    const stsc = await readM4aSampleToChunkRuns(reader, refs.get('stsc')!, 1, signal());
    const stsz = await readM4aSampleSizeIndex(reader, refs.get('stsz')!, 1, signal());
    const index = await readM4aChunkIndex(reader, layout, stsc, stsz, refs.get('co64')!, signal());

    await expect(locateM4aAacAccessUnit(reader, index, 0, signal())).resolves.toEqual({
      ordinal: 0,
      chunkOrdinal: 0,
      chunkOffset: hugeOffset,
      offset: hugeOffset,
      byteLength: 7,
    });
    expect(source.reads.every((read) => read.offset < prefix.byteLength)).toBe(true);
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });
});
