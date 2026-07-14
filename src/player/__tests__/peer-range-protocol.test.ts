import { describe, expect, it } from 'vitest';
import { pack, unpack } from 'peerjs-js-binarypack';

import {
  PEER_RANGE_MAX_CHUNK_BYTES,
  PEER_RANGE_MAX_READ_BYTES,
  PeerRangeAssemblerClosedError,
  PeerRangeLimitError,
  PeerRangeProtocolError,
  PeerRangeRemoteError,
  PeerRangeResponseAssembler,
  PeerRangeRequestCancelledError,
  createPeerRangeCancelFrame,
  createPeerRangeChunkFrames,
  createPeerRangeCloseHandleFrame,
  createPeerRangeErrorFrame,
  createPeerRangeReadFrame,
  parsePeerRangeBulkFrame,
  parsePeerRangeControlFrame,
  type PeerRangeReadDescriptor,
} from '../sources/peer-range-protocol.ts';

function descriptor(overrides: Partial<PeerRangeReadDescriptor> = {}): PeerRangeReadDescriptor {
  return {
    connectionId: 'connection:alpha',
    sourceIdentity: 'sha256:0123456789abcdef',
    handleId: 'peer-range-handle:one',
    requestId: 'peer-range-request:one',
    offset: 123_456,
    totalLength: PEER_RANGE_MAX_READ_BYTES,
    ...overrides,
  };
}

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (index * 29 + 7) & 0xff);
}

function mutate<T extends object>(value: T, changes: Record<string, unknown>): unknown {
  return { ...value, ...changes };
}

function createAssembler(
  options: Omit<ConstructorParameters<typeof PeerRangeResponseAssembler>[0], 'connectionId'> = {},
) {
  return new PeerRangeResponseAssembler({ connectionId: 'connection:alpha', ...options });
}

