/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import * as peerTransport from '../../network/peer.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  unicastPreload,
} from '../preload.ts';
import { resetAllStoredFiles } from '../storage.ts';
import { initTransfer } from '../transfer.ts';
import {
  broadcastFile,
  cancelOutgoingFileTransfers,
  isMainLanePreparingOrActive,
  unicastFile,
} from '../transfer-send.ts';

/**
 * RO-18, host-to-guest bulk lanes (Phase 4 reduced C5-11, behaviour-neutral).
 * The main file lane and the preload lanes of one peer are released by one
 * call on a disconnect or a replacement, and the main lane answers one exact
 * tuple query: is it preparing or streaming (conn, queueItemId, sessionId)?
 * After ICE recovery a resumed preload yields to it (C5-12, owner decision
 * P4-D10 A; ice-recovery-bulk-lanes.test.ts).
 */

const CURRENT = '60000000-0000-4000-8000-000000000001';
const NEXT = '60000000-0000-4000-8000-000000000002';
type Frame = Record<string, unknown>;

function item(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

function connection(id: string, bufferedAmount = 0) {
  const wire: Frame[] = [];
  const channel = { readyState: 'open', bufferedAmount };
  const conn = {
    open: true,
    peer: id,
    dataChannel: channel,
    send: vi.fn((message: unknown) => wire.push(message as Frame)),
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
  return { conn, peer, channel, wire };
}

function installPeers(...peers: ConnectedPeer[]): void {
  setState('network.connectedPeers', peers);
  setState('network.activeHostConnByPeerId', new Map(peers.map((peer) => [peer.id, peer.conn!])));
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

function publishTracks(current: File, next: File): void {
  setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
  setState('playlist.currentQueueItemId', CURRENT);
  setState('transfer.currentSessionId', 6);
  setState('files.current', resident(current, CURRENT, 6));
  const ready = resident(next, NEXT, 7);
  setState('preload.nextQueueItemId', NEXT);
  setState('preload.activeTarget', ready);
  setState('preload.ready', ready);
}

function types(wire: readonly Frame[]): unknown[] {
  return wire.map((frame) => frame.type);
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
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('one release call for both bulk lanes of a peer', () => {
  it('registers one storage listener for each peer event', () => {
    const listeners = bus.debug();
    expect(listeners['network:peer-disconnected']).toBe(1);
    expect(listeners['network:peer-connection-replaced']).toBe(1);
  });

  it.each(['network:peer-disconnected', 'network:peer-connection-replaced'] as const)(
    '%s ends the main lane and the preload lane parked behind it',
    async (event) => {
      // The connection stays open and current: only the release can stop the lanes.
      const target = connection('mx-guest-release', 1024 * 1024);
      const current = new File(['current'], 'current.mp3');
      const next = new File(['next'], 'next.mp3');
      installPeers(target.peer);
      publishTracks(current, next);
      const main = unicastFile(target.conn, current, 0, 6, { queueItemId: CURRENT });
      await vi.advanceTimersByTimeAsync(200);
      const preload = unicastPreload(target.conn, next, NEXT, 7);
      await vi.advanceTimersByTimeAsync(200);
      // The main lane holds its next chunk; the speculative preload yields to it.
      expect(types(target.wire)).toEqual([MSG.FILE_START]);
      expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(true);

      bus.emit(event, target.peer.id);
      expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(false);

      // Capacity returns: neither released lane sends another frame.
      target.channel.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([main, preload]);
      expect(types(target.wire)).toEqual([MSG.FILE_START]);
    },
  );
});

describe('main-lane tuple query', () => {
  it('answers for a unicast preparing behind its transport guard, by exact tuple', async () => {
    const target = connection('mx-guest-tuple');
    const replacement = connection('mx-guest-tuple');
    const current = new File(['current'], 'current.mp3');
    installPeers(target.peer);
    publishTracks(current, new File(['next'], 'next.mp3'));
    let sourceCurrent = true;
    let releaseGuard!: (allowed: boolean) => void;
    vi.spyOn(peerTransport, 'canSendFileTo').mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseGuard = resolve;
      }),
    );
    const main = unicastFile(target.conn, current, 0, 6, {
      queueItemId: CURRENT,
      isSourceCurrent: () => sourceCurrent,
    });

    expect(types(target.wire)).toEqual([]);
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(true);
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 5)).toBe(false);
    expect(isMainLanePreparingOrActive(target.conn, NEXT, 6)).toBe(false);
    expect(isMainLanePreparingOrActive(replacement.conn, CURRENT, 6)).toBe(false);
    // A preparing unicast whose source was superseded will not stream.
    sourceCurrent = false;
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(false);
    sourceCurrent = true;

    releaseGuard(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(types(target.wire)).toEqual([MSG.FILE_START]);
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(true);
    expect(isMainLanePreparingOrActive(replacement.conn, CURRENT, 6)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await main;
    expect(types(target.wire)).toEqual([MSG.FILE_START, MSG.FILE_CHUNK, MSG.FILE_END]);
    // A completed owner stays registered as a fence, but it no longer streams.
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(false);
  });

  it('answers for each receiver of a room broadcast until that receiver completes', async () => {
    const fast = connection('mx-guest-fast');
    const slow = connection('mx-guest-slow', 1024 * 1024);
    const current = new File(['current'], 'current.mp3');
    installPeers(fast.peer, slow.peer);
    publishTracks(current, new File(['next'], 'next.mp3'));
    const sending = broadcastFile(current, CURRENT, 6);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(fast.wire)).toEqual([MSG.FILE_START, MSG.FILE_CHUNK, MSG.FILE_END]);
    expect(types(slow.wire)).toEqual([MSG.FILE_START]);
    expect(isMainLanePreparingOrActive(fast.conn, CURRENT, 6)).toBe(false);
    expect(isMainLanePreparingOrActive(slow.conn, CURRENT, 6)).toBe(true);
    expect(isMainLanePreparingOrActive(slow.conn, CURRENT, 7)).toBe(false);

    slow.channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;
    expect(types(slow.wire)).toEqual([MSG.FILE_START, MSG.FILE_CHUNK, MSG.FILE_END]);
    expect(isMainLanePreparingOrActive(slow.conn, CURRENT, 6)).toBe(false);
  });

  it('stops answering for a superseded broadcast before its loop unwinds', async () => {
    const target = connection('mx-guest-superseded', 1024 * 1024);
    const current = new File(['current'], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    installPeers(target.peer);
    publishTracks(current, next);
    const first = broadcastFile(current, CURRENT, 6);
    await vi.advanceTimersByTimeAsync(100);
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(true);

    // The successor takes no direct receiver, so the parked owner is not
    // replaced: its scope is aborted while its loop waits for the next poll.
    installPeers({ ...target.peer, connectionType: 'remote' });
    setState('playlist.currentQueueItemId', NEXT);
    setState('files.current', resident(next, NEXT, 8));
    const second = broadcastFile(next, NEXT, 8);
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(types(target.wire)).toEqual([MSG.FILE_START]);
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(false);
  });

  it('stops answering once the outgoing transfers are cancelled', async () => {
    const target = connection('mx-guest-cancel', 1024 * 1024);
    const current = new File(['current'], 'current.mp3');
    installPeers(target.peer);
    publishTracks(current, new File(['next'], 'next.mp3'));
    const main = unicastFile(target.conn, current, 0, 6, { queueItemId: CURRENT });
    await vi.advanceTimersByTimeAsync(200);
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(true);

    cancelOutgoingFileTransfers();
    expect(isMainLanePreparingOrActive(target.conn, CURRENT, 6)).toBe(false);
    target.channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    await main;
    expect(types(target.wire)).toEqual([MSG.FILE_START]);
  });
});
