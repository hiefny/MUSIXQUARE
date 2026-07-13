import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  assertM4aSampleToChunkRunTableProvenance,
  createM4aSampleSizeSequence,
  readM4aSamplePrefixBytes,
  readM4aSampleSizeAt,
  readM4aSampleSizeIndex,
  readM4aSampleToChunkRuns,
} from '../sample-size-index.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + body.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength, false);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(body, 8);
  return result;
}

function stscBody(
  entries: readonly (readonly [number, number, number])[],
  declaredCount = entries.length,
  suffix = new Uint8Array(0),
): Uint8Array {
  const result = new Uint8Array(8 + entries.length * 12 + suffix.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(4, declaredCount, false);
  entries.forEach(([firstChunk, samplesPerChunk, description], index) => {
    const offset = 8 + index * 12;
    view.setUint32(offset, firstChunk, false);
    view.setUint32(offset + 4, samplesPerChunk, false);
    view.setUint32(offset + 8, description, false);
  });
  result.set(suffix, 8 + entries.length * 12);
  return result;
}

function stszBody(
  fixedSampleSize: number,
  sizes: readonly number[],
  declaredCount = sizes.length,
  suffix = new Uint8Array(0),
): Uint8Array {
  const entryCount = fixedSampleSize === 0 ? sizes.length : 0;
  const result = new Uint8Array(12 + entryCount * 4 + suffix.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(4, fixedSampleSize, false);
  view.setUint32(8, declaredCount, false);
  if (fixedSampleSize === 0) {
    sizes.forEach((size, index) => view.setUint32(12 + index * 4, size, false));
  }
  result.set(suffix, 12 + entryCount * 4);
  return result;
}

class MemorySource implements EncodedRandomAccessSource {
  identity = 'm4a-sample-size-fixture';
  readonly reads: ReadRecord[] = [];
  closeCalls = 0;
  mutateIdentityAfterRead = false;
  blockNextRead = false;
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
    if (this.mutateIdentityAfterRead) this.identity = 'mutated-m4a-sample-size-fixture';
    return result;
  }

  releaseRead(): void {
    this.#releaseRead?.();
    this.#releaseRead = null;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function rootRef(reader: IsoBmffBoxReader) {
  const ref = await reader.createCursor().next(signal());
  if (ref === null) throw new Error('fixture root is missing');
  return ref;
}

async function indexedVariable(sizes: readonly number[]) {
  const source = new MemorySource(box('stsz', stszBody(0, sizes)));
  const reader = new IsoBmffBoxReader(source);
  const index = await readM4aSampleSizeIndex(reader, await rootRef(reader), sizes.length, signal());
  return { source, reader, index };
}

describe('bounded M4A stsc runs', () => {
  it('retains frozen increasing runs without an arbitrary per-chunk cap', async () => {
    const sampleCount = 1_000_000;
    const source = new MemorySource(
      box(
        'stsc',
        stscBody([
          [1, sampleCount, 1],
          [3, 27, 1],
        ]),
      ),
    );
    const reader = new IsoBmffBoxReader(source);
    const result = await readM4aSampleToChunkRuns(
      reader,
      await rootRef(reader),
      sampleCount,
      signal(),
    );

    expect(result).toEqual({
      sampleCount,
      runs: [
        { firstChunk: 1, samplesPerChunk: sampleCount, sampleDescriptionIndex: 1 },
        { firstChunk: 3, samplesPerChunk: 27, sampleDescriptionIndex: 1 },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.runs)).toBe(true);
    expect(result.runs.every(Object.isFrozen)).toBe(true);
    expect(source.closeCalls).toBe(0);
  });

  it.each([
    [
      'nonzero flags',
      (() => {
        const value = stscBody([[1, 1, 1]]);
        value[3] = 1;
        return value;
      })(),
      /version and flags/,
    ],
    ['zero entries', stscBody([], 0), /entry count/],
    ['too many entries', stscBody([], 2_049), /entry count/],
    ['first chunk not one', stscBody([[2, 1, 1]]), /chunk 1/],
    [
      'nonincreasing chunks',
      stscBody([
        [1, 1, 1],
        [1, 1, 1],
      ]),
      /strictly increasing/,
    ],
    ['zero samples', stscBody([[1, 0, 1]]), /samples per chunk/],
    ['too many samples', stscBody([[1, 3, 1]]), /samples per chunk/],
    ['foreign description', stscBody([[1, 1, 2]]), /exactly 1/],
    ['trailing byte', stscBody([[1, 1, 1]], 1, Uint8Array.of(0)), /expected 20/],
  ] as const)('rejects %s', async (_label, body, message) => {
    const source = new MemorySource(box('stsc', body));
    const reader = new IsoBmffBoxReader(source);
    await expect(
      readM4aSampleToChunkRuns(reader, await rootRef(reader), 2, signal()),
    ).rejects.toThrow(message);
  });

  it('rejects wrong and foreign box references before reading their fields', async () => {
    const stszSource = new MemorySource(box('stsz', stszBody(7, [7])));
    const stszReader = new IsoBmffBoxReader(stszSource);
    await expect(
      readM4aSampleToChunkRuns(stszReader, await rootRef(stszReader), 1, signal()),
    ).rejects.toThrow(/must be an stsc/);

    const source = new MemorySource(box('stsc', stscBody([[1, 1, 1]])));
    const first = new IsoBmffBoxReader(source);
    const foreign = await rootRef(first);
    await expect(
      readM4aSampleToChunkRuns(new IsoBmffBoxReader(source), foreign, 1, signal()),
    ).rejects.toThrow(/not issued by this reader/);
  });

  it('recovers only the exact issued table for its stable source reader', async () => {
    const source = new MemorySource(box('stsc', stscBody([[1, 1, 1]])));
    const reader = new IsoBmffBoxReader(source);
    const table = await readM4aSampleToChunkRuns(reader, await rootRef(reader), 1, signal());

    expect(assertM4aSampleToChunkRunTableProvenance(reader, table, signal())).toBe(table);
    expect(() => assertM4aSampleToChunkRunTableProvenance(reader, { ...table }, signal())).toThrow(
      /provenance/,
    );
    expect(() =>
      assertM4aSampleToChunkRunTableProvenance(new IsoBmffBoxReader(source), table, signal()),
    ).toThrow(/different source reader/);

    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'stsc-provenance' });
    controller.abort(reason);
    expect(() =>
      assertM4aSampleToChunkRunTableProvenance(reader, table, controller.signal),
    ).toThrow(reason);
  });
});

describe('bounded M4A stsz indexes', () => {
  it('indexes a fixed-size table in O(1) with exact endpoint evidence', async () => {
    const source = new MemorySource(box('stsz', stszBody(8_191, Array(4).fill(8_191))));
    const reader = new IsoBmffBoxReader(source);
    const index = await readM4aSampleSizeIndex(reader, await rootRef(reader), 4, signal());

    expect(index).toMatchObject({
      sampleCount: 4,
      fixedSampleSizeBytes: 8_191,
      totalEncodedBytes: 32_764,
      checkpointStride: 0,
      checkpoints: [
        { ordinal: 0, prefixBytes: 0 },
        { ordinal: 4, prefixBytes: 32_764 },
      ],
    });
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.checkpoints)).toBe(true);
    expect(await readM4aSampleSizeAt(reader, index, 3, signal())).toBe(8_191);
    expect(await readM4aSamplePrefixBytes(reader, index, 3, signal())).toBe(24_573);
    expect(source.closeCalls).toBe(0);
  });

  it('pages and sparsely indexes a greater-than-64-KiB variable table', async () => {
    const sizes = Array.from({ length: 20_001 }, (_, index) => (index % 8_191) + 1);
    const expectedTotal = sizes.reduce((sum, size) => sum + size, 0);
    const { source, index } = await indexedVariable(sizes);

    expect(index.totalEncodedBytes).toBe(expectedTotal);
    expect(index.checkpointStride).toBe(Math.ceil(sizes.length / 8_191));
    expect(index.checkpoints[0]).toEqual({ ordinal: 0, prefixBytes: 0 });
    expect(index.checkpoints.at(-1)).toEqual({
      ordinal: sizes.length,
      prefixBytes: expectedTotal,
    });
    expect(index.checkpoints.length).toBeLessThanOrEqual(8_192);
    expect(index.checkpoints.every(Object.isFrozen)).toBe(true);
    expect(source.reads.some((read) => read.length === 64 * 1_024)).toBe(true);
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('proves the checkpoint cap at and immediately above the dense boundary', async () => {
    const dense = await indexedVariable(Array(8_191).fill(1));
    expect(dense.index.checkpointStride).toBe(1);
    expect(dense.index.checkpoints).toHaveLength(8_192);

    const sparse = await indexedVariable(Array(8_192).fill(1));
    expect(sparse.index.checkpointStride).toBe(2);
    expect(sparse.index.checkpoints).toHaveLength(4_097);
  });

  it.each([
    ['fixed size too large', stszBody(8_192, [8_192]), 1, /at most 8191/],
    ['variable zero', stszBody(0, [0]), 1, /size must be from 1/],
    ['variable too large', stszBody(0, [8_192]), 1, /size must be from 1/],
    ['count mismatch', stszBody(0, [1], 2), 1, /does not match expected/],
    ['fixed trailing bytes', stszBody(1, [1], 1, Uint8Array.of(0)), 1, /expected 12/],
    ['variable trailing bytes', stszBody(0, [1], 1, Uint8Array.of(0)), 1, /expected 16/],
  ] as const)('rejects %s', async (_label, body, expectedCount, message) => {
    const source = new MemorySource(box('stsz', body));
    const reader = new IsoBmffBoxReader(source);
    await expect(
      readM4aSampleSizeIndex(reader, await rootRef(reader), expectedCount, signal()),
    ).rejects.toThrow(message);
  });

  it('serves exact random sizes and prefixes with one bounded authenticated segment reread', async () => {
    const sizes = Array.from({ length: 20_001 }, (_, index) => (index % 113) + 1);
    const { source, reader, index } = await indexedVariable(sizes);
    source.reads.length = 0;
    const ordinal = 12_345;

    expect(await readM4aSampleSizeAt(reader, index, ordinal, signal())).toBe(sizes[ordinal]);
    expect(await readM4aSamplePrefixBytes(reader, index, ordinal, signal())).toBe(
      sizes.slice(0, ordinal).reduce((sum, size) => sum + size, 0),
    );
    expect(await readM4aSamplePrefixBytes(reader, index, sizes.length, signal())).toBe(
      index.totalEncodedBytes,
    );
    expect(source.reads.every((read) => read.length <= index.checkpointStride * 4)).toBe(true);
  });

  it('rejects cloned, inherited, foreign-reader, and out-of-range lookup inputs', async () => {
    const { source, reader, index } = await indexedVariable([3, 5, 7]);
    await expect(readM4aSampleSizeAt(reader, { ...index }, 0, signal())).rejects.toThrow(
      /provenance/,
    );
    await expect(
      readM4aSamplePrefixBytes(reader, Object.create(index), 0, signal()),
    ).rejects.toThrow(/provenance/);
    await expect(
      readM4aSampleSizeAt(new IsoBmffBoxReader(source), index, 0, signal()),
    ).rejects.toThrow(/different source reader/);
    await expect(readM4aSampleSizeAt(reader, index, 3, signal())).rejects.toThrow(/ordinal/);
    await expect(readM4aSamplePrefixBytes(reader, index, 4, signal())).rejects.toThrow(/ordinal/);
  });

  it('preserves abort reasons and detects same-identity table mutation', async () => {
    const { source, reader, index } = await indexedVariable([3, 5, 7, 11]);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'sample-size-before' });
    controller.abort(reason);
    await expect(readM4aSampleSizeAt(reader, index, 0, controller.signal)).rejects.toBe(reason);

    // First entry begins after the outer header and the 12-byte stsz header.
    source.bytes[8 + 12 + 3] = 4;
    await expect(readM4aSampleSizeAt(reader, index, 0, signal())).rejects.toThrow(
      /changed after the index/,
    );
  });

  it('detects source identity mutation without taking source ownership', async () => {
    const { source, reader, index } = await indexedVariable([3, 5, 7]);
    source.mutateIdentityAfterRead = true;
    await expect(readM4aSampleSizeAt(reader, index, 0, signal())).rejects.toThrow(/source changed/);
    expect(source.closeCalls).toBe(0);
  });
});

