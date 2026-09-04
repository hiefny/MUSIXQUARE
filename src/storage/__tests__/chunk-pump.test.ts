/**
 * @vitest-environment jsdom
 *
 * Engine contracts shared by active-file and preload broadcasts. Fake clocks
 * and explicitly controlled reads pin progress and cancellation without relying
 * on machine speed. Wrapper-visible behavior lives in transfer/preload tests.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { pumpChunksToPeers } from '../chunk-pump.ts';
import { DELAY, MSG } from '../../core/constants.ts';
import type { ConnectedPeer, DataConnection, AnyProtocolMsg } from '../../types/index.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const BYTES = [1, 2, 3, 4, 5];

interface MockConn {
  open: boolean;
  peer: string;
  send: ReturnType<typeof vi.fn>;
  dataChannel: { readyState: string; bufferedAmount: number };
}

function makeConn(peer: string, bufferedAmount = 0): MockConn {
  return {
    open: true,
    peer,
    send: vi.fn(),
    dataChannel: { readyState: 'open', bufferedAmount },
  };
}

function makePeer(id: string, conn: MockConn): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: conn as unknown as DataConnection,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

function buildMsg(chunk: Uint8Array, chunkIndex: number): AnyProtocolMsg {
  return { type: MSG.PRELOAD_CHUNK, chunk, chunkIndex, queueItemId: QUEUE_ITEM_ID, sessionId: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Blob reads resolve on the microtask queue, independently of filesystem or
// jsdom FileReader scheduling. Deferred overrides below model in-flight reads.
function makeFile(bytes = BYTES) {
  const slice = vi.fn((start = 0, end = bytes.length) => ({
    arrayBuffer: async () => Uint8Array.from(bytes.slice(start, end)).buffer,
  }));
  return { file: { size: bytes.length, slice } as unknown as Blob, slice };
}

const baseOpts = {
  chunkSize: 2,
  buildChunkMsg: buildMsg,
  bufferedLimit: 1024,
  stallTimeoutMs: 150,
  isWritable: () => true,
  shouldContinue: () => true,
};

const chunkCalls = (conn: MockConn) =>
  conn.send.mock.calls
    .map(([msg]) => msg as { type: string; chunkIndex: number; chunk: Uint8Array })
    .filter((msg) => msg.type === MSG.PRELOAD_CHUNK);

function expectCompleteBytes(conn: MockConn) {
  expect(chunkCalls(conn).map(({ chunkIndex, chunk }) => [chunkIndex, Array.from(chunk)])).toEqual([
    [0, [1, 2]],
    [1, [3, 4]],
    [2, [5]],
  ]);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('pumpChunksToPeers — independent peer progress', () => {
  it('finishes healthy peers while a blocked peer is still waiting, without reading ahead for it', async () => {
    const { file, slice } = makeFile();
    const healthy = makeConn('healthy');
    const frozen = makeConn('frozen', 10 * 1024 * 1024);
    const onPeerComplete = vi.fn();
    const onPeerExcluded = vi.fn();
    let settled = false;
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('healthy', healthy), makePeer('frozen', frozen)],
      onPeerComplete,
      onPeerExcluded,
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(DELAY.TICK);

    expectCompleteBytes(healthy);
    expect(chunkCalls(frozen)).toHaveLength(0);
    expect(slice).toHaveBeenCalledTimes(3);
    expect(onPeerComplete.mock.calls.map(([peer]) => peer.id)).toEqual(['healthy']);
    expect(onPeerExcluded).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'complete', excluded: new Set(['frozen']) });
    expect(onPeerExcluded.mock.calls.map(([peer]) => peer.id)).toEqual(['frozen']);
    expect(onPeerComplete).toHaveBeenCalledTimes(1);
    expect(chunkCalls(frozen)).toHaveLength(0);
  });

  it('preserves exact chunk order and bytes when a slower peer resumes after the healthy peer finishes', async () => {
    const { file } = makeFile();
    const healthy = makeConn('healthy');
    const slow = makeConn('slow');
    slow.send.mockImplementationOnce(() => {
      slow.dataChannel.bufferedAmount = 2048;
    });
    const onPeerComplete = vi.fn();
    const onChunkComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('healthy', healthy), makePeer('slow', slow)],
      onPeerComplete,
      onChunkComplete,
    });

    await vi.advanceTimersByTimeAsync(DELAY.TICK);
    expectCompleteBytes(healthy);
    expect(chunkCalls(slow)).toHaveLength(1);
    expect(onPeerComplete.mock.calls.map(([peer]) => peer.id)).toEqual(['healthy']);
    expect(onChunkComplete.mock.calls).toEqual([[0, 2]]);

    slow.dataChannel.bufferedAmount = 0;
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'complete', excluded: new Set() });
    expectCompleteBytes(slow);
    expect(onPeerComplete.mock.calls.map(([peer]) => peer.id)).toEqual(['healthy', 'slow']);
    expect(onChunkComplete.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 1],
    ]);
  });

  it('keeps at most one Blob read in flight for each peer and reports single-peer progress bytes', async () => {
    const { file, slice } = makeFile();
    const read = deferred<ArrayBuffer>();
    slice.mockImplementationOnce(() => ({ arrayBuffer: () => read.promise }));
    const conn = makeConn('peer');
    const onChunkComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('peer', conn)],
      onChunkComplete,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(slice).toHaveBeenCalledTimes(1);
    expect(chunkCalls(conn)).toHaveLength(0);

    read.resolve(Uint8Array.from([1, 2]).buffer);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe('complete');
    expectCompleteBytes(conn);
    expect(onChunkComplete.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 1],
    ]);
  });
});

describe('pumpChunksToPeers — per-peer exclusion', () => {
  it('excludes a peer that turns unwritable after a send exactly once, while siblings finish', async () => {
    const { file } = makeFile();
    const healthy = makeConn('healthy');
    const flaky = makeConn('flaky');
    let writable = true;
    flaky.send.mockImplementation(() => {
      writable = false;
    });
    const onPeerExcluded = vi.fn();
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('healthy', healthy), makePeer('flaky', flaky)],
      isWritable: (peer) => peer.id !== 'flaky' || writable,
      onPeerExcluded,
      onPeerComplete,
    });

    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'complete', excluded: new Set(['flaky']) });
    expect(chunkCalls(flaky)).toHaveLength(1);
    expectCompleteBytes(healthy);
    expect(onPeerExcluded.mock.calls.map(([peer]) => peer.id)).toEqual(['flaky']);
    expect(onPeerComplete.mock.calls.map(([peer]) => peer.id)).toEqual(['healthy']);
  });

  it('rechecks ownership when the final backpressure wait drains', async () => {
    const { file, slice } = makeFile();
    const conn = makeConn('replaced', 2048);
    let writable = true;
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('replaced', conn)],
      isWritable: () => writable,
      onPeerComplete,
    });

    await vi.advanceTimersByTimeAsync(0);
    writable = false;
    conn.dataChannel.bufferedAmount = 0;
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'complete', excluded: new Set(['replaced']) });
    expect(slice).not.toHaveBeenCalled();
    expect(chunkCalls(conn)).toHaveLength(0);
    expect(onPeerComplete).not.toHaveBeenCalled();
  });

  it('rechecks ownership after an asynchronous Blob read before sending', async () => {
    const { file, slice } = makeFile();
    const read = deferred<ArrayBuffer>();
    slice.mockImplementationOnce(() => ({ arrayBuffer: () => read.promise }));
    const conn = makeConn('replaced');
    let writable = true;
    const onPeerComplete = vi.fn();
    const onPeerExcluded = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('replaced', conn)],
      isWritable: () => writable,
      onPeerComplete,
      onPeerExcluded,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(slice).toHaveBeenCalledTimes(1);
    writable = false;
    read.resolve(Uint8Array.from([1, 2]).buffer);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ status: 'complete', excluded: new Set(['replaced']) });
    expect(chunkCalls(conn)).toHaveLength(0);
    expect(onPeerExcluded).toHaveBeenCalledTimes(1);
    expect(onPeerComplete).not.toHaveBeenCalled();
  });

  it('returns complete when every peer is excluded, without a completion callback or file read', async () => {
    const { file, slice } = makeFile();
    const onPeerComplete = vi.fn();
    const onPeerExcluded = vi.fn();
    const peer = makePeer('closed', makeConn('closed'));
    const result = await pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [peer],
      isWritable: () => false,
      onPeerComplete,
      onPeerExcluded,
    });

    expect(result).toEqual({ status: 'complete', excluded: new Set(['closed']) });
    expect(slice).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
    expect(onPeerExcluded).toHaveBeenCalledExactlyOnceWith(peer);
  });
});

describe('pumpChunksToPeers — cancellation', () => {
  it('stops before reading or sending when already cancelled', async () => {
    const { file, slice } = makeFile();
    const conn = makeConn('peer');
    const onPeerComplete = vi.fn();
    const result = await pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('peer', conn)],
      shouldContinue: () => false,
      onPeerComplete,
    });

    expect(result).toEqual({ status: 'stopped', excluded: new Set() });
    expect(slice).not.toHaveBeenCalled();
    expect(conn.send).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
  });

  it('stops during backpressure without waiting for the stall timeout or excluding peers', async () => {
    const { file, slice } = makeFile();
    const conn = makeConn('blocked', 2048);
    let active = true;
    const onPeerExcluded = vi.fn();
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('blocked', conn)],
      shouldContinue: () => active,
      onPeerExcluded,
      onPeerComplete,
    });

    await vi.advanceTimersByTimeAsync(0);
    active = false;
    await vi.advanceTimersByTimeAsync(DELAY.BACKPRESSURE);
    expect(await pending).toEqual({ status: 'stopped', excluded: new Set() });
    expect(slice).not.toHaveBeenCalled();
    expect(conn.send).not.toHaveBeenCalled();
    expect(onPeerExcluded).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('latches cancellation so an in-flight sibling cannot resume after the predicate becomes true again', async () => {
    const { file, slice } = makeFile();
    const read = deferred<ArrayBuffer>();
    slice.mockImplementationOnce(() => ({ arrayBuffer: () => read.promise }));
    const reading = makeConn('reading');
    const blocked = makeConn('blocked', 2048);
    let active = true;
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('reading', reading), makePeer('blocked', blocked)],
      shouldContinue: () => active,
      onPeerComplete,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(slice).toHaveBeenCalledTimes(1);
    active = false;
    await vi.advanceTimersByTimeAsync(DELAY.BACKPRESSURE);
    active = true;
    blocked.dataChannel.bufferedAmount = 0;
    read.resolve(Uint8Array.from([1, 2]).buffer);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ status: 'stopped', excluded: new Set() });
    expect(reading.send).not.toHaveBeenCalled();
    expect(blocked.send).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after a Blob read before sending or completing', async () => {
    const { file, slice } = makeFile([1, 2]);
    const read = deferred<ArrayBuffer>();
    slice.mockImplementationOnce(() => ({ arrayBuffer: () => read.promise }));
    const conn = makeConn('peer');
    let active = true;
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('peer', conn)],
      shouldContinue: () => active,
      onPeerComplete,
    });

    await vi.advanceTimersByTimeAsync(0);
    active = false;
    read.resolve(Uint8Array.from([1, 2]).buffer);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'stopped', excluded: new Set() });
    expect(conn.send).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
  });

  it('rechecks cancellation before completion even after the last chunk has been sent', async () => {
    const { file } = makeFile([1, 2]);
    const conn = makeConn('peer');
    let active = true;
    conn.send.mockImplementation(() => {
      active = false;
    });
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('peer', conn)],
      shouldContinue: () => active,
      onPeerComplete,
    });

    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'stopped', excluded: new Set() });
    expect(chunkCalls(conn)).toHaveLength(1);
    expect(onPeerComplete).not.toHaveBeenCalled();
  });
});

describe('pumpChunksToPeers — failure and completion', () => {
  it('stops sibling sends on a read failure and joins their outstanding work before rejecting', async () => {
    const { file, slice } = makeFile();
    const failedRead = deferred<ArrayBuffer>();
    const siblingRead = deferred<ArrayBuffer>();
    slice
      .mockImplementationOnce(() => ({ arrayBuffer: () => failedRead.promise }))
      .mockImplementationOnce(() => ({ arrayBuffer: () => siblingRead.promise }));
    const failed = makeConn('failed');
    const reading = makeConn('reading');
    const blocked = makeConn('blocked', 2048);
    const onPeerComplete = vi.fn();
    const error = new Error('backing storage unavailable');
    let settled = false;
    const outcome = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [
        makePeer('failed', failed),
        makePeer('reading', reading),
        makePeer('blocked', blocked),
      ],
      onPeerComplete,
    }).then(
      (result) => {
        settled = true;
        return { result };
      },
      (reason: unknown) => {
        settled = true;
        return { error: reason };
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(slice).toHaveBeenCalledTimes(2);
    failedRead.reject(error);
    await vi.advanceTimersByTimeAsync(DELAY.BACKPRESSURE);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    siblingRead.resolve(Uint8Array.from([1, 2]).buffer);
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ error });
    expect(failed.send).not.toHaveBeenCalled();
    expect(reading.send).not.toHaveBeenCalled();
    expect(blocked.send).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('absorbs conn.send errors without excluding the peer or affecting siblings', async () => {
    const { file } = makeFile();
    const healthy = makeConn('healthy');
    const throwing = makeConn('throwing');
    throwing.send.mockImplementation(() => {
      throw new Error('send failed');
    });
    const onPeerComplete = vi.fn();
    const pending = pumpChunksToPeers({
      ...baseOpts,
      file,
      peers: [makePeer('throwing', throwing), makePeer('healthy', healthy)],
      onPeerComplete,
    });

    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'complete', excluded: new Set() });
    expectCompleteBytes(healthy);
    expect(throwing.send).toHaveBeenCalledTimes(3);
    expect(onPeerComplete.mock.calls.map(([peer]) => peer.id).sort()).toEqual([
      'healthy',
      'throwing',
    ]);
  });

  it('completes an empty peer list immediately without reading the source', async () => {
    const { file, slice } = makeFile();
    const onPeerComplete = vi.fn();
    expect(await pumpChunksToPeers({ ...baseOpts, file, peers: [], onPeerComplete })).toEqual({
      status: 'complete',
      excluded: new Set(),
    });
    expect(slice).not.toHaveBeenCalled();
    expect(onPeerComplete).not.toHaveBeenCalled();
  });

  it('completes a zero-byte file once per writable peer without sending chunks', async () => {
    const { file, slice } = makeFile([]);
    const conn = makeConn('peer');
    const peer = makePeer('peer', conn);
    const onPeerComplete = vi.fn();
    expect(await pumpChunksToPeers({ ...baseOpts, file, peers: [peer], onPeerComplete })).toEqual({
      status: 'complete',
      excluded: new Set(),
    });
    expect(slice).not.toHaveBeenCalled();
    expect(conn.send).not.toHaveBeenCalled();
    expect(onPeerComplete).toHaveBeenCalledExactlyOnceWith(peer);
  });
});

describe('chunk-pump — state-free contract', () => {
  it('never imports setState; all state writes stay in wrappers', async () => {
    const source = (await import('../chunk-pump.ts?raw')).default as string;
    expect(source).not.toMatch(/import\s*\{[^}]*\bsetState\b/);
  });
});
