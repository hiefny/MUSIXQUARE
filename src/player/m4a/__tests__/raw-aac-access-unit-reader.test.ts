import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  EncodedSourceBusyError,
  EncodedSourceIntegrityError,
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import { rehydrateM4aChunkIndex } from '../chunk-index.ts';
import { readM4aAacLcMetadata } from '../metadata.ts';
import {
  openSourceBoundM4aRawAacAccessUnitReader,
  type M4aRawAacAccessUnitReader,
} from '../raw-aac-access-unit-reader.ts';
import { rehydrateM4aSampleSizeIndex } from '../sample-size-index.ts';
import {
  buildM4aAacFixture,
  type M4aAacFixtureExpected,
  type M4aAacFixtureReadRecord,
} from './m4a-aac-fixture.ts';

function signal(): AbortSignal {
  return new AbortController().signal;
}

type ReadPredicate = (read: Readonly<M4aAacFixtureReadRecord>) => boolean;

class ControlledM4aSource implements EncodedRandomAccessSource {
  readonly reads: M4aAacFixtureReadRecord[] = [];
  readonly failures: Array<Readonly<{ predicate: ReadPredicate; error: unknown }>> = [];
  closeCalls = 0;
  onRead: ((read: Readonly<M4aAacFixtureReadRecord>) => void | Promise<void>) | null = null;
  shortNext: ReadPredicate | null = null;
  #identity: string;

  constructor(
    readonly bytes: Uint8Array,
    identity: string,
  ) {
    this.#identity = identity;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  get identity(): string {
    return this.#identity;
  }

  mutateIdentity(value: string): void {
    this.#identity = value;
  }

