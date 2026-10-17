/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';
import { loadPreloadedTrack } from '../../player/decode.ts';
import { initPlayback } from '../../player/playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../preload.ts';
import { readStoredFile, resetAllStoredFiles } from '../storage.ts';

// Keep the real receiver, assembly, ACK and playback waiter. Native audio
// decoding is outside this transport test; observe its exact final handoff.
vi.mock('../../player/decode.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../player/decode.ts')>()),
  loadPreloadedTrack: vi.fn(async () => true),
}));

const CURRENT = '61000000-0000-4000-8000-000000000001';
const NEXT = '61000000-0000-4000-8000-000000000002';
const FUTURE = '61000000-0000-4000-8000-000000000003';
type Sender = 'broadcast' | 'unicast';
type Frame = { channel: Channel; data: string | ArrayBuffer };

// Deterministic browser-channel facade: the real Cloudflare adapter selects
// and encodes each channel, while the test controls queued bytes and native
// low-water events. This does not model SCTP timing or wireless throughput.
class Channel extends EventTarget {
  readyState = 'open';
  binaryType = 'arraybuffer';
  bufferedAmountLowThreshold = 19;

  constructor(
    readonly label: string,
    readonly wire: Frame[],
    public bufferedAmount = 0,
  ) {
    super();
  }

  send(data: string | ArrayBuffer): void {
    this.wire.push({ channel: this, data });
    if (data instanceof ArrayBuffer) this.bufferedAmount += data.byteLength;
  }

  close(): void {
    this.readyState = 'closed';
  }

  drain(amount = 0): void {
    this.bufferedAmount = amount;
    this.dispatchEvent(new Event('bufferedamountlow'));
  }

  deliver(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function header(frame: Frame): Record<string, unknown> {
  if (typeof frame.data === 'string') return JSON.parse(frame.data);
  const length = new DataView(frame.data).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(frame.data, 4, length)));
}

function connection(id: string, bufferedAmount = 0) {
  const wire: Frame[] = [];
  const transport = new CloudflareDataConnection(id);
  const pc = Object.assign(new EventTarget(), {
    connectionState: 'connected',
    iceConnectionState: 'connected',
  }) as unknown as RTCPeerConnection;
  const bulk = new Channel('musixquare-data', wire, bufferedAmount);
  const control = new Channel('musixquare-control', wire);
  transport.attach(pc, bulk as unknown as RTCDataChannel);
  transport.attach(pc, control as unknown as RTCDataChannel);
  const conn = transport as unknown as DataConnection;
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
  return { transport, conn, peer, pc, bulk, control, wire };
}

type Connection = ReturnType<typeof connection>;

