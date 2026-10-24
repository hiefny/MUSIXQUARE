/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initPlayback } from '../../player/playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
} from '../preload.ts';
import { resetAllStoredFiles } from '../storage.ts';
import { cancelOutgoingFileTransfers } from '../transfer-send.ts';

/**
 * Device evidence freeze. The Phase 4 preload-resume criteria read these two
 * host lines from /debug console (`?mxqrLog=info`) and match the guest's
 * PeerID in them, so their exact text, peer placement, argument count and log
 * level must not change. They are driven through the real suspend/resume path.
 */
const GUEST = 'mx-T1evidenceGst';
const PAUSED = `[Preload] Paused preload for ${GUEST} while its connection is interrupted`;
const RESUMING = `[Preload] Resuming preload for ${GUEST} after its connection recovered`;

const CURRENT = '20000000-0000-4000-8000-000000000001';
const NEXT = '20000000-0000-4000-8000-000000000002';
type Level = 'debug' | 'info' | 'warn' | 'error';
let lines: Array<[Level, ...unknown[]]> = [];

function item(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

/** Starts blocked behind buffered bytes on a live ICE route. */
function interruptibleGuest() {
  const wire: Array<Record<string, unknown>> = [];
  const channel = { readyState: 'open', bufferedAmount: 1024 * 1024 };
  const pc: { connectionState: RTCPeerConnectionState; iceConnectionState: RTCIceConnectionState } =
    { connectionState: 'connected', iceConnectionState: 'connected' };
  const conn = {
    open: true,
    peer: GUEST,
    dataChannel: channel,
    peerConnection: pc,
    reportsIceRecovery: true,
    send: vi.fn((message: unknown) => wire.push(message as Record<string, unknown>)),
  } as unknown as DataConnection;
  const peer: ConnectedPeer = {
    id: GUEST,
    conn,
    slot: 1,
    label: GUEST,
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
    wire,
    interrupt(): void {
      pc.connectionState = 'disconnected';
      pc.iceConnectionState = 'disconnected';
    },
    recover(): void {
      channel.bufferedAmount = 0;
      pc.connectionState = 'connected';
      pc.iceConnectionState = 'connected';
    },
  };
}

function publishNextPreload(file: File): void {
  setState('playlist.items', [item(CURRENT, new File(['old'], 'current.mp3')), item(NEXT, file)]);
  setState('playlist.currentQueueItemId', CURRENT);
  setState('preload.nextQueueItemId', NEXT);
  setState('preload.activeTarget', {
    queueItemId: NEXT,
    sessionId: 7,
    indexHint: 1,
    name: file.name,
    mime: file.type,
    size: file.size,
    total: Math.ceil(file.size / CHUNK_SIZE),
  });
  setState('preload.ready', null);
}

/** Every logged line about a paused or resumed preload, at whatever level. */
function evidence(): Array<[Level, ...unknown[]]> {
  return lines.filter(
    ([, first]) => typeof first === 'string' && /(?:Paused|Resuming) preload for/u.test(first),
  );
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
  lines = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      lines.push([level, ...args]);
    });
  }
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

describe('preload resume device evidence lines', () => {
  it('logs the paused and resuming lines at info with the exact guest peer id', async () => {
    const guest = interruptibleGuest();
    setState('network.connectedPeers', [guest.peer]);
    setState('network.activeHostConnByPeerId', new Map([[GUEST, guest.conn]]));
    publishNextPreload(new File(['next'], 'next.mp3', { type: 'audio/mpeg' }));

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(guest.wire.map((frame) => frame.type)).toEqual([MSG.PRELOAD_START]);
    expect(evidence()).toEqual([]);

    guest.interrupt();
    await vi.advanceTimersByTimeAsync(100);
    expect(evidence()).toEqual([['info', PAUSED]]);

    guest.recover();
    bus.emit('network:peer-ice-recovered', guest.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(evidence()).toEqual([
      ['info', PAUSED],
      ['info', RESUMING],
    ]);
    // The resume restarts the same tuple from chunk 0 on the same session.
    const starts = guest.wire.filter((frame) => frame.type === MSG.PRELOAD_START);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ restart: true, sessionId: starts[0]!.sessionId });
    expect(guest.wire.at(-1)?.type).toBe(MSG.PRELOAD_END);
  });

  it('logs no resuming line while the recovered connection still reports an interruption', async () => {
    const guest = interruptibleGuest();
    setState('network.connectedPeers', [guest.peer]);
    setState('network.activeHostConnByPeerId', new Map([[GUEST, guest.conn]]));
    publishNextPreload(new File(['next'], 'next.mp3', { type: 'audio/mpeg' }));

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    guest.interrupt();
    await vi.advanceTimersByTimeAsync(100);
    // A selected-pair change can report recovery before the route is writable.
    bus.emit('network:peer-ice-recovered', guest.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(evidence()).toEqual([['info', PAUSED]]);

    guest.recover();
    bus.emit('network:peer-ice-recovered', guest.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(evidence()).toEqual([
      ['info', PAUSED],
      ['info', RESUMING],
    ]);
  });
});
