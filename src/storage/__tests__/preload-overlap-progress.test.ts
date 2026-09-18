/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { initPlayback } from '../../player/playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  getPreloadMemoryStats,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../preload.ts';
import { readStoredFile, resetAllStoredFiles } from '../storage.ts';

const CURRENT = '20000000-0000-4000-8000-000000000001';
const NEXT = '20000000-0000-4000-8000-000000000002';

function fileItem(queueItemId: string, name: string): PlaylistItem {
  return {
    queueItemId,
    name,
    type: 'file',
    videoId: null,
    playlistId: null,
    file: new File([new Uint8Array(CHUNK_SIZE + 1)], name, { type: 'audio/mpeg' }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetFileDeliveryPolicies();
  initPreload();
  initPlayback();
});

afterEach(async () => {
  cancelPreloadTransfer();
  await vi.advanceTimersByTimeAsync(100);
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

describe('overlapping preload broadcast and late bootstrap', () => {
  it('keeps received progress when the real senders announce the same transfer twice', async () => {
    const current = fileItem(CURRENT, 'current.mp3');
    const next = fileItem(NEXT, 'next.mp3');
    setState('playlist.items', [current, next]);
    setState('playlist.currentQueueItemId', CURRENT);
    const wire: Array<Record<string, unknown>> = [];
    const channel = { readyState: 'open', bufferedAmount: 0 };
    const conn = {
      open: true,
      peer: 'late-guest',
      dataChannel: channel,
      send: vi.fn((message: unknown) => {
        const frame = message as Record<string, unknown>;
        wire.push(frame);
        if (frame.type === MSG.PRELOAD_CHUNK) channel.bufferedAmount = 1024 * 1024;
      }),
    } as unknown as DataConnection;
    const peer: ConnectedPeer = {
      id: conn.peer,
      conn,
      slot: 1,
      label: 'late-guest',
      isOp: false,
      preloadedQueueItemIds: new Set(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: 0,
    };
    setState('network.connectedPeers', [peer]);
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    const ready = getState('preload.ready')!;

    // bootstrapLocalPeerFile enters this real sender after its foreground
    // unicast settles; the room preload may already include the same peer.
    const lateBootstrap = unicastPreload(conn, ready.blob, NEXT, ready.sessionId);
    await vi.advanceTimersByTimeAsync(0);
    const overlap = [...wire];
    expect(overlap.map((frame) => frame.type)).toEqual([
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_START,
    ]);
    cancelPreloadTransfer();
    await vi.advanceTimersByTimeAsync(100);
    await lateBootstrap;

    // Replay the actual produced prefix into the real protocol and RAM store.
    // Native network delivery is the only substituted boundary here.
    resetPreloadReceiveAuthority();
    setState('network.connectedPeers', []);
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    markQueueAuthorityReady(conn);
    for (const frame of overlap) await handleData(frame, conn);
    expect(getState('preload.sessionState').get(ready.sessionId)).toMatchObject({
      progress: 1,
      nextExpectedChunk: 1,
      finalized: false,
    });

    // A redundant lane can also resend an already-drained prefix. It must
    // not retain an extra copy outside the storage admission ledger.
    await handleData(overlap[1]!, conn);
    expect(getPreloadMemoryStats().reorderBytes).toBe(0);

    await handleData(
      {
        type: MSG.PRELOAD_CHUNK,
        sessionId: ready.sessionId,
        queueItemId: NEXT,
        chunkIndex: 1,
        chunk: new Uint8Array([7]),
      },
      conn,
    );
    const completed = await readStoredFile(NEXT, next.name, true, ready.sessionId);
    expect(completed?.size).toBe(CHUNK_SIZE + 1);
    expect(new Uint8Array(await completed!.arrayBuffer()).at(-1)).toBe(7);
    expect(getState('preload.ready')?.queueItemId).toBe(NEXT);
  });

  it('retains the completed resident when late bootstrap repeats its START and chunks', async () => {
    const conn = { open: true, peer: 'host', send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    markQueueAuthorityReady(conn);
    setState('playlist.items', [fileItem(CURRENT, 'current.mp3'), fileItem(NEXT, 'next.mp3')]);
    setState('playlist.currentQueueItemId', CURRENT);
    const start = {
      type: MSG.PRELOAD_START,
      queueItemId: NEXT,
      sessionId: 41,
      name: 'next.mp3',
      mime: 'audio/mpeg',
      total: 1,
      size: 3,
    };
    const chunk = {
      type: MSG.PRELOAD_CHUNK,
      queueItemId: NEXT,
      sessionId: 41,
      chunkIndex: 0,
      chunk: new Uint8Array([1, 2, 3]),
    };
    await handleData(start, conn);
    await handleData(chunk, conn);
    const resident = getState('preload.ready');
    expect(resident?.queueItemId).toBe(NEXT);
    await handleData(start, conn);
    await handleData(chunk, conn);
    expect(getState('preload.ready')).toBe(resident);
    expect(getState('preload.sessionState').get(41)?.finalized).toBe(true);
    expect(getPreloadMemoryStats().reorderBytes).toBe(0);
    expect(conn.send).toHaveBeenCalledTimes(1);
  });

  it('allows a real receive after a skipped header while rejecting a changed admitted tuple', async () => {
    const conn = { open: true, peer: 'host', send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    markQueueAuthorityReady(conn);
    setState('playlist.items', [fileItem(CURRENT, 'current.mp3'), fileItem(NEXT, 'next.mp3')]);
    const start = {
      type: MSG.PRELOAD_START,
      queueItemId: NEXT,
      sessionId: 42,
      name: 'next.mp3',
      mime: 'audio/mpeg',
      total: 2,
      size: CHUNK_SIZE + 1,
    };
    await handleData({ ...start, skipped: true }, conn);
    expect(getState('preload.sessionState').get(42)?.skipped).toBe(true);
    await handleData({ ...start, skipped: false }, conn);
    const admitted = getState('preload.sessionState').get(42);
    expect(admitted?.skipped).toBe(false);
    await handleData({ ...start, queueItemId: CURRENT, name: 'current.mp3' }, conn);
    expect(getState('preload.sessionState').get(42)).toBe(admitted);
    expect(getState('preload.activeTarget')?.queueItemId).toBe(NEXT);
  });
});
