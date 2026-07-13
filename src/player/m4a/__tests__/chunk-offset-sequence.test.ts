import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import type { IsoBmffBoxRef } from '../../mp4/box.ts';
import {
  EncodedSourceBusyError,
  EncodedSourceIntegrityError,
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  createM4aChunkOffsetSequence,
  type M4aChunkIndex,
  readM4aChunkIndex,
} from '../chunk-index.ts';
import { readM4aContainerLayout } from '../container-layout.ts';
import { readM4aSampleSizeIndex, readM4aSampleToChunkRuns } from '../sample-size-index.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function signal(): AbortSignal {
  return new AbortController().signal;
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

function sampleToChunkBox(): Uint8Array {
  const body = new Uint8Array(20);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1, false);
  view.setUint32(8, 1, false);
  view.setUint32(12, 1, false);
  view.setUint32(16, 1, false);
  return box('stsc', body);
}

function fixedSampleSizeBox(sampleCount: number): Uint8Array {
  const body = new Uint8Array(12);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1, false);
  view.setUint32(8, sampleCount, false);
  return box('stsz', body);
}

function chunkOffsetBox(width: 4 | 8, offsets: readonly number[]): Uint8Array {
  const body = new Uint8Array(8 + offsets.length * width);
  const view = new DataView(body.buffer);
  view.setUint32(4, offsets.length, false);
  offsets.forEach((offset, index) => {
    if (width === 4) view.setUint32(8 + index * width, offset, false);
    else view.setBigUint64(8 + index * width, BigInt(offset), false);
  });
  return box(width === 4 ? 'stco' : 'co64', body);
}