  async readAt(offset: number, length: number, abortSignal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(abortSignal);
    const read = Object.freeze({ offset, length });
    this.reads.push(read);
    const failureIndex = this.failures.findIndex((candidate) => candidate.predicate(read));
    if (failureIndex >= 0) throw this.failures.splice(failureIndex, 1)[0]!.error;
    await this.onRead?.(read);
    throwIfAborted(abortSignal);
    if (this.shortNext?.(read)) {
      this.shortNext = null;
      return this.bytes.slice(offset, Math.max(offset, end - 1));
    }
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class ReentrantAbortBoxReader extends IsoBmffBoxReader {
  afterReadable: (() => void) | null = null;

  override assertReadable(abortSignal: AbortSignal): void {
    super.assertReadable(abortSignal);
    this.afterReadable?.();
  }
}

async function openFixture(
  chunkOffsetBoxType: 'stco' | 'co64' = 'stco',
  createReader: (source: ControlledM4aSource) => IsoBmffBoxReader = (source) =>
    new IsoBmffBoxReader(source),
) {
  const built = buildM4aAacFixture({ chunkOffsetBoxType });
  const source = new ControlledM4aSource(
    built.bytes.slice(),
    `raw-aac-reader-${chunkOffsetBoxType}`,
  );
  const manifest = await readM4aAacLcMetadata(source, signal());
  const reader = createReader(source);
  const sourceBinding = Object.freeze({
    sourceSize: source.size,
    sourceIdentity: source.identity,
  });
  const sampleSizes = await rehydrateM4aSampleSizeIndex(
    reader,
    manifest.sampleSizes,
    sourceBinding,
    signal(),
  );
  const chunks = await rehydrateM4aChunkIndex(
    reader,
    manifest.chunks,
    sampleSizes,
    sourceBinding,
    signal(),
  );
  source.reads.length = 0;
  return { source, reader, manifest, sourceBinding, sampleSizes, chunks, expected: built.expected };
}

function isMediaRead(expected: Readonly<M4aAacFixtureExpected>): ReadPredicate {
  return ({ offset, length }) =>
    offset >= expected.mdatPayloadRange.start && offset + length <= expected.mdatPayloadRange.end;
}

describe('source-bound M4A raw AAC access-unit reader', () => {
  it.each(['stco', 'co64'] as const)(
    'reads every canonical %s access unit across chunk boundaries with one bounded media cache',
    async (chunkOffsetBoxType) => {
      const fixture = await openFixture(chunkOffsetBoxType);
      const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
        fixture.reader,
        fixture.sampleSizes,
        fixture.chunks,
        0,
        signal(),
      );
      fixture.source.reads.length = 0;

      let consumed = 0;
      for (const expected of fixture.expected.accessUnits) {
        const result = await cursor.readNext(signal());
        expect(result).not.toBeNull();
        expect(result!.bytes).toEqual(expected.payload);
        expect(result!.descriptor).toEqual({
          ordinal: expected.ordinal,
          sourceOffset: expected.offset,
          byteLength: expected.length,
          chunkOrdinal: Math.floor(expected.ordinal / 2),
          encodedBytePrefix: consumed,
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result!.descriptor)).toBe(true);
        consumed += expected.length;
        expect(cursor.nextAccessUnitOrdinal).toBe(expected.ordinal + 1);
        expect(cursor.consumedEncodedBytes).toBe(consumed);
      }
      await expect(cursor.readNext(signal())).resolves.toBeNull();
      await expect(cursor.readNext(signal())).resolves.toBeNull();
      const mediaReads = fixture.source.reads.filter(isMediaRead(fixture.expected));
      expect(mediaReads).toHaveLength(1);
      expect(mediaReads[0]).toEqual({
        offset: fixture.expected.mdatPayloadRange.start,
        length: fixture.expected.mdatPayloadRange.end - fixture.expected.mdatPayloadRange.start,
      });
      expect(fixture.source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
      expect(fixture.source.closeCalls).toBe(0);
    },
  );

  it('supports arbitrary and terminal starts with absolute logical prefixes', async () => {
    const fixture = await openFixture();
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      3,
      signal(),
    );
    expect(cursor.nextAccessUnitOrdinal).toBe(3);
    expect(cursor.consumedEncodedBytes).toBe(11 + 13 + 17);
    for (const expected of fixture.expected.accessUnits.slice(3)) {
      const result = await cursor.readNext(signal());
      expect(result?.descriptor.ordinal).toBe(expected.ordinal);
      expect(result?.bytes).toEqual(expected.payload);
    }
    await expect(cursor.readNext(signal())).resolves.toBeNull();

    fixture.source.reads.length = 0;
    const terminal = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      fixture.expected.accessUnits.length,
      signal(),
    );
    expect(terminal.consumedEncodedBytes).toBe(112);
    await expect(terminal.readNext(signal())).resolves.toBeNull();
    await expect(terminal.readNext(signal())).resolves.toBeNull();
    expect(fixture.source.reads).toHaveLength(0);
  });

  it('returns independent caller bytes and never closes the borrowed source', async () => {
    const fixture = await openFixture();
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    const first = await cursor.readNext(signal());
    first!.bytes.fill(0);
    expect(
      fixture.source.bytes.slice(
        first!.descriptor.sourceOffset,
        first!.descriptor.sourceOffset + 11,
      ),
    ).toEqual(fixture.expected.accessUnitPayloads[0]);
    const second = await cursor.readNext(signal());
    expect(second!.bytes).toEqual(fixture.expected.accessUnitPayloads[1]);
    cursor.close();
    cursor.close();
    await expect(cursor.readNext(signal())).rejects.toThrow(/closed/i);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('reseeds child metadata cursors after exact abort and busy failures', async () => {
    const fixture = await openFixture();
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    fixture.source.reads.length = 0;
    const nonMedia = (read: Readonly<M4aAacFixtureReadRecord>) =>
      !isMediaRead(fixture.expected)(read);
    const busy = new EncodedSourceBusyError('stsz page temporarily busy');
    fixture.source.failures.push(Object.freeze({ predicate: nonMedia, error: busy }));
    await expect(cursor.readNext(signal())).rejects.toBe(busy);
    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    expect(cursor.consumedEncodedBytes).toBe(0);
    await expect(cursor.readNext(signal())).resolves.toMatchObject({
      descriptor: { ordinal: 0, encodedBytePrefix: 0 },
    });

    const abortedFixture = await openFixture();
    const abortedCursor = await openSourceBoundM4aRawAacAccessUnitReader(
      abortedFixture.reader,
      abortedFixture.sampleSizes,
      abortedFixture.chunks,
      2,
      signal(),
    );
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'raw-aac-metadata' });
    abortedFixture.source.onRead = (read) => {
      if (!isMediaRead(abortedFixture.expected)(read)) {
        abortedFixture.source.onRead = null;
        controller.abort(reason);
      }
    };
    await expect(abortedCursor.readNext(controller.signal)).rejects.toBe(reason);
    expect(abortedCursor.nextAccessUnitOrdinal).toBe(2);
    await expect(abortedCursor.readNext(signal())).resolves.toMatchObject({
      descriptor: { ordinal: 2 },
    });
  });

  it('reseeds after abort and busy on media without skipping or publishing cache state', async () => {
    const fixture = await openFixture();
    const busyCursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    const busy = new EncodedSourceBusyError('media temporarily busy');
    fixture.source.failures.push(
      Object.freeze({ predicate: isMediaRead(fixture.expected), error: busy }),
    );
    await expect(busyCursor.readNext(signal())).rejects.toBe(busy);
    expect(busyCursor.nextAccessUnitOrdinal).toBe(0);
    await expect(busyCursor.readNext(signal())).resolves.toMatchObject({
      bytes: fixture.expected.accessUnitPayloads[0],
      descriptor: { ordinal: 0 },
    });

    const abortedFixture = await openFixture('co64');
    const abortedCursor = await openSourceBoundM4aRawAacAccessUnitReader(
      abortedFixture.reader,
      abortedFixture.sampleSizes,
      abortedFixture.chunks,
      0,
      signal(),
    );
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'raw-aac-media' });
    abortedFixture.source.onRead = (read) => {
      if (isMediaRead(abortedFixture.expected)(read)) {
        abortedFixture.source.onRead = null;
        controller.abort(reason);
      }
    };
    await expect(abortedCursor.readNext(controller.signal)).rejects.toBe(reason);
    expect(abortedCursor.nextAccessUnitOrdinal).toBe(0);
    expect(abortedCursor.consumedEncodedBytes).toBe(0);
    await expect(abortedCursor.readNext(signal())).resolves.toMatchObject({
      bytes: abortedFixture.expected.accessUnitPayloads[0],
      descriptor: { ordinal: 0, encodedBytePrefix: 0 },
    });
  });

  it('gives an exact reentrant abort precedence over a final secondary integrity error', async () => {
    let reader: ReentrantAbortBoxReader | null = null;
    const fixture = await openFixture(
      'stco',
      (source) => (reader = new ReentrantAbortBoxReader(source)),
    );
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'raw-aac-final-auth' });
    let mediaReadEntered = false;
    let postMediaReadableChecks = 0;
    fixture.source.onRead = (read) => {
      if (!isMediaRead(fixture.expected)(read)) return;
      fixture.source.onRead = null;
      mediaReadEntered = true;
    };
    if (reader === null) throw new Error('reentrant reader was not constructed');
    const activeReader: ReentrantAbortBoxReader = reader;
    activeReader.afterReadable = () => {
      if (!mediaReadEntered || ++postMediaReadableChecks !== 2) return;
      activeReader.afterReadable = null;
      controller.abort(reason);
      throw new EncodedSourceIntegrityError('secondary final source-stability failure');
    };

    await expect(cursor.readNext(controller.signal)).rejects.toBe(reason);
    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    expect(cursor.consumedEncodedBytes).toBe(0);
    await expect(cursor.readNext(signal())).resolves.toMatchObject({
      bytes: fixture.expected.accessUnitPayloads[0],
      descriptor: { ordinal: 0, encodedBytePrefix: 0 },
    });
  });

  it('does not poison on concurrency, but preserves the first exact structural failure', async () => {
    const fixture = await openFixture();
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    let enteredResolve: (() => void) | null = null;
    let release: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = (read) => {
      if (!isMediaRead(fixture.expected)(read)) return;
      fixture.source.onRead = null;
      enteredResolve?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const active = cursor.readNext(signal());
    await entered;
    await expect(cursor.readNext(signal())).rejects.toThrow(/concurrent or reentrant/i);
    if (release === null) throw new Error('media read was not blocked');
    release();
    await expect(active).resolves.toMatchObject({ descriptor: { ordinal: 0 } });
    expect(cursor.nextAccessUnitOrdinal).toBe(1);

    const reentrantFixture = await openFixture('co64');
    const reentrantCursor = await openSourceBoundM4aRawAacAccessUnitReader(
      reentrantFixture.reader,
      reentrantFixture.sampleSizes,
      reentrantFixture.chunks,
      0,
      signal(),
    );
    let reentrant: Promise<unknown> | null = null;
    reentrantFixture.source.onRead = (read) => {
      if (!isMediaRead(reentrantFixture.expected)(read)) return;
      reentrantFixture.source.onRead = null;
      reentrant = reentrantCursor.readNext(signal());
      void reentrant.catch(() => undefined);
    };
    await expect(reentrantCursor.readNext(signal())).resolves.toMatchObject({
      descriptor: { ordinal: 0 },
    });
    if (reentrant === null) throw new Error('source did not attempt raw AAC reader reentry');
    await expect(reentrant).rejects.toThrow(/concurrent or reentrant/i);
    await expect(reentrantCursor.readNext(signal())).resolves.toMatchObject({
      descriptor: { ordinal: 1 },
    });

    const poisoned = await openFixture();
    const poisonedCursor = await openSourceBoundM4aRawAacAccessUnitReader(
      poisoned.reader,
      poisoned.sampleSizes,
      poisoned.chunks,
      0,
      signal(),
    );
    poisoned.source.bytes[poisoned.sampleSizes.entryTableStart]! ^= 1;
    const failure = await poisonedCursor.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EncodedSourceIntegrityError);
    poisoned.source.bytes[poisoned.sampleSizes.entryTableStart]! ^= 1;
    const reads = poisoned.source.reads.length;
    await expect(poisonedCursor.readNext(signal())).rejects.toBe(failure);
    expect(poisoned.source.reads).toHaveLength(reads);
  });

  it('poisons a short media read and prevents a late close from publishing', async () => {
    const fixture = await openFixture();
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    fixture.source.shortNext = isMediaRead(fixture.expected);
    const failure = await cursor.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EncodedSourceIntegrityError);
    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    await expect(cursor.readNext(signal())).rejects.toBe(failure);

    const closing = await openFixture();
    const closingCursor = await openSourceBoundM4aRawAacAccessUnitReader(
      closing.reader,
      closing.sampleSizes,
      closing.chunks,
      0,
      signal(),
    );
    let release: (() => void) | null = null;
    let enteredResolve: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    closing.source.onRead = (read) => {
      if (!isMediaRead(closing.expected)(read)) return;
      closing.source.onRead = null;
      enteredResolve?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const active = closingCursor.readNext(signal());
    await entered;
    closingCursor.close();
    if (release === null) throw new Error('closing media read was not blocked');
    release();
    await expect(active).rejects.toThrow(/closed/i);
    expect(closingCursor.nextAccessUnitOrdinal).toBe(0);
    expect(closingCursor.consumedEncodedBytes).toBe(0);
    expect(closing.source.closeCalls).toBe(0);
  });

  it('stops after close during blocked metadata without starting later source I/O', async () => {
    const fixture = await openFixture();
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    fixture.source.reads.length = 0;
    let enteredResolve: (() => void) | null = null;
    let release: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    fixture.source.onRead = (read) => {
      if (isMediaRead(fixture.expected)(read)) return;
      fixture.source.onRead = null;
      enteredResolve?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const active = cursor.readNext(signal());
    await entered;
    cursor.close();
    const readsAtClose = fixture.source.reads.length;
    if (release === null) throw new Error('metadata read was not blocked');
    release();
    const closedError = await active.catch((error: unknown) => error);
    expect(String(closedError)).toMatch(/closed/i);
    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    expect(cursor.consumedEncodedBytes).toBe(0);
    expect(fixture.source.reads).toHaveLength(readsAtClose);
    expect(fixture.source.reads.some(isMediaRead(fixture.expected))).toBe(false);
    await expect(cursor.readNext(signal())).rejects.toBe(closedError);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('stops before source I/O when source validation reentrantly closes the cursor', async () => {
    let reader: ReentrantAbortBoxReader | null = null;
    const fixture = await openFixture(
      'co64',
      (source) => (reader = new ReentrantAbortBoxReader(source)),
    );
    const cursor = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    fixture.source.reads.length = 0;
    if (reader === null) throw new Error('reentrant reader was not constructed');
    const activeReader: ReentrantAbortBoxReader = reader;
    activeReader.afterReadable = () => {
      activeReader.afterReadable = null;
      cursor.close();
    };

    const closedError = await cursor.readNext(signal()).catch((error: unknown) => error);
    expect(String(closedError)).toMatch(/closed/i);
    expect(cursor.nextAccessUnitOrdinal).toBe(0);
    expect(cursor.consumedEncodedBytes).toBe(0);
    expect(fixture.source.reads).toHaveLength(0);
    await expect(cursor.readNext(signal())).rejects.toBe(closedError);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('rejects a same-reader chunk index paired with a different issued stsz authority', async () => {
    const fixture = await openFixture();
    const secondSampleSizes = await rehydrateM4aSampleSizeIndex(
      fixture.reader,
      fixture.manifest.sampleSizes,
      fixture.sourceBinding,
      signal(),
    );
    await expect(
      openSourceBoundM4aRawAacAccessUnitReader(
        fixture.reader,
        secondSampleSizes,
        fixture.chunks,
        0,
        signal(),
      ),
    ).rejects.toThrow(/different sample-size authority/i);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('poisons source identity mutation without reading media or closing the source', async () => {
    const fixture = await openFixture();
    const cursor: M4aRawAacAccessUnitReader = await openSourceBoundM4aRawAacAccessUnitReader(
      fixture.reader,
      fixture.sampleSizes,
      fixture.chunks,
      0,
      signal(),
    );
    fixture.source.reads.length = 0;
    fixture.source.mutateIdentity('mutated-raw-aac-source');
    const failure = await cursor.readNext(signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EncodedSourceIntegrityError);
    await expect(cursor.readNext(signal())).rejects.toBe(failure);
    expect(fixture.source.reads).toHaveLength(0);
    expect(fixture.source.closeCalls).toBe(0);
  });
});