describe('sequential M4A sample-size summation', () => {
  it('reuses each 64-KiB variable-table page across arbitrarily split calls', async () => {
    const sizes = Array.from({ length: 32_777 }, (_, index) => (index % 127) + 1);
    const { source, reader, index } = await indexedVariable(sizes);
    source.reads.length = 0;
    const sequence = createM4aSampleSizeSequence(reader, index);

    let consumed = 0;
    for (const count of [10_000, 9_000, 13_777]) {
      expect(await sequence.sumNext(count, signal())).toBe(
        sizes.slice(consumed, consumed + count).reduce((sum, size) => sum + size, 0),
      );
      consumed += count;
      expect(sequence.ordinal).toBe(consumed);
    }
    expect(sequence.ordinal).toBe(sizes.length);
    expect(source.reads).toHaveLength(3);
    expect(new Set(source.reads.map((read) => read.offset)).size).toBe(3);
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('uses O(1) arithmetic for fixed tables and supports an explicit start ordinal', async () => {
    const source = new MemorySource(box('stsz', stszBody(17, Array(9).fill(17))));
    const reader = new IsoBmffBoxReader(source);
    const index = await readM4aSampleSizeIndex(reader, await rootRef(reader), 9, signal());
    source.reads.length = 0;
    const sequence = createM4aSampleSizeSequence(reader, index, 4);

    expect(await sequence.sumNext(5, signal())).toBe(85);
    expect(sequence.ordinal).toBe(9);
    expect(await sequence.sumNext(0, signal())).toBe(0);
    expect(source.reads).toHaveLength(0);
    await expect(sequence.sumNext(1, signal())).rejects.toThrow(/sample count/);
  });

  it('authenticates a bounded preceding segment before a variable non-checkpoint start', async () => {
    const sizes = Array.from({ length: 8_192 }, (_, index) => (index % 31) + 1);
    const { source, reader, index } = await indexedVariable(sizes);
    expect(index.checkpointStride).toBe(2);
    source.reads.length = 0;
    const sequence = createM4aSampleSizeSequence(reader, index, 1);

    expect(await sequence.sumNext(5, signal())).toBe(
      sizes.slice(1, 6).reduce((sum, size) => sum + size, 0),
    );
    expect(sequence.ordinal).toBe(6);
    expect(source.reads[0]).toMatchObject({ length: index.checkpointStride * 4 });
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('rejects mutation in the bounded segment preceding a variable non-checkpoint start', async () => {
    const sizes = Array(8_192).fill(3);
    const { source, reader, index } = await indexedVariable(sizes);
    expect(index.checkpointStride).toBe(2);
    // The sequence begins at sample one, but sample zero remains part of the
    // sparse segment that authenticates the starting prefix.
    source.bytes[8 + 12 + 3] = 4;
    const sequence = createM4aSampleSizeSequence(reader, index, 1);

    await expect(sequence.sumNext(1, signal())).rejects.toThrow(/changed after the index/);
    expect(sequence.ordinal).toBe(1);
  });

  it('leaves a lazy variable-start authentication transactional across abort and retry', async () => {
    const sizes = Array.from({ length: 8_192 }, (_, index) => (index % 13) + 1);
    const { source, reader, index } = await indexedVariable(sizes);
    const sequence = createM4aSampleSizeSequence(reader, index, 1);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'variable-start-authentication' });
    source.blockNextRead = true;
    const interrupted = sequence.sumNext(2, controller.signal);
    await Promise.resolve();
    controller.abort(reason);
    source.releaseRead();

    await expect(interrupted).rejects.toBe(reason);
    expect(sequence.ordinal).toBe(1);
    await expect(sequence.sumNext(2, signal())).resolves.toBe(sizes[1]! + sizes[2]!);
    expect(sequence.ordinal).toBe(3);
  });

  it('rejects concurrent reads and commits its ordinal only after a successful read', async () => {
    const { source, reader, index } = await indexedVariable([3, 5, 7]);
    source.reads.length = 0;
    const sequence = createM4aSampleSizeSequence(reader, index);
    source.blockNextRead = true;
    const first = sequence.sumNext(2, signal());
    await Promise.resolve();
    await expect(sequence.sumNext(1, signal())).rejects.toThrow(/Concurrent/);
    expect(sequence.ordinal).toBe(0);
    source.releaseRead();
    await expect(first).resolves.toBe(8);
    expect(sequence.ordinal).toBe(2);
  });

  it('checks indexed prefixes while streaming and rejects pre-sequence table mutation', async () => {
    const sizes = Array(8_192).fill(3);
    const { source, reader, index } = await indexedVariable(sizes);
    expect(index.checkpointStride).toBe(2);
    // Change sample zero after indexing but before the sequential cursor owns
    // its first bounded page snapshot.
    source.bytes[8 + 12 + 3] = 4;
    const sequence = createM4aSampleSizeSequence(reader, index);

    // The second sample reaches the first sparse prefix checkpoint.
    await expect(sequence.sumNext(1, signal())).resolves.toBe(4);
    await expect(sequence.sumNext(1, signal())).rejects.toThrow(/sequential index/);
    expect(sequence.ordinal).toBe(1);
  });

  it('requires an authentic same-reader index and preserves abort at EOF', async () => {
    const { source, reader, index } = await indexedVariable([3]);
    expect(() => createM4aSampleSizeSequence(reader, { ...index })).toThrow(/provenance/);
    expect(() => createM4aSampleSizeSequence(new IsoBmffBoxReader(source), index)).toThrow(
      /different source reader/,
    );

    const sequence = createM4aSampleSizeSequence(reader, index, 1);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'sequence-eof' });
    controller.abort(reason);
    await expect(sequence.sumNext(0, controller.signal)).rejects.toBe(reason);
  });
});
