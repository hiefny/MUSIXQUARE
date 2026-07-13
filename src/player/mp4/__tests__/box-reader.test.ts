import { describe, expect, it } from 'vitest';

import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  ISO_BMFF_DEFAULT_MAX_BOXES,
  ISO_BMFF_HARD_MAX_BOXES,
  ISO_BMFF_MAX_BOUNDED_READ_BYTES,
  ISO_BMFF_MAX_HEADER_TAIL_READ_BYTES,
  IsoBmffBoxReader,
  type IsoBmffBoxCursor,
} from '../box-reader.ts';
import { IsoBmffBoxError } from '../box.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

function writeType(bytes: Uint8Array, type: string): void {
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
}

function standardHeader(type: string, size: number): Uint8Array {
  const headerBytes = type === 'uuid' ? 24 : 8;
  const bytes = new Uint8Array(headerBytes);
  new DataView(bytes.buffer).setUint32(0, size, false);
  writeType(bytes, type);
  if (type === 'uuid') bytes.fill(0xa5, 8);
  return bytes;
}

function largeHeader(type: string, size: number): Uint8Array {
  const headerBytes = type === 'uuid' ? 32 : 16;
  const bytes = new Uint8Array(headerBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, false);
  writeType(bytes, type);
  view.setBigUint64(8, BigInt(size), false);
  if (type === 'uuid') bytes.fill(0x5a, 16);
  return bytes;
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

function container(type: string, ...children: readonly Uint8Array[]): Uint8Array {
  const body = concatenate(...children);
  return concatenate(standardHeader(type, 8 + body.byteLength), body);
}

class SparseSource implements EncodedRandomAccessSource {
  identity = 'iso-bmff-sparse-fixture';
  readonly reads: ReadRecord[] = [];

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
    if (!region) throw new Error(`No sparse bytes for [${offset}, ${end})`);
    const start = offset - region.offset;
    return region.bytes.slice(start, start + length);
  }

  async close(): Promise<void> {}
}