class ControlledMemorySource implements EncodedRandomAccessSource {
  readonly reads: ReadRecord[] = [];
  closeCalls = 0;
  shortNextRead = false;
  onRead: (() => void | Promise<void>) | null = null;
  readonly failures: unknown[] = [];

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = 'm4a-chunk-offset-sequence-fixture',
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, abortSignal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(abortSignal);
    this.reads.push(Object.freeze({ offset, length }));
    if (this.failures.length > 0) throw this.failures.shift();
    const callback = this.onRead;
    if (callback) await callback();
    throwIfAborted(abortSignal);
    if (this.shortNextRead) {
      this.shortNextRead = false;
      return this.bytes.slice(offset, Math.max(offset, end - 1));
    }
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

interface BuiltFixture {
  readonly source: ControlledMemorySource;
  readonly reader: IsoBmffBoxReader;
  readonly index: Readonly<M4aChunkIndex>;
  readonly offsets: readonly number[];
}

async function buildFixture(width: 4 | 8, sampleCount: number): Promise<BuiltFixture> {
  const ftyp = fileTypeBox();
  const stsc = sampleToChunkBox();
  const stsz = fixedSampleSizeBox(sampleCount);
  const placeholder = chunkOffsetBox(width, Array(sampleCount).fill(0) as number[]);
  const placeholderMoov = box('moov', concatenate(stsc, stsz, placeholder));
  const mdatPayloadStart = ftyp.byteLength + placeholderMoov.byteLength + 8;
  const offsets = Object.freeze(
    Array.from({ length: sampleCount }, (_unused, ordinal) => mdatPayloadStart + ordinal),
  );
  const moov = box('moov', concatenate(stsc, stsz, chunkOffsetBox(width, offsets)));
  const bytes = concatenate(ftyp, moov, box('mdat', new Uint8Array(sampleCount)));
  const source = new ControlledMemorySource(bytes, `m4a-chunk-sequence-${width}-${sampleCount}`);
  const reader = new IsoBmffBoxReader(source);
  const layout = await readM4aContainerLayout(reader, signal());
  const children = reader.createChildCursor(layout.moov);
  const refs = new Map<string, Readonly<IsoBmffBoxRef>>();
  for (;;) {
    const child = await children.next(signal());
    if (child === null) break;
    refs.set(child.type, child);
  }
  const stscRef = refs.get('stsc');
  const stszRef = refs.get('stsz');
  const chunkRef = refs.get(width === 4 ? 'stco' : 'co64');
  if (!stscRef || !stszRef || !chunkRef) throw new Error('incomplete sequence fixture');
  const runs = await readM4aSampleToChunkRuns(reader, stscRef, sampleCount, signal());
  const sizes = await readM4aSampleSizeIndex(reader, stszRef, sampleCount, signal());
  const index = await readM4aChunkIndex(reader, layout, runs, sizes, chunkRef, signal());
  source.reads.length = 0;
  return Object.freeze({ source, reader, index, offsets });
}

describe('authenticated M4A chunk-offset sequence', () => {
  it.each([4, 8] as const)('reads %i-byte offsets forward and keeps EOF stable', async (width) => {
    const fixture = await buildFixture(width, 3);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);

    expect(sequence.chunkOrdinal).toBe(0);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[0]);
    expect(sequence.chunkOrdinal).toBe(1);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[1]);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[2]);
    await expect(sequence.readNext(signal())).resolves.toBeNull();
    await expect(sequence.readNext(signal())).resolves.toBeNull();
    expect(sequence.chunkOrdinal).toBe(3);
    expect(fixture.source.reads).toHaveLength(1);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('caches one 64-KiB page and replaces it only across the co64 page boundary', async () => {
    const entriesPerPage = (64 * 1_024) / 8;
    const fixture = await buildFixture(8, entriesPerPage + 1);
    const sequence = createM4aChunkOffsetSequence(
      fixture.reader,
      fixture.index,
      entriesPerPage - 2,
    );

    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[entriesPerPage - 2]);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[entriesPerPage - 1]);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[entriesPerPage]);
    await expect(sequence.readNext(signal())).resolves.toBeNull();
    expect(fixture.source.reads.map((read) => read.length)).toEqual([64 * 1_024, 8]);
    expect(fixture.source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('supports an authenticated terminal start without reading the table', async () => {
    const fixture = await buildFixture(4, 3);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 3);

    await expect(sequence.readNext(signal())).resolves.toBeNull();
    await expect(sequence.readNext(signal())).resolves.toBeNull();
    expect(sequence.chunkOrdinal).toBe(3);
    expect(fixture.source.reads).toHaveLength(0);
    expect(() => createM4aChunkOffsetSequence(fixture.reader, fixture.index, -1)).toThrow();
    expect(() => createM4aChunkOffsetSequence(fixture.reader, fixture.index, 4)).toThrow();
  });

  it('rejects foreign and forged indexes before any source read', async () => {
    const fixture = await buildFixture(4, 2);
    const foreign = await buildFixture(4, 2);
    const forged = Object.freeze({ ...fixture.index });

    expect(() => createM4aChunkOffsetSequence(foreign.reader, fixture.index, 0)).toThrow(
      /different source reader/i,
    );
    expect(() =>
      createM4aChunkOffsetSequence(fixture.reader, forged as Readonly<M4aChunkIndex>, 0),
    ).toThrow(/provenance/i);
    expect(fixture.source.reads).toHaveLength(0);
    expect(foreign.source.reads).toHaveLength(0);
  });

  it('preserves exact abort reasons and retries the same ordinal', async () => {
    const fixture = await buildFixture(4, 2);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);
    const before = new AbortController();
    const beforeReason = Object.freeze({ phase: 'before-chunk-offset' });
    before.abort(beforeReason);
    await expect(sequence.readNext(before.signal)).rejects.toBe(beforeReason);
    expect(sequence.chunkOrdinal).toBe(0);
    expect(fixture.source.reads).toHaveLength(0);

    const during = new AbortController();
    const duringReason = Object.freeze({ phase: 'during-chunk-offset' });
    fixture.source.onRead = () => {
      fixture.source.onRead = null;
      during.abort(duringReason);
    };
    await expect(sequence.readNext(during.signal)).rejects.toBe(duringReason);
    expect(sequence.chunkOrdinal).toBe(0);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[0]);
    expect(sequence.chunkOrdinal).toBe(1);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('treats source capacity as retryable without advancing or poisoning', async () => {
    const fixture = await buildFixture(4, 2);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);
    const busy = new EncodedSourceBusyError('fixture is temporarily busy');
    fixture.source.failures.push(busy);

    await expect(sequence.readNext(signal())).rejects.toBe(busy);
    expect(sequence.chunkOrdinal).toBe(0);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[0]);
    expect(sequence.chunkOrdinal).toBe(1);
  });

  it('rejects concurrent and source-reentrant reads without disturbing the active read', async () => {
    const fixture = await buildFixture(4, 2);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);
    let release: (() => void) | null = null;
    let enteredResolve: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = () => {
      fixture.source.onRead = null;
      enteredResolve?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const active = sequence.readNext(signal());
    await entered;
    await expect(sequence.readNext(signal())).rejects.toThrow(/concurrent or reentrant/i);
    if (release === null) throw new Error('blocked chunk-offset read was not installed');
    release();
    await expect(active).resolves.toBe(fixture.offsets[0]);
    expect(sequence.chunkOrdinal).toBe(1);

    const reentrantFixture = await buildFixture(4, 2);
    const reentrantSequence = createM4aChunkOffsetSequence(
      reentrantFixture.reader,
      reentrantFixture.index,
      0,
    );
    let reentrant: Promise<number | null> | null = null;
    reentrantFixture.source.onRead = () => {
      reentrantFixture.source.onRead = null;
      reentrant = reentrantSequence.readNext(signal());
      void reentrant.catch(() => undefined);
    };
    await expect(reentrantSequence.readNext(signal())).resolves.toBe(reentrantFixture.offsets[0]);
    if (reentrant === null) throw new Error('source did not attempt chunk-offset reentry');
    await expect(reentrant).rejects.toThrow(/concurrent or reentrant/i);
    expect(reentrantSequence.chunkOrdinal).toBe(1);
  });

  it('poisons on an authenticated-page mutation and preserves the original failure', async () => {
    const fixture = await buildFixture(4, 2);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);
    const byteOffset = fixture.index.chunkOffsetTableStart;
    fixture.source.bytes[byteOffset] = fixture.source.bytes[byteOffset]! ^ 1;
    const failure = await sequence.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EncodedSourceIntegrityError);
    expect(sequence.chunkOrdinal).toBe(0);
    fixture.source.bytes[byteOffset] = fixture.source.bytes[byteOffset]! ^ 1;
    const readCount = fixture.source.reads.length;
    await expect(sequence.readNext(signal())).rejects.toBe(failure);
    const laterAbort = new AbortController();
    laterAbort.abort(new Error('must not hide chunk-offset poison'));
    await expect(sequence.readNext(laterAbort.signal)).rejects.toBe(failure);
    expect(fixture.source.reads).toHaveLength(readCount);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('poisons on a short page without advancing or closing the borrowed source', async () => {
    const fixture = await buildFixture(8, 2);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);
    fixture.source.shortNextRead = true;
    const failure = await sequence.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EncodedSourceIntegrityError);
    expect(String(failure)).toMatch(/expected/i);
    expect(sequence.chunkOrdinal).toBe(0);
    await expect(sequence.readNext(signal())).rejects.toBe(failure);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('requires a real AbortSignal without poisoning the sequence', async () => {
    const fixture = await buildFixture(4, 1);
    const sequence = createM4aChunkOffsetSequence(fixture.reader, fixture.index, 0);
    await expect(sequence.readNext(null as never)).rejects.toThrow(/AbortSignal/i);
    await expect(sequence.readNext(signal())).resolves.toBe(fixture.offsets[0]);
  });
});

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class SparseSource implements EncodedRandomAccessSource {
  readonly identity = 'm4a-chunk-offset-sequence-sparse';
  readonly reads: ReadRecord[] = [];
  closeCalls = 0;

  constructor(
    readonly size: number,
    private readonly regions: readonly SparseRegion[],
  ) {}

  async readAt(offset: number, length: number, abortSignal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(abortSignal);
    this.reads.push(Object.freeze({ offset, length }));
    const region = this.regions.find(
      (candidate) =>
        offset >= candidate.offset && end <= candidate.offset + candidate.bytes.byteLength,
    );
    if (!region) throw new Error(`No sparse fixture bytes for [${offset}, ${end})`);
    return region.bytes.slice(offset - region.offset, end - region.offset);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

it('reads a safe greater-than-4-GiB co64 offset without touching media bytes', async () => {
  const hugeOffset = 5 * 1_024 * 1_024 * 1_024 + 123;
  const stsc = sampleToChunkBox();
  const stsz = fixedSampleSizeBox(1);
  const co64 = chunkOffsetBox(8, [hugeOffset]);
  const moov = box('moov', concatenate(stsc, stsz, co64));
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
  const runs = await readM4aSampleToChunkRuns(reader, refs.get('stsc')!, 1, signal());
  const sizes = await readM4aSampleSizeIndex(reader, refs.get('stsz')!, 1, signal());
  const index = await readM4aChunkIndex(reader, layout, runs, sizes, refs.get('co64')!, signal());
  source.reads.length = 0;
  const sequence = createM4aChunkOffsetSequence(reader, index, 0);

  await expect(sequence.readNext(signal())).resolves.toBe(hugeOffset);
  await expect(sequence.readNext(signal())).resolves.toBeNull();
  expect(source.reads).toHaveLength(1);
  expect(source.reads[0]!.offset).toBe(index.chunkOffsetTableStart);
  expect(source.reads.every((read) => read.offset < prefix.byteLength)).toBe(true);
  expect(source.closeCalls).toBe(0);
});