describe('peer range protocol framing', () => {
  it('fragments an exact 64 KiB read into four independent 16 KiB bulk frames', () => {
    const request = descriptor();
    const input = bytes(request.totalLength);
    const frames = createPeerRangeChunkFrames(request, input);

    expect(frames).toHaveLength(4);
    expect(frames.map((frame) => frame.payload.byteLength)).toEqual([
      PEER_RANGE_MAX_CHUNK_BYTES,
      PEER_RANGE_MAX_CHUNK_BYTES,
      PEER_RANGE_MAX_CHUNK_BYTES,
      PEER_RANGE_MAX_CHUNK_BYTES,
    ]);
    expect(frames.map((frame) => frame.chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(frames.every((frame) => frame.chunkCount === 4)).toBe(true);
    expect(frames.every(Object.isFrozen)).toBe(true);

    input.fill(0);
    expect(new Uint8Array(frames[0]!.payload)[0]).toBe(7);
    expect(frames[0]!.connectionId).toBe(request.connectionId);
    expect(frames[0]!.sourceIdentity).toBe(request.sourceIdentity);
  });

  it('uses exact versioned schemas and rejects noncanonical opaque identifiers', () => {
    const read = createPeerRangeReadFrame(descriptor({ totalLength: 1 }));
    const cancel = createPeerRangeCancelFrame(read);
    const closeHandle = createPeerRangeCloseHandleFrame(read);

    expect(parsePeerRangeControlFrame(read)).toEqual(read);
    expect(parsePeerRangeControlFrame(cancel)).toEqual(cancel);
    expect(parsePeerRangeControlFrame(closeHandle)).toEqual(closeHandle);
    expect(Object.isFrozen(read)).toBe(true);
    expect(() => parsePeerRangeControlFrame({ ...read, surprise: true })).toThrow(
      PeerRangeProtocolError,
    );
    expect(() => parsePeerRangeControlFrame({ ...closeHandle, requestId: 'extra' })).toThrow(
      PeerRangeProtocolError,
    );
    expect(() => parsePeerRangeControlFrame({ ...read, version: 2 })).toThrow(
      PeerRangeProtocolError,
    );
    expect(() =>
      createPeerRangeReadFrame(descriptor({ connectionId: ' connection:alpha' })),
    ).toThrow(PeerRangeProtocolError);
    expect(() =>
      createPeerRangeReadFrame(descriptor({ sourceIdentity: 'source\u0000identity' })),
    ).toThrow(PeerRangeProtocolError);
    expect(() => createPeerRangeReadFrame(descriptor({ sourceIdentity: 'x'.repeat(513) }))).toThrow(
      PeerRangeProtocolError,
    );
    const opaque = createPeerRangeReadFrame(
      descriptor({ sourceIdentity: '소스 ID:α', requestId: '요청 번호:1' }),
    );
    expect(opaque.sourceIdentity).toBe('소스 ID:α');
    expect(opaque.requestId).toBe('요청 번호:1');
    expect(() =>
      createPeerRangeReadFrame(descriptor({ totalLength: PEER_RANGE_MAX_READ_BYTES + 1 })),
    ).toThrow(PeerRangeProtocolError);
  });

  it('parses defensive payload copies and validates exact response lengths', () => {
    const request = descriptor({ totalLength: 3 });
    const frame = createPeerRangeChunkFrames(request, Uint8Array.of(1, 2, 3))[0]!;
    const parsed = parsePeerRangeBulkFrame(frame);
    expect(parsed.type).toBe('chunk');
    if (parsed.type !== 'chunk') throw new Error('expected a chunk');

    new Uint8Array(frame.payload).fill(9);
    expect([...new Uint8Array(parsed.payload)]).toEqual([1, 2, 3]);
    expect(() => createPeerRangeChunkFrames(request, Uint8Array.of(1, 2))).toThrow(
      PeerRangeProtocolError,
    );
    const wirePayload = new Uint8Array([1, 2, 3]);
    const parsedWirePayload = parsePeerRangeBulkFrame(mutate(parsed, { payload: wirePayload }));
    expect(parsedWirePayload.type).toBe('chunk');
    if (parsedWirePayload.type !== 'chunk') throw new Error('expected a chunk');
    expect(parsedWirePayload.payload).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(parsedWirePayload.payload)]).toEqual([1, 2, 3]);
    wirePayload.fill(8);
    expect([...new Uint8Array(parsedWirePayload.payload)]).toEqual([1, 2, 3]);
    expect(() => parsePeerRangeBulkFrame(mutate(parsed, { chunkCount: 2 }))).toThrow(
      PeerRangeProtocolError,
    );
    expect(() => parsePeerRangeBulkFrame(mutate(parsed, { payload: new ArrayBuffer(2) }))).toThrow(
      PeerRangeProtocolError,
    );
    expect(() =>
      parsePeerRangeBulkFrame(
        mutate(createPeerRangeErrorFrame(request, 'unavailable', 'Try again'), {
          chunkCount: 2,
        }),
      ),
    ).toThrow(PeerRangeProtocolError);
    expect(() =>
      parsePeerRangeBulkFrame(
        mutate(createPeerRangeErrorFrame(request, 'unavailable', 'Try again'), {
          chunkIndex: 1,
        }),
      ),
    ).toThrow(PeerRangeProtocolError);
  });

  it('canonicalizes the exact Uint8Array produced by PeerJS internal BinaryPack reassembly', () => {
    const frame = createPeerRangeChunkFrames(descriptor(), bytes(PEER_RANGE_MAX_READ_BYTES))[0]!;
    const packed = pack(frame as never);
    if (packed instanceof Promise) {
      throw new Error('Peer range frame unexpectedly required asynchronous BinaryPack');
    }
    const peerJsChunkedMtu = 16_300;
    expect(packed.byteLength).toBeGreaterThan(peerJsChunkedMtu);
    const pieces: Uint8Array[] = [];
    for (let offset = 0; offset < packed.byteLength; offset += peerJsChunkedMtu) {
      pieces.push(new Uint8Array(packed.slice(offset, offset + peerJsChunkedMtu)));
    }
    expect(pieces.length).toBeGreaterThan(1);
    const peerJsReassembled = new Uint8Array(packed.byteLength);
    let outputOffset = 0;
    for (const piece of pieces) {
      peerJsReassembled.set(piece, outputOffset);
      outputOffset += piece.byteLength;
    }
    const delivered = unpack(peerJsReassembled as unknown as ArrayBuffer) as unknown as Record<
      string,
      unknown
    >;
    expect(delivered.payload).toBeInstanceOf(Uint8Array);

    const parsed = parsePeerRangeBulkFrame(delivered);
    expect(parsed.type).toBe('chunk');
    if (parsed.type !== 'chunk') throw new Error('expected a chunk');
    expect(parsed.payload).toBeInstanceOf(ArrayBuffer);
    expect(parsed.payload).not.toBe((delivered.payload as Uint8Array).buffer);
    expect(new Uint8Array(parsed.payload)).toEqual(new Uint8Array(frame.payload));
    (delivered.payload as Uint8Array).fill(0);
    expect(new Uint8Array(parsed.payload)).toEqual(new Uint8Array(frame.payload));
  });

  it('rejects every non-exact Uint8Array peer-range payload representation', () => {
    const request = descriptor({ totalLength: 4 });
    const frame = createPeerRangeChunkFrames(request, Uint8Array.of(1, 2, 3, 4))[0]!;
    class DerivedUint8Array extends Uint8Array {}
    class DerivedArrayBuffer extends ArrayBuffer {}
    const largerBacking = new Uint8Array([0, 1, 2, 3, 4, 0]);
    let proxyGetPrototypeCalls = 0;
    const invalidPayloads: unknown[] = [
      new DataView(Uint8Array.of(1, 2, 3, 4).buffer),
      new Uint16Array(Uint8Array.of(1, 2, 3, 4).buffer),
      new DerivedUint8Array([1, 2, 3, 4]),
      new Uint8Array(new DerivedArrayBuffer(4)),
      new Uint8Array(largerBacking.buffer, 1, 4),
      new Proxy(Uint8Array.of(1, 2, 3, 4), {
        getPrototypeOf(target) {
          proxyGetPrototypeCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
      }),
    ];
    if (typeof SharedArrayBuffer === 'function') {
      const shared = new SharedArrayBuffer(4);
      new Uint8Array(shared).set([1, 2, 3, 4]);
      invalidPayloads.push(new Uint8Array(shared));
    }

    for (const payload of invalidPayloads) {
      expect(() => parsePeerRangeBulkFrame(mutate(frame, { payload }))).toThrow(
        PeerRangeProtocolError,
      );
    }
    expect(proxyGetPrototypeCalls).toBe(0);
  });

  it('accepts only exact own enumerable data properties without invoking accessors', () => {
    const read = { ...createPeerRangeReadFrame(descriptor({ totalLength: 1 })) };
    let accessorCalls = 0;
    const accessorFrame = { ...read };
    Object.defineProperty(accessorFrame, 'requestId', {
      enumerable: true,
      configurable: true,
      get() {
        accessorCalls += 1;
        return read.requestId;
      },
    });
    expect(() => parsePeerRangeControlFrame(accessorFrame)).toThrow(PeerRangeProtocolError);
    expect(accessorCalls).toBe(0);

    const hiddenExtra = { ...read };
    Object.defineProperty(hiddenExtra, 'hidden', { value: true, enumerable: false });
    expect(() => parsePeerRangeControlFrame(hiddenExtra)).toThrow(PeerRangeProtocolError);

    const symbolicExtra = { ...read, [Symbol('extra')]: true };
    expect(() => parsePeerRangeControlFrame(symbolicExtra)).toThrow(PeerRangeProtocolError);

    const nonEnumerableField = { ...read };
    Object.defineProperty(nonEnumerableField, 'requestId', {
      value: read.requestId,
      enumerable: false,
    });
    expect(() => parsePeerRangeControlFrame(nonEnumerableField)).toThrow(PeerRangeProtocolError);
  });

  it('takes one detached Proxy snapshot and never uses frame property reads', () => {
    const frame = createPeerRangeChunkFrames(
      descriptor({ totalLength: 3 }),
      Uint8Array.of(1, 2, 3),
    )[0]!;
    const target = { ...frame };
    let ownKeysCalls = 0;
    let getCalls = 0;
    const descriptorCalls = new Map<PropertyKey, number>();
    const proxy = new Proxy(target, {
      ownKeys(value) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(value);
      },
      get() {
        getCalls += 1;
        throw new Error('frame property getter must not run');
      },
      getOwnPropertyDescriptor(value, key) {
        descriptorCalls.set(key, (descriptorCalls.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });

    const parsed = parsePeerRangeBulkFrame(proxy);
    expect(parsed).toMatchObject({ type: 'chunk', requestId: frame.requestId });
    expect(ownKeysCalls).toBe(1);
    expect(getCalls).toBe(0);
    expect([...descriptorCalls.values()].every((count) => count === 1)).toBe(true);
  });

  it('uses the captured payload reference once and ignores shadow byteLength accessors', () => {
    const request = descriptor({ totalLength: 3 });
    const frame = createPeerRangeChunkFrames(request, Uint8Array.of(4, 5, 6))[0]!;
    let byteLengthAccessorCalls = 0;
    let constructorAccessorCalls = 0;
    Object.defineProperty(frame.payload, 'byteLength', {
      configurable: true,
      get() {
        byteLengthAccessorCalls += 1;
        return 99;
      },
    });
    Object.defineProperty(frame.payload, 'constructor', {
      configurable: true,
      get() {
        constructorAccessorCalls += 1;
        throw new Error('payload species must not be read');
      },
    });

    const parsed = parsePeerRangeBulkFrame({ ...frame });
    expect(parsed.type).toBe('chunk');
    if (parsed.type !== 'chunk') throw new Error('expected a chunk');
    expect(new Uint8Array(parsed.payload)).toEqual(Uint8Array.of(4, 5, 6));
    expect(byteLengthAccessorCalls).toBe(0);
    expect(constructorAccessorCalls).toBe(0);
  });

  it('reads an exact Uint8Array wire payload only through captured typed-array intrinsics', () => {
    const request = descriptor({ totalLength: 3 });
    const frame = createPeerRangeChunkFrames(request, Uint8Array.of(4, 5, 6))[0]!;
    const payload = Uint8Array.of(4, 5, 6);
    let accessorCalls = 0;
    for (const key of ['buffer', 'byteLength', 'byteOffset', 'constructor'] as const) {
      Object.defineProperty(payload, key, {
        configurable: true,
        get() {
          accessorCalls += 1;
          throw new Error(`${key} shadow accessor must not be read`);
        },
      });
    }

    const parsed = parsePeerRangeBulkFrame({ ...frame, payload });
    expect(parsed.type).toBe('chunk');
    if (parsed.type !== 'chunk') throw new Error('expected a chunk');
    expect(new Uint8Array(parsed.payload)).toEqual(Uint8Array.of(4, 5, 6));
    expect(accessorCalls).toBe(0);
  });

  it('rejects a mismatched Uint8Array length without reading constructor or species', () => {
    const request = descriptor({ totalLength: 3 });
    const frame = createPeerRangeChunkFrames(request, Uint8Array.of(4, 5, 6))[0]!;
    const payload = Uint8Array.of(4, 5);
    let constructorAccessorCalls = 0;
    Object.defineProperty(payload, 'constructor', {
      configurable: true,
      get() {
        constructorAccessorCalls += 1;
        throw new Error('mismatched payload species must not be read');
      },
    });

    expect(() => parsePeerRangeBulkFrame({ ...frame, payload })).toThrow(/payload length/u);
    expect(constructorAccessorCalls).toBe(0);
  });

  it('rejects an oversized payload by its internal length before attempting any copy', () => {
    const frame = createPeerRangeChunkFrames(descriptor({ totalLength: 1 }), Uint8Array.of(1))[0]!;
    const oversized = new ArrayBuffer(1024 * 1024);
    let constructorAccessorCalls = 0;
    Object.defineProperty(oversized, 'constructor', {
      configurable: true,
      get() {
        constructorAccessorCalls += 1;
        throw new Error('oversized payload must not be copied');
      },
    });

    expect(() => parsePeerRangeBulkFrame({ ...frame, payload: oversized })).toThrow(
      /payload length/,
    );
    expect(constructorAccessorCalls).toBe(0);
  });

  it('normalizes revoked Proxy reflection failures into protocol errors', () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => parsePeerRangeControlFrame(revocable.proxy)).toThrow(PeerRangeProtocolError);
  });
});

describe('PeerRangeResponseAssembler', () => {
  it('accepts out-of-order chunks but resolves only after exact reassembly', async () => {
    const requestData = descriptor();
    const expected = bytes(requestData.totalLength);
    const request = createPeerRangeReadFrame(requestData);
    const frames = createPeerRangeChunkFrames(request, expected);
    const assembler = createAssembler();
    const resultPromise = assembler.open(request);

    expect(assembler.accept(frames[3])).toBe('accepted');
    expect(assembler.accept(frames[1])).toBe('accepted');
    expect(assembler.accept(frames[0])).toBe('accepted');
    expect(assembler.activeRequestCount).toBe(1);
    expect(assembler.accept(frames[2])).toBe('completed');

    const result = await resultPromise;
    expect(result).toEqual(expected);
    expect(assembler.activeRequestCount).toBe(0);
    expect(assembler.retainedByteLength).toBe(0);
    new Uint8Array(frames[0]!.payload).fill(0);
    expect(result[0]).toBe(7);
  });

  it('fails the whole request on a chunk-count mismatch', async () => {
    const requestData = descriptor();
    const request = createPeerRangeReadFrame(requestData);
    const frame = createPeerRangeChunkFrames(request, bytes(requestData.totalLength))[0]!;
    const assembler = createAssembler();
    const pending = assembler.open(request);

    expect(assembler.accept(mutate(frame, { chunkCount: 3 }))).toBe('failed');
    await expect(pending).rejects.toBeInstanceOf(PeerRangeProtocolError);
    expect(assembler.retainedByteLength).toBe(0);
  });

  it('requires the full immutable descriptor before canceling or mutating an assembly', async () => {
    const exact = createPeerRangeReadFrame(descriptor({ totalLength: 3 }));
    const wrongSource = createPeerRangeReadFrame({
      ...exact,
      sourceIdentity: 'sha256:different',
    });
    const wrongRange = createPeerRangeReadFrame({
      ...exact,
      offset: exact.offset + 1,
      totalLength: 2,
    });
    const assembler = createAssembler();
    const pending = assembler.open(exact);

    expect(assembler.cancel(wrongSource)).toBe(false);
    expect(
      assembler.accept(createPeerRangeChunkFrames(wrongSource, Uint8Array.of(8, 8, 8))[0]),
    ).toBe('ignored');
    expect(assembler.cancel(wrongRange)).toBe(false);
    expect(assembler.accept(createPeerRangeChunkFrames(wrongRange, Uint8Array.of(9, 9))[0])).toBe(
      'ignored',
    );
    expect(assembler.activeRequestCount).toBe(1);

    expect(assembler.accept(createPeerRangeChunkFrames(exact, Uint8Array.of(1, 2, 3))[0])).toBe(
      'completed',
    );
    await expect(pending).resolves.toEqual(Uint8Array.of(1, 2, 3));
  });

  it('binds assembly to the authenticated connection instead of a claimed frame identity', async () => {
    const exact = createPeerRangeReadFrame(descriptor({ totalLength: 2 }));
    const spoof = createPeerRangeReadFrame({ ...exact, connectionId: 'connection:spoof' });
    const assembler = createAssembler();
    const pending = assembler.open(exact);

    expect(() => assembler.open(spoof)).toThrow(PeerRangeProtocolError);
    expect(() => assembler.cancel(spoof)).toThrow(PeerRangeProtocolError);
    expect(() =>
      assembler.accept(createPeerRangeChunkFrames(spoof, Uint8Array.of(8, 8))[0]),
    ).toThrow(PeerRangeProtocolError);
    expect(assembler.activeRequestCount).toBe(1);

    expect(assembler.accept(createPeerRangeChunkFrames(exact, Uint8Array.of(1, 2))[0])).toBe(
      'completed',
    );
    await expect(pending).resolves.toEqual(Uint8Array.of(1, 2));
  });

  it('fails a request on duplicate chunks and never returns partial bytes', async () => {
    const requestData = descriptor({ totalLength: PEER_RANGE_MAX_CHUNK_BYTES + 1 });
    const request = createPeerRangeReadFrame(requestData);
    const frames = createPeerRangeChunkFrames(request, bytes(requestData.totalLength));
    const assembler = createAssembler();
    const pending = assembler.open(request);

    expect(assembler.accept(frames[0])).toBe('accepted');
    expect(assembler.accept(frames[0])).toBe('failed');
    expect(assembler.accept(frames[1])).toBe('ignored');
    await expect(pending).rejects.toBeInstanceOf(PeerRangeProtocolError);
    expect(assembler.retainedByteLength).toBe(0);
  });

  it('rejects tampered exact schemas and fails a correlated active request', async () => {
    const requestData = descriptor({ totalLength: 4 });
    const request = createPeerRangeReadFrame(requestData);
    const frame = createPeerRangeChunkFrames(request, Uint8Array.of(1, 2, 3, 4))[0]!;
    const assembler = createAssembler();
    const pending = assembler.open(request);

    expect(assembler.accept({ ...frame, extra: true })).toBe('failed');
    await expect(pending).rejects.toBeInstanceOf(PeerRangeProtocolError);
    expect(() => assembler.accept({ nope: true })).toThrow(PeerRangeProtocolError);
  });

  it('derives correlated failure only from the same detached hostile snapshot', async () => {
    const request = createPeerRangeReadFrame(descriptor({ totalLength: 4 }));
    const valid = createPeerRangeChunkFrames(request, Uint8Array.of(1, 2, 3, 4))[0]!;
    const target = { ...valid, payload: new ArrayBuffer(1) };
    let ownKeysCalls = 0;
    let getCalls = 0;
    const hostile = new Proxy(target, {
      ownKeys(value) {
        ownKeysCalls += 1;
        if (ownKeysCalls > 1) throw new Error('frame was reflected twice');
        return Reflect.ownKeys(value);
      },
      get() {
        getCalls += 1;
        throw new Error('frame property getter must not run');
      },
    });
    const assembler = createAssembler();
    const pending = assembler.open(request);

    expect(assembler.accept(hostile)).toBe('failed');
    await expect(pending).rejects.toBeInstanceOf(PeerRangeProtocolError);
    expect(ownKeysCalls).toBe(1);
    expect(getCalls).toBe(0);
  });

  it('caps concurrency and retained bytes independently', async () => {
    const first = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:first', totalLength: PEER_RANGE_MAX_CHUNK_BYTES + 1 }),
    );
    const second = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:second', totalLength: 1 }),
    );
    const concurrencyAssembler = createAssembler({ maxActiveRequests: 1 });
    const firstPending = concurrencyAssembler.open(first);
    expect(() => concurrencyAssembler.open(second)).toThrow(PeerRangeLimitError);
    concurrencyAssembler.cancel(first);
    await expect(firstPending).rejects.toBeInstanceOf(PeerRangeRequestCancelledError);

    const byteAssembler = createAssembler({
      maxRetainedBytes: PEER_RANGE_MAX_CHUNK_BYTES,
    });
    const bytePending = byteAssembler.open(first);
    const frames = createPeerRangeChunkFrames(first, bytes(first.totalLength));
    expect(byteAssembler.accept(frames[0])).toBe('accepted');
    expect(byteAssembler.accept(frames[1])).toBe('failed');
    await expect(bytePending).rejects.toBeInstanceOf(PeerRangeLimitError);
    expect(byteAssembler.retainedByteLength).toBe(0);
  });

  it('makes abort, explicit cancel, and close terminal so late bulk frames are inert', async () => {
    const abortController = new AbortController();
    const abortRequest = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:abort', totalLength: 1 }),
    );
    const cancelRequest = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:cancel', totalLength: 1 }),
    );
    const closeRequest = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:close', totalLength: 1 }),
    );
    const assembler = createAssembler();

    const aborted = assembler.open(abortRequest, abortController.signal);
    abortController.abort(new DOMException('gone', 'AbortError'));
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(assembler.accept(createPeerRangeChunkFrames(abortRequest, Uint8Array.of(1))[0])).toBe(
      'ignored',
    );

    const cancelled = assembler.open(cancelRequest);
    expect(assembler.cancel(cancelRequest)).toBe(true);
    await expect(cancelled).rejects.toBeInstanceOf(PeerRangeRequestCancelledError);
    expect(assembler.accept(createPeerRangeChunkFrames(cancelRequest, Uint8Array.of(2))[0])).toBe(
      'ignored',
    );

    const closed = assembler.open(closeRequest);
    assembler.close();
    await expect(closed).rejects.toBeInstanceOf(PeerRangeAssemblerClosedError);
    expect(assembler.accept(createPeerRangeChunkFrames(closeRequest, Uint8Array.of(3))[0])).toBe(
      'ignored',
    );
    expect(() => assembler.open(closeRequest)).toThrow(PeerRangeAssemblerClosedError);
  });

  it('tombstones completed and cancelled descriptors so they cannot be reopened', async () => {
    const completedRequest = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:completed', totalLength: 1 }),
    );
    const cancelledRequest = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:cancelled', totalLength: 1 }),
    );
    const assembler = createAssembler();

    const completed = assembler.open(completedRequest);
    const completedFrame = createPeerRangeChunkFrames(completedRequest, Uint8Array.of(1))[0]!;
    expect(assembler.accept(completedFrame)).toBe('completed');
    await expect(completed).resolves.toEqual(Uint8Array.of(1));
    expect(() => assembler.open(completedRequest)).toThrow(/already settled/);
    expect(assembler.accept(completedFrame)).toBe('ignored');

    const cancelled = assembler.open(cancelledRequest);
    expect(assembler.cancel(cancelledRequest)).toBe(true);
    await expect(cancelled).rejects.toBeInstanceOf(PeerRangeRequestCancelledError);
    expect(() => assembler.open(cancelledRequest)).toThrow(/already settled/);
    expect(assembler.settledRequestCount).toBe(2);
  });

  it('keeps the settled descriptor tombstone cache bounded', async () => {
    const assembler = createAssembler({ maxSettledRequests: 2 });
    for (let index = 0; index < 3; index += 1) {
      const request = createPeerRangeReadFrame(
        descriptor({ requestId: `request:bounded-${index}`, totalLength: 1 }),
      );
      const pending = assembler.open(request);
      expect(assembler.accept(createPeerRangeChunkFrames(request, Uint8Array.of(index))[0])).toBe(
        'completed',
      );
      await pending;
    }
    expect(assembler.settledRequestCount).toBe(2);
  });

  it('keeps two handles for the same source and request ID isolated', async () => {
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:first', requestId: 'request:shared', totalLength: 3 }),
    );
    const second = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:second', requestId: 'request:shared', totalLength: 3 }),
    );
    const assembler = createAssembler();
    const firstPending = assembler.open(first);
    const secondPending = assembler.open(second);

    expect(assembler.accept(createPeerRangeChunkFrames(second, Uint8Array.of(4, 5, 6))[0])).toBe(
      'completed',
    );
    expect(assembler.accept(createPeerRangeChunkFrames(first, Uint8Array.of(1, 2, 3))[0])).toBe(
      'completed',
    );
    await expect(firstPending).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(secondPending).resolves.toEqual(Uint8Array.of(4, 5, 6));
  });

  it('converts an exact remote error into a terminal correlated rejection', async () => {
    const request = createPeerRangeReadFrame(descriptor({ totalLength: 5 }));
    const assembler = createAssembler();
    const pending = assembler.open(request);

    expect(assembler.accept(createPeerRangeErrorFrame(request, 'unavailable', 'Try again'))).toBe(
      'failed',
    );
    await expect(pending).rejects.toMatchObject<Partial<PeerRangeRemoteError>>({
      name: 'PeerRangeRemoteError',
      code: 'unavailable',
      message: 'Try again',
    });
  });

  it('rejects invalid index, count, payload size, and correlated type tampering', async () => {
    const request = createPeerRangeReadFrame(
      descriptor({ totalLength: PEER_RANGE_MAX_CHUNK_BYTES + 1 }),
    );
    const valid = createPeerRangeChunkFrames(request, bytes(request.totalLength));

    for (const changed of [
      mutate(valid[0]!, { chunkIndex: 2 }),
      mutate(valid[0]!, { chunkCount: 1 }),
      mutate(valid[0]!, { payload: new ArrayBuffer(1) }),
      mutate(valid[0]!, { type: 'surprise' }),
    ]) {
      const assembler = createAssembler();
      const pending = assembler.open(request);
      expect(assembler.accept(changed)).toBe('failed');
      await expect(pending).rejects.toBeInstanceOf(PeerRangeProtocolError);
    }
  });
});
