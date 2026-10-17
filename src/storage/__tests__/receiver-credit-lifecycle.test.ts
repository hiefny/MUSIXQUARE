/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../preload.ts';
import { resetAllStoredFiles } from '../storage.ts';
import { initTransfer } from '../transfer.ts';
import {
  broadcastFile,
  cancelOutgoingFileTransfers,
  hasPendingCurrentFileTransfer,
  unicastFile,
} from '../transfer-send.ts';

const CURRENT = '62000000-0000-4000-8000-000000000001';
const NEXT = '62000000-0000-4000-8000-000000000002';
const FUTURE = '62000000-0000-4000-8000-000000000003';
const WINDOW = 2 * CHUNK_SIZE;
type Lane = 'file-broadcast' | 'file-unicast' | 'preload-broadcast' | 'preload-unicast';
const LANES: Lane[] = ['file-broadcast', 'file-unicast', 'preload-broadcast', 'preload-unicast'];
type Frame = Record<string, unknown>;

// This facade deliberately drains the native queue immediately. Only explicit
// receiver credit can release the real storage sender's next chunk. Adapter
// wire negotiation/ACK validation are tested separately by transport tests.
function connection(id: string, bufferedAmount = 0) {
  const wire: Frame[] = [];
  const listeners = new Set<() => void>();
  let sent = 0;
  let acknowledged = 0;
  let maximumOutstanding = 0;
  const channel = Object.assign(new EventTarget(), {
    readyState: 'open',
    bufferedAmount,
    bufferedAmountLowThreshold: 0,
  });
  const credit = {
    hasCapacity: (bytes: number) => sent - acknowledged + bytes <= WINDOW,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const conn = {
    open: true,
    peer: id,
    dataChannel: channel,
    bulkFlowControl: credit,
    send: vi.fn((value: unknown) => {
      const frame = value as Frame;
      if (frame.type === MSG.FILE_CHUNK || frame.type === MSG.PRELOAD_CHUNK) {
        const bytes = (frame.chunk as Uint8Array).byteLength;
        if (!credit.hasCapacity(bytes)) throw new Error('sender exceeded receiver window');
        sent += bytes;
        maximumOutstanding = Math.max(maximumOutstanding, sent - acknowledged);
      }
      wire.push(frame);
    }),
  } as unknown as DataConnection;
  const peer: ConnectedPeer = {
    id,
    conn,
    slot: 1,
    label: id,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
  return {
    conn,
    peer,
    channel,
    wire,
    listeners,
    get outstanding() {
      return sent - acknowledged;
    },
    get maximumOutstanding() {
      return maximumOutstanding;
    },
    acknowledge(bytes = sent - acknowledged) {
      if (bytes < 0 || acknowledged + bytes > sent) throw new Error('invalid test receipt');
      acknowledged += bytes;
      for (const listener of [...listeners]) listener();
    },
  };
}

type Target = ReturnType<typeof connection>;

function item(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

function resident(file: File, queueItemId: string, sessionId: number) {
  return {
    blob: file,
    queueItemId,
    sessionId,
    name: file.name,
    mime: file.type,
    size: file.size,
    total: Math.ceil(file.size / CHUNK_SIZE),
    indexHint: getState('playlist.items').findIndex((row) => row.queueItemId === queueItemId),
  };
}

function publishCurrent(file: File, queueItemId = CURRENT, sessionId = 6): void {
  setState('playlist.currentQueueItemId', queueItemId);
  setState('transfer.currentSessionId', sessionId);
  setState('files.current', resident(file, queueItemId, sessionId));
}

function publishPreload(file: File, queueItemId = NEXT, sessionId = 7): void {
  const ready = resident(file, queueItemId, sessionId);
  setState('preload.nextQueueItemId', queueItemId);
  setState('preload.activeTarget', ready);
  setState('preload.ready', ready);
}

function installPeers(...targets: Target[]): void {
  setState(
    'network.connectedPeers',
    targets.map((target) => target.peer),
  );
  setState('network.activeHostConnByPeerId', new Map(targets.map((t) => [t.peer.id, t.conn])));
}

function frames(target: Target, type: string, sessionId?: number): Frame[] {
  return target.wire.filter(
    (frame) => frame.type === type && (sessionId === undefined || frame.sessionId === sessionId),
  );
}

function kind(lane: Lane) {
  return lane.startsWith('file')
    ? { start: MSG.FILE_START, chunk: MSG.FILE_CHUNK, end: MSG.FILE_END }
    : { start: MSG.PRELOAD_START, chunk: MSG.PRELOAD_CHUNK, end: MSG.PRELOAD_END };
}

function launch(lane: Lane, target: Target, file: File): Promise<void> {
  if (lane.startsWith('file')) {
    setState('playlist.items', [item(CURRENT, file)]);
    publishCurrent(file);
    return lane === 'file-broadcast'
      ? broadcastFile(file, CURRENT, 6)
      : unicastFile(target.conn, file, 0, 6, { queueItemId: CURRENT });
  }
  setState('playlist.items', [item(CURRENT, new File(['old'], 'old.mp3')), item(NEXT, file)]);
  setState('playlist.currentQueueItemId', CURRENT);
  publishPreload(file);
  if (lane === 'preload-unicast') return unicastPreload(target.conn, file, NEXT, 7);
  setState('preload.ready', null);
  schedulePreload(0);
  return Promise.resolve();
}

async function finish(target: Target, end: string, sessionId?: number): Promise<void> {
  for (let step = 0; step < 8 && frames(target, end, sessionId).length === 0; step++) {
    target.acknowledge();
    await vi.advanceTimersByTimeAsync(150);
  }
  expect(frames(target, end, sessionId)).toHaveLength(1);
}

function sentBytes(target: Target, type: string, sessionId?: number): Uint8Array {
  const chunks = frames(target, type, sessionId).map((frame) => frame.chunk as Uint8Array);
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetFileDeliveryPolicies();
  initTransfer();
  initPreload();
});

afterEach(async () => {
  cancelPreloadTransfer();
  cancelOutgoingFileTransfers();
  await vi.advanceTimersByTimeAsync(100);
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(LANES)('%s receiver-confirmed capacity', (lane) => {
  it('reacquires credit when another lane consumes a wakeup before the async continuation', async () => {
    const target = connection('credit-wakeup-race');
    const file = new File([new Uint8Array(CHUNK_SIZE).fill(8)], 'track.mp3');
    const types = kind(lane);
    const otherType = lane.startsWith('file') ? MSG.PRELOAD_CHUNK : MSG.FILE_CHUNK;
    const sendOtherLane = () =>
      target.conn.send({
        type: otherType,
        chunk: new Uint8Array(CHUNK_SIZE),
        chunkIndex: 0,
        queueItemId: FUTURE,
        sessionId: 99,
      });
    installPeers(target);
    sendOtherLane();
    sendOtherLane();
    const done = launch(lane, target, file);
    await vi.advanceTimersByTimeAsync(150);
    expect(target.listeners.size).toBeGreaterThan(0);
    expect(frames(target, types.chunk)).toHaveLength(0);

    // Receipt resolves the capacity promise synchronously. Spend that credit
    // before its awaiting sender continuation can run in the next microtask.
    target.acknowledge(CHUNK_SIZE);
    sendOtherLane();
    await vi.advanceTimersByTimeAsync(1);
    expect(frames(target, types.chunk)).toHaveLength(0);
    expect(frames(target, types.end)).toHaveLength(0);
    expect(target.listeners.size).toBeGreaterThan(0);
    target.acknowledge(CHUNK_SIZE);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(frames(target, types.chunk)).toHaveLength(1);
    expect(frames(target, types.end)).toHaveLength(1);
    expect(sentBytes(target, types.chunk)).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect(target.maximumOutstanding).toBe(WINDOW);
  });

  it('retains its one prepared chunk when another lane spends credit during the Blob read', async () => {
    const target = connection('credit-read-race');
    const bytes = new Uint8Array(CHUNK_SIZE).fill(9);
    const file = new File([bytes], 'track.mp3');
    let release!: (bytes: ArrayBuffer) => void;
    const held = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => held } as Blob);
    const types = kind(lane);
    const otherType = lane.startsWith('file') ? MSG.PRELOAD_CHUNK : MSG.FILE_CHUNK;
    installPeers(target);
    const done = launch(lane, target, file);
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledOnce();
    for (let index = 0; index < 2; index++) {
      target.conn.send({
        type: otherType,
        chunk: new Uint8Array(CHUNK_SIZE),
        chunkIndex: index,
        queueItemId: FUTURE,
        sessionId: 99,
      });
    }
    release(bytes.buffer);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames(target, types.chunk)).toHaveLength(0);
    expect(frames(target, types.end)).toHaveLength(0);
    expect(target.listeners.size).toBeGreaterThan(0);
    target.acknowledge(CHUNK_SIZE);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(read).toHaveBeenCalledOnce();
    expect(frames(target, types.chunk)).toHaveLength(1);
    expect(frames(target, types.end)).toHaveLength(1);
    expect(sentBytes(target, types.chunk)).toEqual(bytes);
    expect(target.maximumOutstanding).toBe(WINDOW);
  });

  it('parks with native bufferedAmount zero, wakes on receipt, and admits an exact partial tail', async () => {
    const target = connection('receiver');
    const bytes = new Uint8Array(3 * CHUNK_SIZE + 17).map((_, i) => i % 251);
    const file = new File([bytes], 'track.mp3');
    installPeers(target);
    const done = launch(lane, target, file);
    await vi.advanceTimersByTimeAsync(150);
    const types = kind(lane);
    expect(frames(target, types.chunk).map((frame) => frame.chunkIndex)).toEqual([0, 1]);
    expect(target.channel.bufferedAmount).toBe(0);
    expect(target.outstanding).toBe(WINDOW);
    expect(frames(target, types.end)).toHaveLength(0);
    target.conn.send({ type: MSG.SYNC_PING, t0: 1 });
    expect(frames(target, MSG.SYNC_PING)).toHaveLength(1);

    target.acknowledge(CHUNK_SIZE);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames(target, types.chunk).map((frame) => frame.chunkIndex)).toEqual([0, 1, 2]);
    expect(frames(target, types.end)).toHaveLength(0);
    // Only 17 bytes become available: requesting a whole chunk here would
    // deadlock the tail until another otherwise unnecessary receipt arrives.
    target.acknowledge(17);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(frames(target, types.end)).toHaveLength(1);
    expect(sentBytes(target, types.chunk)).toEqual(bytes);
    expect(target.maximumOutstanding).toBe(WINDOW);
    expect(target.listeners.size).toBe(0);
    // Transport receipts never assert durable preload/decode readiness.
    expect(target.peer.preloadedQueueItemIds?.size).toBe(0);
  });

  it('releases an obsolete exact-connection waiter without borrowing its replacement credit', async () => {
    const old = connection('same-peer');
    const fresh = connection('same-peer');
    const file = new File([new Uint8Array(3 * CHUNK_SIZE).fill(3)], 'track.mp3');
    installPeers(old);
    const oldDone = launch(lane, old, file);
    await vi.advanceTimersByTimeAsync(150);
    const types = kind(lane);
    expect(frames(old, types.chunk)).toHaveLength(2);
    const sessionId = frames(old, types.start)[0]!.sessionId as number;
    installPeers(fresh);
    bus.emit('network:peer-connection-replaced', fresh.peer.id);
    const freshDone = lane.startsWith('file')
      ? unicastFile(fresh.conn, file, 0, sessionId, { queueItemId: CURRENT })
      : unicastPreload(fresh.conn, file, NEXT, sessionId);
    await vi.advanceTimersByTimeAsync(150);
    expect(frames(fresh, types.chunk)).toHaveLength(2);
    old.acknowledge();
    await vi.advanceTimersByTimeAsync(50);
    expect(frames(old, types.chunk)).toHaveLength(2);
    expect(frames(old, types.end)).toHaveLength(0);
    expect(frames(fresh, types.chunk)).toHaveLength(2);
    await finish(fresh, types.end);
    await Promise.all([oldDone, freshDone]);
    expect(old.listeners.size).toBe(0);
    expect(fresh.listeners.size).toBe(0);
    expect(sentBytes(fresh, types.chunk)).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
});

describe('shared receiver credit across storage lanes', () => {
  it.each(['file-broadcast', 'preload-broadcast'] as const)(
    '%s allows a fast peer to complete while a sibling waits for its own receipt',
    async (lane) => {
      const fast = connection('fast');
      const slow = connection('slow');
      const file = new File([new Uint8Array(4 * CHUNK_SIZE + 7)], 'track.mp3');
      installPeers(fast, slow);
      const done = launch(lane, fast, file);
      await vi.advanceTimersByTimeAsync(150);
      const types = kind(lane);
      expect(frames(slow, types.chunk)).toHaveLength(2);
      await finish(fast, types.end);
      expect(frames(slow, types.chunk)).toHaveLength(2);
      expect(frames(slow, types.end)).toHaveLength(0);
      await finish(slow, types.end);
      await done;
      expect(sentBytes(fast, types.chunk)).toEqual(sentBytes(slow, types.chunk));
      expect(fast.maximumOutstanding).toBeLessThanOrEqual(WINDOW);
      expect(slow.maximumOutstanding).toBeLessThanOrEqual(WINDOW);
    },
  );

  it.each(['file-broadcast', 'file-unicast'] as const)(
    '%s parks above 64 KiB even when receiver credit is available',
    async (lane) => {
      const target = connection('native-window', CHUNK_SIZE + 1);
      const file = new File([new Uint8Array(CHUNK_SIZE)], 'track.mp3');
      installPeers(target);
      const done = launch(lane, target, file);
      await vi.advanceTimersByTimeAsync(150);
      expect(frames(target, MSG.FILE_CHUNK)).toHaveLength(0);
      target.channel.bufferedAmount = CHUNK_SIZE;
      target.channel.dispatchEvent(new Event('bufferedamountlow'));
      await vi.advanceTimersByTimeAsync(10);
      await done;
      expect(frames(target, MSG.FILE_CHUNK)).toHaveLength(1);
      expect(frames(target, MSG.FILE_END)).toHaveLength(1);
    },
  );

  it('keeps already sent preload bytes charged while foreground work takes priority', async () => {
    const target = connection('shared-window');
    const current = new File([new Uint8Array(CHUNK_SIZE).fill(1)], 'current.mp3');
    const next = new File([new Uint8Array(3 * CHUNK_SIZE).fill(2)], 'next.mp3');
    installPeers(target);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    publishCurrent(current);
    publishPreload(next);
    const preload = unicastPreload(target.conn, next, NEXT, 7);
    await vi.advanceTimersByTimeAsync(150);
    expect(frames(target, MSG.PRELOAD_CHUNK)).toHaveLength(2);
    const main = unicastFile(target.conn, current, 0, 6, { queueItemId: CURRENT });
    await vi.advanceTimersByTimeAsync(150);
    expect(hasPendingCurrentFileTransfer(target.conn)).toBe(true);
    expect(frames(target, MSG.FILE_CHUNK)).toHaveLength(0);
    target.acknowledge(CHUNK_SIZE);
    await vi.advanceTimersByTimeAsync(50);
    await main;
    expect(frames(target, MSG.FILE_CHUNK)).toHaveLength(1);
    expect(frames(target, MSG.FILE_END)).toHaveLength(1);
    expect(frames(target, MSG.PRELOAD_CHUNK)).toHaveLength(2);
    expect(target.outstanding).toBe(WINDOW);
    await finish(target, MSG.PRELOAD_END);
    await preload;
    expect(target.maximumOutstanding).toBe(WINDOW);
    expect(sentBytes(target, MSG.FILE_CHUNK)).toEqual(new Uint8Array(await current.arrayBuffer()));
    expect(sentBytes(target, MSG.PRELOAD_CHUNK)).toEqual(new Uint8Array(await next.arrayBuffer()));
  });

  it.each(LANES)(
    '%s retains connection debt after cancellation without stale chunks',
    async (lane) => {
      const target = connection('cancel');
      const stale = new File([new Uint8Array(3 * CHUNK_SIZE).fill(4)], 'stale.mp3');
      const fresh = new File([new Uint8Array(CHUNK_SIZE).fill(5)], 'fresh.mp3');
      installPeers(target);
      const staleDone = launch(lane, target, stale);
      await vi.advanceTimersByTimeAsync(150);
      const types = kind(lane);
      const oldSession = frames(target, types.start)[0]!.sessionId as number;
      const newSession = oldSession + 1;
      expect(frames(target, types.chunk, oldSession)).toHaveLength(2);
      let freshDone: Promise<void>;
      if (lane.startsWith('file')) {
        cancelOutgoingFileTransfers();
        setState('playlist.items', [item(CURRENT, fresh)]);
        publishCurrent(fresh, CURRENT, newSession);
        freshDone = unicastFile(target.conn, fresh, 0, newSession, { queueItemId: CURRENT });
      } else {
        cancelPreloadTransfer(NEXT);
        setState('playlist.items', [getState('playlist.items')[0]!, item(NEXT, fresh)]);
        publishPreload(fresh, NEXT, newSession);
        freshDone = unicastPreload(target.conn, fresh, NEXT, newSession);
      }
      await vi.advanceTimersByTimeAsync(150);
      expect(frames(target, types.chunk, newSession)).toHaveLength(0);
      target.acknowledge(CHUNK_SIZE);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.all([staleDone, freshDone]);
      expect(frames(target, types.chunk, oldSession)).toHaveLength(2);
      expect(frames(target, types.end, oldSession)).toHaveLength(0);
      expect(frames(target, types.end, newSession)).toHaveLength(1);
      expect(sentBytes(target, types.chunk, newSession)).toEqual(
        new Uint8Array(await fresh.arrayBuffer()),
      );
      expect(target.maximumOutstanding).toBe(WINDOW);
    },
  );

  it('keeps credit charged across active-file resume and sends only the requested suffix', async () => {
    const target = connection('resume');
    const bytes = new Uint8Array(3 * CHUNK_SIZE + 17).map((_, i) => i % 241);
    const file = new File([bytes], 'resume.mp3');
    installPeers(target);
    const original = launch('file-broadcast', target, file);
    await vi.advanceTimersByTimeAsync(150);
    expect(frames(target, MSG.FILE_CHUNK).map((frame) => frame.chunkIndex)).toEqual([0, 1]);
    const resumed = unicastFile(target.conn, file, 2, 6, { queueItemId: CURRENT });
    await vi.advanceTimersByTimeAsync(150);
    expect(frames(target, MSG.FILE_RESUME)).toHaveLength(1);
    expect(frames(target, MSG.FILE_CHUNK)).toHaveLength(2);
    target.acknowledge(CHUNK_SIZE + 17);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([original, resumed]);
    expect(frames(target, MSG.FILE_CHUNK).map((frame) => frame.chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(frames(target, MSG.FILE_END)).toHaveLength(1);
    expect(sentBytes(target, MSG.FILE_CHUNK)).toEqual(bytes);
    expect(target.maximumOutstanding).toBe(WINDOW);
  });

  it.each(['preload-broadcast', 'preload-unicast'] as const)(
    '%s preserves a parked promotion and its credit before starting the next preload',
    async (lane) => {
      const target = connection('promoted');
      const next = new File([new Uint8Array(3 * CHUNK_SIZE).fill(6)], 'next.mp3');
      const future = new File([new Uint8Array(CHUNK_SIZE).fill(7)], 'future.mp3');
      installPeers(target);
      const done = launch(lane, target, next);
      await vi.advanceTimersByTimeAsync(150);
      const sessionId = frames(target, MSG.PRELOAD_START)[0]!.sessionId as number;
      expect(frames(target, MSG.PRELOAD_CHUNK, sessionId)).toHaveLength(2);
      setState('files.current', getState('preload.ready'));
      setState('playlist.currentQueueItemId', NEXT);
      cancelPreloadTransfer(undefined, true);
      setState('playlist.items', [...getState('playlist.items'), item(FUTURE, future)]);
      publishPreload(future, FUTURE, sessionId + 1);
      const successor = unicastPreload(target.conn, future, FUTURE, sessionId + 1);
      await vi.advanceTimersByTimeAsync(50);
      expect(frames(target, MSG.PRELOAD_START)).toHaveLength(1);
      target.acknowledge(CHUNK_SIZE);
      await vi.advanceTimersByTimeAsync(50);
      expect(frames(target, MSG.PRELOAD_END, sessionId)).toHaveLength(1);
      expect(frames(target, MSG.PRELOAD_CHUNK, sessionId + 1)).toHaveLength(0);
      expect(target.outstanding).toBe(WINDOW);
      await finish(target, MSG.PRELOAD_END, sessionId + 1);
      await Promise.all([done, successor]);
      expect(frames(target, MSG.PRELOAD_ABORT)).toHaveLength(0);
      expect(sentBytes(target, MSG.PRELOAD_CHUNK, sessionId)).toEqual(
        new Uint8Array(await next.arrayBuffer()),
      );
      expect(sentBytes(target, MSG.PRELOAD_CHUNK, sessionId + 1)).toEqual(
        new Uint8Array(await future.arrayBuffer()),
      );
      expect(target.maximumOutstanding).toBe(WINDOW);
    },
  );
});