function sourceFrom(bytes: Uint8Array): SparseSource {
  return new SparseSource(bytes.byteLength, [{ offset: 0, bytes }]);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ISO BMFF source-bound box reader', () => {
  it('walks ordinary siblings without reading any body bytes', async () => {
    const bytes = concatenate(
      standardHeader('ftyp', 12),
      Uint8Array.of(1, 2, 3, 4),
      standardHeader('moov', 8),
    );
    const source = sourceFrom(bytes);
    const cursor = new IsoBmffBoxReader(source).createCursor();

    await expect(cursor.next(signal())).resolves.toMatchObject({
      type: 'ftyp',
      start: 0,
      end: 12,
    });
    await expect(cursor.next(signal())).resolves.toMatchObject({
      type: 'moov',
      start: 12,
      end: 20,
    });
    await expect(cursor.next(signal())).resolves.toBeNull();
    expect(source.reads).toEqual([
      { offset: 0, length: 8 },
      { offset: 12, length: 8 },
    ]);
  });

  it('jumps over a greater-than-4-GiB mdat to a tail moov by exact offsets', async () => {
    const mdatSize = 5 * 1_024 * 1_024 * 1_024;
    const moov = standardHeader('moov', 8);
    const source = new SparseSource(mdatSize + moov.byteLength, [
      { offset: 0, bytes: largeHeader('mdat', mdatSize) },
      { offset: mdatSize, bytes: moov },
    ]);
    const cursor = new IsoBmffBoxReader(source).createCursor();

    await expect(cursor.next(signal())).resolves.toMatchObject({
      type: 'mdat',
      size: mdatSize,
      headerBytes: 16,
      end: mdatSize,
    });
    await expect(cursor.next(signal())).resolves.toMatchObject({
      type: 'moov',
      start: mdatSize,
      end: mdatSize + 8,
    });
    expect(source.reads).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: 8 },
      { offset: mdatSize, length: 8 },
    ]);
  });

  it('bounds a large uuid header to an 8-byte base and one 24-byte tail read', async () => {
    const header = largeHeader('uuid', 32);
    const source = sourceFrom(header);

    await expect(new IsoBmffBoxReader(source).createCursor().next(signal())).resolves.toMatchObject(
      {
        type: 'uuid',
        headerBytes: 32,
        dataStart: 32,
      },
    );
    expect(source.reads).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: ISO_BMFF_MAX_HEADER_TAIL_READ_BYTES },
    ]);
  });

  it('rejects size-zero by default and admits it only for an explicitly opted-in cursor', async () => {
    const header = standardHeader('mdat', 0);

    await expect(
      new IsoBmffBoxReader(sourceFrom(header)).createCursor().next(signal()),
    ).rejects.toThrow(/size-zero box is not allowed/);
    await expect(
      new IsoBmffBoxReader(sourceFrom(header))
        .createCursor({ allowExtendsToEnd: true })
        .next(signal()),
    ).resolves.toMatchObject({ size: 8, end: 8, extendsToEnd: true });
  });

  it('makes nested size-zero opt-in independently of the top-level cursor', async () => {
    const parentBytes = container('moov', standardHeader('free', 0));
    const reader = new IsoBmffBoxReader(sourceFrom(parentBytes));
    const parent = await reader.createCursor().next(signal());
    expect(parent).not.toBeNull();

    await expect(reader.createChildCursor(parent!).next(signal())).rejects.toThrow(
      /size-zero box is not allowed/,
    );
    await expect(
      reader.createChildCursor(parent!, { allowExtendsToEnd: true }).next(signal()),
    ).resolves.toMatchObject({ type: 'free', start: 8, end: 16, extendsToEnd: true });
  });

  it('shares one global successful-header budget across top-level and nested cursors', async () => {
    const parentBytes = container('moov', standardHeader('trak', 8), standardHeader('free', 8));
    const reader = new IsoBmffBoxReader(sourceFrom(parentBytes), { maxBoxes: 2 });
    const parent = await reader.createCursor().next(signal());
    const children = reader.createChildCursor(parent!);

    await expect(children.next(signal())).resolves.toMatchObject({ type: 'trak' });
    await expect(children.next(signal())).rejects.toThrow(/shared limit of 2/);
    expect(children.offset).toBe(16);
  });

  it('enforces the hard box-budget range', () => {
    const source = sourceFrom(standardHeader('free', 8));
    expect(() => new IsoBmffBoxReader(source, { maxBoxes: 0 })).toThrow(/from 1 through/);
    expect(() => new IsoBmffBoxReader(source, { maxBoxes: ISO_BMFF_HARD_MAX_BOXES + 1 })).toThrow(
      /from 1 through/,
    );
    expect(() => new IsoBmffBoxReader(source, { maxBoxes: ISO_BMFF_HARD_MAX_BOXES })).not.toThrow();
  });

  it('uses a 1024-box default budget', async () => {
    expect(ISO_BMFF_DEFAULT_MAX_BOXES).toBe(1_024);
    const headers = Array.from({ length: ISO_BMFF_DEFAULT_MAX_BOXES + 1 }, () =>
      standardHeader('free', 8),
    );
    const cursor = new IsoBmffBoxReader(sourceFrom(concatenate(...headers))).createCursor();
    for (let index = 0; index < ISO_BMFF_DEFAULT_MAX_BOXES; index += 1) {
      await expect(cursor.next(signal())).resolves.toMatchObject({ type: 'free' });
    }
    await expect(cursor.next(signal())).rejects.toThrow(/shared limit of 1024/);
    expect(cursor.offset).toBe(ISO_BMFF_DEFAULT_MAX_BOXES * 8);
  });

  it.each([
    ['short ordinary header', new Uint8Array(7), /inside a box header/],
    ['truncated large header', largeHeader('mdat', 16).slice(0, 12), /truncates an extended/],
    ['parent escape', standardHeader('free', 16), /escapes its parent/],
    ['undersized header', standardHeader('free', 7), /smaller than its 8-byte/],
  ])('fails closed for a %s', async (_name, bytes, message) => {
    await expect(
      new IsoBmffBoxReader(sourceFrom(bytes)).createCursor().next(signal()),
    ).rejects.toThrow(message);
  });

  it('keeps the cursor offset unchanged after a short source result', async () => {
    const bytes = standardHeader('free', 8);
    let first = true;
    const source: EncodedRandomAccessSource = {
      size: bytes.byteLength,
      identity: 'short-once-source',
      async readAt(): Promise<Uint8Array> {
        if (first) {
          first = false;
          return bytes.slice(0, 7);
        }
        return bytes.slice();
      },
      async close(): Promise<void> {},
    };
    const cursor = new IsoBmffBoxReader(source).createCursor();

    await expect(cursor.next(signal())).rejects.toThrow(/returned 7 bytes; expected 8/);
    expect(cursor.offset).toBe(0);
    await expect(cursor.next(signal())).resolves.toMatchObject({ type: 'free', end: 8 });
  });

  it('rejects non-byte, shared, and source-mutated header results', async () => {
    const header = standardHeader('free', 8);
    const nonBytes: EncodedRandomAccessSource = {
      size: 8,
      identity: 'non-byte-source',
      async readAt(): Promise<Uint8Array> {
        return new DataView(new ArrayBuffer(8)) as unknown as Uint8Array;
      },
      async close(): Promise<void> {},
    };
    await expect(new IsoBmffBoxReader(nonBytes).createCursor().next(signal())).rejects.toThrow(
      /readable non-shared Uint8Array/,
    );

    const shared: EncodedRandomAccessSource = {
      size: 8,
      identity: 'shared-source',
      async readAt(): Promise<Uint8Array> {
        const result = new Uint8Array(new SharedArrayBuffer(8));
        result.set(header);
        return result;
      },
      async close(): Promise<void> {},
    };
    await expect(new IsoBmffBoxReader(shared).createCursor().next(signal())).rejects.toThrow(
      /non-shared/,
    );

    const mutable = new SparseSource(8, [{ offset: 0, bytes: header }]);
    const read = mutable.readAt.bind(mutable);
    mutable.readAt = async (offset, length, abortSignal) => {
      const result = await read(offset, length, abortSignal);
      mutable.identity = 'changed-source';
      return result;
    };
    await expect(new IsoBmffBoxReader(mutable).createCursor().next(signal())).rejects.toThrow(
      /source changed/,
    );
  });

  it('copies transport bytes before returning a reference', async () => {
    const transportHeader = standardHeader('free', 8);
    const source: EncodedRandomAccessSource = {
      size: 8,
      identity: 'mutable-result-source',
      async readAt(): Promise<Uint8Array> {
        return transportHeader;
      },
      async close(): Promise<void> {},
    };

    const ref = await new IsoBmffBoxReader(source).createCursor().next(signal());
    transportHeader.fill(0);
    expect(ref).toMatchObject({ type: 'free', size: 8, end: 8 });
  });

  it('provides an owned bounded manifest read without consuming box budget', async () => {
    const header = standardHeader('free', 8);
    const backing = new Uint8Array(32);
    backing.set(header, 12);
    const source: EncodedRandomAccessSource = {
      size: 8,
      identity: 'bounded-read-source',
      async readAt(offset, length, abortSignal): Promise<Uint8Array> {
        validateExactRead(this.size, offset, length);
        throwIfAborted(abortSignal);
        return backing.subarray(12 + offset, 12 + offset + length);
      },
      async close(): Promise<void> {},
    };
    const reader = new IsoBmffBoxReader(source, { maxBoxes: 1 });

    const bytes = await reader.readBytes(0, 8, signal());
    expect(bytes).toEqual(header);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(8);
    backing.fill(0);
    expect(bytes).toEqual(header);
    backing.set(header, 12);

    // The direct byte read does not consume the one available box slot.
    await expect(reader.createCursor().next(signal())).resolves.toMatchObject({
      type: 'free',
      end: 8,
    });
  });

  it('accepts zero through 64 KiB bounded reads and rejects larger or escaping ranges', async () => {
    const bytes = new Uint8Array(ISO_BMFF_MAX_BOUNDED_READ_BYTES);
    bytes[0] = 7;
    bytes[bytes.byteLength - 1] = 9;
    const source = sourceFrom(bytes);
    const reader = new IsoBmffBoxReader(source);

    const empty = await reader.readBytes(0, 0, signal());
    expect(empty).toEqual(new Uint8Array(0));
    expect(source.reads).toHaveLength(0);
    await expect(reader.readBytes(0, ISO_BMFF_MAX_BOUNDED_READ_BYTES, signal())).resolves.toEqual(
      bytes,
    );
    await expect(
      reader.readBytes(0, ISO_BMFF_MAX_BOUNDED_READ_BYTES + 1, signal()),
    ).rejects.toThrow(/from 0 through 65536/);
    await expect(reader.readBytes(bytes.byteLength, 1, signal())).rejects.toThrow(
      /exceeds source size/,
    );
  });

  it('applies exact-result, source-stability, and abort precedence to bounded reads', async () => {
    const short: EncodedRandomAccessSource = {
      size: 4,
      identity: 'short-bounded-source',
      async readAt(): Promise<Uint8Array> {
        return Uint8Array.of(1, 2, 3);
      },
      async close(): Promise<void> {},
    };
    await expect(new IsoBmffBoxReader(short).readBytes(0, 4, signal())).rejects.toThrow(
      /returned 3 bytes; expected 4/,
    );

    const mutable = new SparseSource(4, [{ offset: 0, bytes: Uint8Array.of(1, 2, 3, 4) }]);
    const originalRead = mutable.readAt.bind(mutable);
    mutable.readAt = async (offset, length, abortSignal) => {
      const result = await originalRead(offset, length, abortSignal);
      mutable.size = 5;
      return result;
    };
    await expect(new IsoBmffBoxReader(mutable).readBytes(0, 4, signal())).rejects.toThrow(
      /source changed/,
    );

    const controller = new AbortController();
    const reason = Object.freeze({ operation: 'bounded-read' });
    controller.abort(reason);
    const untouched = sourceFrom(Uint8Array.of(1));
    await expect(new IsoBmffBoxReader(untouched).readBytes(0, 1, controller.signal)).rejects.toBe(
      reason,
    );
    expect(untouched.reads).toHaveLength(0);
  });

  it('preserves the exact abort reason before and during a physical read', async () => {
    const before = new AbortController();
    const beforeReason = Object.freeze({ phase: 'before' });
    before.abort(beforeReason);
    const source = sourceFrom(standardHeader('free', 8));
    await expect(new IsoBmffBoxReader(source).createCursor().next(before.signal)).rejects.toBe(
      beforeReason,
    );
    expect(source.reads).toHaveLength(0);

    const gate = deferred<Uint8Array>();
    const duringSource: EncodedRandomAccessSource = {
      size: 8,
      identity: 'abort-during-source',
      async readAt(): Promise<Uint8Array> {
        return gate.promise;
      },
      async close(): Promise<void> {},
    };
    const during = new AbortController();
    const duringReason = Object.freeze({ phase: 'during' });
    const pending = new IsoBmffBoxReader(duringSource).createCursor().next(during.signal);
    during.abort(duringReason);
    gate.resolve(standardHeader('free', 8));
    await expect(pending).rejects.toBe(duringReason);
  });

  it('rejects concurrent next calls and advances only the successful call', async () => {
    const gate = deferred<Uint8Array>();
    const source: EncodedRandomAccessSource = {
      size: 8,
      identity: 'concurrent-source',
      async readAt(): Promise<Uint8Array> {
        return gate.promise;
      },
      async close(): Promise<void> {},
    };
    const cursor: IsoBmffBoxCursor = new IsoBmffBoxReader(source).createCursor();
    const first = cursor.next(signal());

    await expect(cursor.next(signal())).rejects.toThrow(/Concurrent or reentrant/);
    expect(cursor.offset).toBe(0);
    gate.resolve(standardHeader('free', 8));
    await expect(first).resolves.toMatchObject({ type: 'free', end: 8 });
    expect(cursor.offset).toBe(8);
  });

  it('validates child cursor spans against the parent data range', async () => {
    const bytes = container('moov', standardHeader('free', 8));
    const reader = new IsoBmffBoxReader(sourceFrom(bytes));
    const parent = await reader.createCursor().next(signal());

    expect(() => reader.createChildCursor(parent!, { start: 7 })).toThrow(/from 8 through/);
    expect(() => reader.createChildCursor(parent!, { end: bytes.byteLength + 1 })).toThrow(
      /from 8 through/,
    );
    expect(() => reader.createChildCursor(parent!, { start: 16, end: 8 })).toThrow(
      /inverted boundary/,
    );
  });

  it('binds child cursors to exact box references issued by the same reader', async () => {
    const bytes = container('moov', standardHeader('free', 8));
    const source = sourceFrom(bytes);
    const reader = new IsoBmffBoxReader(source);
    const parent = await reader.createCursor().next(signal());
    expect(parent).not.toBeNull();

    await expect(reader.createChildCursor(parent!).next(signal())).resolves.toMatchObject({
      type: 'free',
    });

    const otherReader = new IsoBmffBoxReader(source);
    expect(() => otherReader.createChildCursor(parent!)).toThrow(/not issued by this reader/);
    expect(() => reader.createChildCursor({ ...parent! })).toThrow(/not issued by this reader/);
    expect(() => reader.createChildCursor(structuredClone(parent!))).toThrow(
      /not issued by this reader/,
    );

    const hostile = new Proxy(Object.create(null) as Readonly<typeof parent>, {
      get(): never {
        throw new Error('untrusted parent fields were inspected');
      },
    });
    expect(() => reader.createChildCursor(hostile as Readonly<NonNullable<typeof parent>>)).toThrow(
      /not issued by this reader/,
    );
  });

  it('accepts a parent reference issued by public readBoxAt', async () => {
    const bytes = container('moov', standardHeader('free', 8));
    const reader = new IsoBmffBoxReader(sourceFrom(bytes));
    const parent = await reader.readBoxAt(
      { parentStart: 0, parentEnd: bytes.byteLength, start: 0 },
      signal(),
    );

    await expect(reader.createChildCursor(parent).next(signal())).resolves.toMatchObject({
      type: 'free',
      start: 8,
      end: 16,
    });
  });
});