function item(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

function publishPreload(file: File, queueItemId = NEXT, sessionId = 17): void {
  const ready = {
    queueItemId,
    sessionId,
    indexHint: getState('playlist.items').findIndex((row) => row.queueItemId === queueItemId),
    name: file.name,
    mime: file.type,
    size: file.size,
    total: Math.ceil(file.size / CHUNK_SIZE),
    blob: file,
  };
  setState('preload.nextQueueItemId', queueItemId);
  setState('preload.activeTarget', ready);
  setState('preload.ready', ready);
}

function frames(target: Connection, type: string, sessionId?: number): Frame[] {
  return target.wire.filter((frame) => {
    const message = header(frame);
    return message.type === type && (sessionId === undefined || message.sessionId === sessionId);
  });
}

async function begin(sender: Sender, file: File, target: Connection) {
  await vi.advanceTimersByTimeAsync(0);
  // This fixture starts after room admission and captures bytes before its
  // replay receiver exists. RTC open stays silent; explicitly activate then
  // exercise real old-peer fallback. Negotiated credit has separate coverage.
  expect(frames(target, 'mxqr-bulk-flow')).toEqual([]);
  target.transport.startBulkFlowControl();
  expect(frames(target, 'mxqr-bulk-flow').map(header)).toEqual([
    expect.objectContaining({ type: 'mxqr-bulk-flow', version: 1, kind: 'hello' }),
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  setState('network.connectedPeers', [target.peer]);
  setState('network.activeHostConnByPeerId', new Map([[target.peer.id, target.conn]]));
  setState('playlist.items', [item(CURRENT, new File(['old'], 'old.mp3')), item(NEXT, file)]);
  setState('playlist.currentQueueItemId', CURRENT);
  publishPreload(file);
  let done: Promise<void> = Promise.resolve();
  if (sender === 'unicast') done = unicastPreload(target.conn, file, NEXT, 17);
  else {
    setState('preload.ready', null);
    schedulePreload(0);
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(frames(target, MSG.PRELOAD_START)).toHaveLength(1);
  return { done, sessionId: header(frames(target, MSG.PRELOAD_START)[0]!).sessionId as number };
}

async function finish(target: Connection, sessionId: number, channel = target.bulk): Promise<void> {
  for (
    let attempt = 0;
    attempt < 12 && frames(target, MSG.PRELOAD_END, sessionId).length === 0;
    attempt++
  ) {
    channel.drain();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(frames(target, MSG.PRELOAD_END, sessionId)).toHaveLength(1);
}

async function verifyReceiver(
  wire: Frame[],
  file: File,
  sessionId: number,
  rejectedSessionId?: number,
  promoteAfterStart = false,
): Promise<void> {
  // Feed real binary wire frames through the receiving adapter and protocol,
  // including cross-channel late chunks where the caller specifies them.
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  resetFileDeliveryPolicies();
  setState('files.current', null);
  setState('network.connectedPeers', []);
  const receiver = connection('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.appRole', 'guest');
  setState('network.connectionType', 'local');
  setState('network.hostConn', receiver.conn);
  markQueueAuthorityReady(receiver.conn);
  expect(frames(receiver, 'mxqr-bulk-flow')).toEqual([]);
  receiver.transport.startBulkFlowControl();
  const deliveries: Promise<void>[] = [];
  receiver.transport.on('data', (message) => deliveries.push(handleData(message, receiver.conn)));
  for (const frame of wire) {
    const channel = frame.channel.label === 'musixquare-control' ? receiver.control : receiver.bulk;
    channel.deliver(frame.data);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(deliveries);
    if (promoteAfterStart && header(frame).type === MSG.PRELOAD_START) {
      await handleData(
        { type: MSG.PLAY_PRELOADED, queueItemId: NEXT, name: file.name },
        receiver.conn,
      );
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
      expect(loadPreloadedTrack).not.toHaveBeenCalled();
    }
  }
  const stored = await readStoredFile(NEXT, file.name, true, sessionId);
  expect(stored?.size).toBe(file.size);
  expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(
    new Uint8Array(await file.arrayBuffer()),
  );
  expect(frames(receiver, MSG.PRELOAD_ACK, sessionId)).toHaveLength(1);
  if (rejectedSessionId !== undefined) {
    expect(frames(receiver, MSG.PRELOAD_ACK, rejectedSessionId)).toHaveLength(0);
  }
  if (promoteAfterStart) {
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
    expect(loadPreloadedTrack).toHaveBeenCalledOnce();
    expect(vi.mocked(loadPreloadedTrack).mock.calls[0]?.[0]).toBe(NEXT);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetState();
  bus.clear();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetFileDeliveryPolicies();
  resetInboundRateLimit('host');
  initPreload();
  initPlayback();
});

afterEach(async () => {
  cancelPreloadTransfer();
  await vi.advanceTimersByTimeAsync(100);
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

describe.each(['broadcast', 'unicast'] as const)('%s preload capacity lifecycle', (sender) => {
  it('waits above one chunk, resumes at the exact boundary, and keeps control and final ACK intact', async () => {
    const target = connection('guest', CHUNK_SIZE + 1);
    const file = new File([new Uint8Array(3 * CHUNK_SIZE + 19).fill(7)], 'next.mp3');
    const { done, sessionId } = await begin(sender, file, target);
    expect(frames(target, MSG.PRELOAD_CHUNK)).toHaveLength(0);

    target.conn.send({ type: MSG.SYNC_PING, t0: 1 });
    expect(frames(target, MSG.SYNC_PING).at(-1)?.channel).toBe(target.control);
    expect(frames(target, MSG.PRELOAD_CHUNK)).toHaveLength(0);

    // Equality is allowed; the next full chunk plus its binary header then
    // parks the sender again. No 50 ms polling tick is needed to wake it.
    target.bulk.drain(CHUNK_SIZE);
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(target, MSG.PRELOAD_CHUNK, sessionId)).toHaveLength(1);
    expect(target.bulk.bufferedAmount).toBeGreaterThan(2 * CHUNK_SIZE);
    await finish(target, sessionId);
    await done;
    expect(
      frames(target, MSG.PRELOAD_CHUNK, sessionId).map((frame) => header(frame).chunkIndex),
    ).toEqual([0, 1, 2, 3]);
    expect(frames(target, MSG.PRELOAD_END, sessionId)[0]?.channel).toBe(target.bulk);
    await verifyReceiver(
      target.wire.filter((frame) => header(frame).type !== MSG.SYNC_PING),
      file,
      sessionId,
    );
  });

  it('cancels a parked sender without flushing stale bytes into a replacement unicast or ACK', async () => {
    const target = connection('guest', CHUNK_SIZE + 1);
    const staleFile = new File([new Uint8Array(3 * CHUNK_SIZE).fill(3)], 'old-next.mp3');
    const { done, sessionId } = await begin(sender, staleFile, target);
    target.bulk.drain();
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(target, MSG.PRELOAD_CHUNK, sessionId)).toHaveLength(1);
    cancelPreloadTransfer(NEXT);
    expect(frames(target, MSG.PRELOAD_ABORT, sessionId)).toHaveLength(1);

    const file = new File([new Uint8Array(2 * CHUNK_SIZE + 7).fill(9)], 'replacement.mp3');
    const replacementSession = sessionId + 1;
    setState('playlist.items', [getState('playlist.items')[0]!, item(NEXT, file)]);
    publishPreload(file, NEXT, replacementSession);
    const replacement = unicastPreload(target.conn, file, NEXT, replacementSession);
    await vi.advanceTimersByTimeAsync(0);
    await finish(target, replacementSession);
    await Promise.all([done, replacement]);
    expect(frames(target, MSG.PRELOAD_CHUNK, sessionId)).toHaveLength(1);
    expect(frames(target, MSG.PRELOAD_END, sessionId)).toHaveLength(0);

    // ABORT and the new START can overtake the old chunk on the other
    // channel. Its bytes must neither contaminate the new file nor earn ACK.
    const oldStart = frames(target, MSG.PRELOAD_START, sessionId)[0]!;
    const abort = frames(target, MSG.PRELOAD_ABORT, sessionId)[0]!;
    const newStart = frames(target, MSG.PRELOAD_START, replacementSession)[0]!;
    const lateChunk = frames(target, MSG.PRELOAD_CHUNK, sessionId)[0]!;
    const newTail = target.wire.filter((frame) => {
      const message = header(frame);
      return message.sessionId === replacementSession && message.type !== MSG.PRELOAD_START;
    });
    await verifyReceiver(
      [oldStart, abort, newStart, lateChunk, ...newTail],
      file,
      replacementSession,
      sessionId,
    );
  });

  it('retires an exact-channel waiter before a replacement channel bootstraps the same occurrence', async () => {
    const target = connection('guest', CHUNK_SIZE + 1);
    const file = new File([new Uint8Array(2 * CHUNK_SIZE + 13).fill(5)], 'next.mp3');
    const { done, sessionId } = await begin(sender, file, target);
    target.bulk.drain();
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(target, MSG.PRELOAD_CHUNK, sessionId)).toHaveLength(1);

    const replacement = new Channel('musixquare-data', target.wire, CHUNK_SIZE + 1);
    target.transport.attach(target.pc, replacement as unknown as RTCDataChannel);
    target.bulk.drain();
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(frames(target, MSG.PRELOAD_END, sessionId)).toHaveLength(0);
    expect(target.bulk.bufferedAmountLowThreshold).toBe(19);
    const oldChannelFrames = target.wire.filter((frame) => frame.channel === target.bulk);
    const retry = unicastPreload(target.conn, file, NEXT, sessionId);
    await vi.advanceTimersByTimeAsync(0);
    target.bulk.drain();
    await vi.advanceTimersByTimeAsync(10);
    expect(target.wire.filter((frame) => frame.channel === replacement)).toHaveLength(0);
    await finish(target, sessionId, replacement);
    await retry;
    expect(target.wire.filter((frame) => frame.channel === target.bulk)).toEqual(oldChannelFrames);
    expect(frames(target, MSG.PRELOAD_END, sessionId)[0]?.channel).toBe(replacement);
    // Replay both attempts: an aborted broadcast restarts the admitted slot,
    // while an interrupted unicast reuses its prefix and drops duplicates.
    await verifyReceiver(target.wire, file, sessionId);
  });

  it('preserves a capacity-waiting promotion and finishes it before a future late-join unicast', async () => {
    const target = connection('guest', CHUNK_SIZE + 1);
    const file = new File([new Uint8Array(2 * CHUNK_SIZE + 13).fill(5)], 'next.mp3');
    const { done, sessionId } = await begin(sender, file, target);
    expect(frames(target, MSG.PRELOAD_CHUNK)).toHaveLength(0);
    setState('files.current', getState('preload.ready'));
    setState('playlist.currentQueueItemId', NEXT);
    cancelPreloadTransfer(undefined, true);
    const futureFile = new File([new Uint8Array(CHUNK_SIZE + 17).fill(11)], 'future.mp3');
    setState('playlist.items', [...getState('playlist.items'), item(FUTURE, futureFile)]);
    publishPreload(futureFile, FUTURE, sessionId + 1);
    const future = unicastPreload(target.conn, futureFile, FUTURE, sessionId + 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(target, MSG.PRELOAD_START).map((frame) => header(frame).queueItemId)).toEqual([
      NEXT,
    ]);
    await finish(target, sessionId);
    await finish(target, sessionId + 1);
    await Promise.all([done, future]);
    expect(frames(target, MSG.PRELOAD_ABORT)).toHaveLength(0);
    const completed = target.wire.findIndex(
      (frame) => header(frame).type === MSG.PRELOAD_END && header(frame).queueItemId === NEXT,
    );
    const futureStart = target.wire.findIndex(
      (frame) => header(frame).type === MSG.PRELOAD_START && header(frame).queueItemId === FUTURE,
    );
    expect(completed).toBeLessThan(futureStart);
    expect(
      frames(target, MSG.PRELOAD_CHUNK, sessionId).map((frame) => header(frame).chunkIndex),
    ).toEqual([0, 1, 2]);
    expect(
      frames(target, MSG.PRELOAD_CHUNK, sessionId + 1).map((frame) => header(frame).chunkIndex),
    ).toEqual([0, 1]);
    const completedCount = target.wire.length;
    await unicastPreload(target.conn, file, NEXT, sessionId);
    await unicastPreload(target.conn, futureFile, FUTURE, sessionId + 1);
    expect(target.wire).toHaveLength(completedCount);
    // The guest gets PLAY_PRELOADED before the remaining bytes, using the
    // actual AWAITING_PRELOAD -> DECODING handoff instead of fabricating a
    // files.current resident. Verify the promoted file and its single ACK.
    await verifyReceiver(
      target.wire.filter((frame) => header(frame).sessionId === sessionId),
      file,
      sessionId,
      undefined,
      true,
    );
  });
});
