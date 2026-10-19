/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, registerHandlers, resetInboundRateLimit } from '../../network/protocol.ts';
import * as peerTransport from '../../network/peer.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { initPlayback } from '../../player/playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  isActiveHostPreloadChunkForRateLimitForTests,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../preload.ts';
import { initRecovery } from '../recovery.ts';
import { resetAllStoredFiles } from '../storage.ts';
import { cancelOutgoingFileTransfers } from '../transfer-send.ts';

const CURRENT = '20000000-0000-4000-8000-000000000001';
const NEXT = '20000000-0000-4000-8000-000000000002';
const FUTURE = '20000000-0000-4000-8000-000000000003';

function item(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

function connection(id: string, bufferedAmount = 0) {
  const wire: Array<Record<string, unknown>> = [];
  const channel = { readyState: 'open', bufferedAmount };
  const conn = {
    open: true,
    peer: id,
    dataChannel: channel,
    send: vi.fn((message: unknown) => wire.push(message as Record<string, unknown>)),
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

/** Starts blocked behind buffered bytes on a live ICE route. */
function interruptibleConnection(id: string, reportsIceRecovery = true) {
  const target = connection(id, 1024 * 1024);
  const pc: { connectionState: RTCPeerConnectionState; iceConnectionState: RTCIceConnectionState } =
    { connectionState: 'connected', iceConnectionState: 'connected' };
  Object.assign(target.conn, { peerConnection: pc, reportsIceRecovery });
  const interrupt = (): void => {
    pc.connectionState = 'disconnected';
    pc.iceConnectionState = 'disconnected';
  };
  const recover = (): void => {
    target.channel.bufferedAmount = 0;
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
  };
  return { ...target, pc, interrupt, recover };
}

function installPeers(...peers: ConnectedPeer[]): void {
  setState('network.connectedPeers', peers);
  setState('network.activeHostConnByPeerId', new Map(peers.map((peer) => [peer.id, peer.conn!])));
}

function publishPreload(file: File, sessionId = 7): void {
  setState('playlist.items', [item(CURRENT, new File(['old'], 'current.mp3')), item(NEXT, file)]);
  setState('playlist.currentQueueItemId', CURRENT);
  const meta = {
    queueItemId: NEXT,
    sessionId,
    indexHint: 1,
    name: file.name,
    mime: file.type,
    size: file.size,
    total: Math.ceil(file.size / CHUNK_SIZE),
  };
  setState('preload.nextQueueItemId', NEXT);
  setState('preload.activeTarget', meta);
  setState('preload.ready', { ...meta, blob: file });
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
  cancelOutgoingFileTransfers();
  await vi.advanceTimersByTimeAsync(100);
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('preload peer ownership', () => {
  it.each(['started', 'guard-pending'] as const)(
    'keeps promoted current and future unicasts owned separately, sending current first when %s',
    async (currentLane) => {
      const target = connection('current-and-future', 1024 * 1024);
      const file = new File(['current'], 'current.mp3', { type: 'audio/mpeg' });
      const futureFile = new File(['future'], 'future.mp3', { type: 'audio/mpeg' });
      installPeers(target.peer);
      publishPreload(file);
      let releaseGuard: ((allowed: boolean) => void) | undefined;
      if (currentLane === 'guard-pending') {
        vi.spyOn(peerTransport, 'canSendFileTo').mockReturnValueOnce(
          new Promise<boolean>((resolve) => {
            releaseGuard = resolve;
          }),
        );
      }
      const currentSend = unicastPreload(target.conn, file, NEXT, 7);
      await vi.advanceTimersByTimeAsync(0);
      setState('files.current', getState('preload.ready'));
      setState('playlist.currentQueueItemId', NEXT);
      setState('playlist.items', [...getState('playlist.items'), item(FUTURE, futureFile)]);
      const futureMeta = {
        queueItemId: FUTURE,
        sessionId: 8,
        indexHint: 2,
        name: futureFile.name,
        mime: futureFile.type,
        size: futureFile.size,
        total: 1,
      };
      setState('preload.nextQueueItemId', FUTURE);
      setState('preload.activeTarget', futureMeta);
      setState('preload.ready', { ...futureMeta, blob: futureFile });
      const futureSend = unicastPreload(target.conn, futureFile, FUTURE, 8);
      await vi.advanceTimersByTimeAsync(0);
      releaseGuard?.(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        target.wire
          .filter((frame) => frame.type === MSG.PRELOAD_START)
          .map((frame) => frame.queueItemId),
      ).toEqual([NEXT]);
      target.channel.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([currentSend, futureSend]);
      expect(
        target.wire.findIndex(
          (frame) => frame.type === MSG.PRELOAD_END && frame.queueItemId === NEXT,
        ),
      ).toBeLessThan(
        target.wire.findIndex(
          (frame) => frame.type === MSG.PRELOAD_START && frame.queueItemId === FUTURE,
        ),
      );
      for (const queueItemId of [NEXT, FUTURE]) {
        expect(
          target.wire.filter(
            (frame) => frame.type === MSG.PRELOAD_END && frame.queueItemId === queueItemId,
          ),
        ).toHaveLength(1);
      }
      const completed = [...target.wire];
      await unicastPreload(target.conn, file, NEXT, 7);
      await unicastPreload(target.conn, futureFile, FUTURE, 8);
      expect(target.wire).toEqual(completed);
    },
  );

  it.each([MSG.PRELOAD_START, MSG.PRELOAD_CHUNK, MSG.PRELOAD_END])(
    'retries an incomplete unicast after sending %s fails',
    async (failedType) => {
      const target = connection('failed-unicast');
      const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
      let failed = false;
      vi.mocked(target.conn.send).mockImplementation((message) => {
        const frame = message as Record<string, unknown>;
        if (!failed && frame.type === failedType) {
          failed = true;
          throw new Error('send failed');
        }
        target.wire.push(frame);
      });
      installPeers(target.peer);
      publishPreload(file);
      await unicastPreload(target.conn, file, NEXT, 7);
      expect(failed).toBe(true);
      expect(target.wire.some((frame) => frame.type === MSG.PRELOAD_END)).toBe(false);
      const failedLength = target.wire.length;
      await unicastPreload(target.conn, file, NEXT, 7);
      expect(target.wire.slice(failedLength).map((frame) => frame.type)).toEqual([
        MSG.PRELOAD_START,
        MSG.PRELOAD_CHUNK,
        MSG.PRELOAD_END,
      ]);
    },
  );

  it.each([MSG.PRELOAD_START, MSG.PRELOAD_CHUNK, MSG.PRELOAD_END])(
    'retries a failed broadcast %s without replaying a completed sibling',
    async (failedType) => {
      const target = connection('failed-broadcast');
      const healthy = connection('healthy-broadcast');
      const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
      let failed = false;
      vi.mocked(target.conn.send).mockImplementation((message) => {
        const frame = message as Record<string, unknown>;
        if (!failed && frame.type === failedType) {
          failed = true;
          throw new Error('send failed');
        }
        target.wire.push(frame);
      });
      installPeers(target.peer, healthy.peer);
      publishPreload(file);
      setState('preload.ready', null);
      schedulePreload(0);
      await vi.advanceTimersByTimeAsync(100);
      const ready = getState('preload.ready')!;
      expect(failed).toBe(true);
      expect(target.wire.some((frame) => frame.type === MSG.PRELOAD_END)).toBe(false);
      expect(healthy.wire.at(-1)?.type).toBe(MSG.PRELOAD_END);
      const failedLength = target.wire.length;
      const healthyFrames = [...healthy.wire];
      await unicastPreload(target.conn, file, NEXT, ready.sessionId);
      await unicastPreload(healthy.conn, file, NEXT, ready.sessionId);
      expect(target.wire.slice(failedLength).map((frame) => frame.type)).toEqual([
        MSG.PRELOAD_START,
        MSG.PRELOAD_CHUNK,
        MSG.PRELOAD_END,
      ]);
      expect(healthy.wire).toEqual(healthyFrames);
    },
  );

  it('allows explicit recovery when a completed preload was never acknowledged or retained', async () => {
    const target = connection('missing-preload');
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(target.peer);
    publishPreload(file);
    await unicastPreload(target.conn, file, NEXT, 7);
    expect(target.peer.preloadedQueueItemIds?.has(NEXT)).toBe(false);
    const sentPreload = [...target.wire];
    expect(sentPreload.at(-1)?.type).toBe(MSG.PRELOAD_END);

    // No ACK promises residency. When this occurrence becomes current, a
    // guest which skipped, evicted, or failed to assemble it asks for recovery.
    setState('network.appRole', 'host');
    setState('playlist.currentQueueItemId', NEXT);
    setState('files.current', getState('preload.ready'));
    setState('preload.ready', null);
    initRecovery();
    const recovery = handleData(
      {
        type: MSG.REQUEST_DATA_RECOVERY,
        requestId: 1,
        queueItemId: NEXT,
        sessionId: 7,
        nextChunk: 0,
        fileName: file.name,
      },
      target.conn,
    );
    await vi.advanceTimersByTimeAsync(150);
    await recovery;
    expect(target.wire.slice(sentPreload.length).map((frame) => frame.type)).toEqual([
      MSG.FILE_START,
      MSG.FILE_CHUNK,
      MSG.FILE_END,
    ]);
  });

  it('deduplicates concurrent and completed bootstrap calls without clearing the peer ACK', async () => {
    const target = connection('concurrent-bootstrap', 1024 * 1024);
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(target.peer);
    publishPreload(file);
    const first = unicastPreload(target.conn, file, NEXT, 7);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([
      unicastPreload(target.conn, file, NEXT, 7),
      unicastPreload(target.conn, file, NEXT, 7),
    ]);
    expect(target.wire.map((frame) => frame.type)).toEqual([MSG.PRELOAD_START]);
    target.channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await first;
    const acknowledged = {
      ...getState('network.connectedPeers')[0]!,
      preloadedQueueItemIds: new Set([NEXT]),
    };
    installPeers(acknowledged);
    await unicastPreload(target.conn, file, NEXT, 7);
    expect(target.wire.map((frame) => frame.type)).toEqual([
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
    expect(getState('network.connectedPeers')[0]?.preloadedQueueItemIds).toBe(
      acknowledged.preloadedQueueItemIds,
    );
  });

  it('keeps a completed broadcast peer fenced while a sibling is still blocked', async () => {
    const healthy = connection('healthy');
    const slow = connection('slow', 1024 * 1024);
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(healthy.peer, slow.peer);
    publishPreload(file);
    setState('preload.ready', null);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    const ready = getState('preload.ready')!;
    expect(healthy.wire.at(-1)?.type).toBe(MSG.PRELOAD_END);
    expect(slow.wire.map((frame) => frame.type)).toEqual([MSG.PRELOAD_START]);
    await Promise.all([
      unicastPreload(healthy.conn, file, NEXT, ready.sessionId),
      unicastPreload(slow.conn, file, NEXT, ready.sessionId),
    ]);
    expect(healthy.wire.filter((frame) => frame.type === MSG.PRELOAD_START)).toHaveLength(1);
    expect(slow.wire.filter((frame) => frame.type === MSG.PRELOAD_START)).toHaveLength(1);
    slow.channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(slow.wire.at(-1)?.type).toBe(MSG.PRELOAD_END);
  });

  it('retains exact completion through reclassification but serves a replacement connection', async () => {
    const first = connection('same-peer');
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(first.peer);
    publishPreload(file);
    await unicastPreload(first.conn, file, NEXT, 7);
    installPeers({ ...first.peer, connectionType: 'remote' });
    await unicastPreload(first.conn, file, NEXT, 7);
    expect(first.wire.filter((frame) => frame.type === MSG.PRELOAD_START)).toHaveLength(1);

    const replacement = connection('same-peer');
    installPeers(replacement.peer);
    bus.emit('network:peer-connection-replaced', replacement.peer.id);
    await unicastPreload(replacement.conn, file, NEXT, 7);
    expect(replacement.wire.map((frame) => frame.type)).toEqual([
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
  });

  it('releases a canceled owner without letting its cleanup detach a retry', async () => {
    const target = connection('retry', 1024 * 1024);
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(target.peer);
    publishPreload(file);
    const canceled = unicastPreload(target.conn, file, NEXT, 7);
    await vi.advanceTimersByTimeAsync(0);
    cancelPreloadTransfer();
    target.channel.bufferedAmount = 0;
    await unicastPreload(target.conn, file, NEXT, 7);
    await vi.advanceTimersByTimeAsync(50);
    await canceled;
    await unicastPreload(target.conn, file, NEXT, 7);
    expect(target.wire.filter((frame) => frame.type === MSG.PRELOAD_START)).toHaveLength(2);
    expect(target.wire.filter((frame) => frame.type === MSG.PRELOAD_ABORT)).toHaveLength(1);
    expect(target.wire.filter((frame) => frame.type === MSG.PRELOAD_END)).toHaveLength(1);
  });
});

describe('preload lanes interrupted by ICE', () => {
  const types = (wire: Array<Record<string, unknown>>) => wire.map((frame) => frame.type);

  /** One healthy receiver completes while the other loses its route mid-stream. */
  async function interruptBroadcast() {
    const healthy = connection('healthy-listener');
    const flaky = interruptibleConnection('interrupted-listener');
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(healthy.peer, flaky.peer);
    publishPreload(file);
    setState('preload.ready', null);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    const ready = getState('preload.ready')!;
    expect(healthy.wire.at(-1)?.type).toBe(MSG.PRELOAD_END);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START]);
    flaky.interrupt();
    await vi.advanceTimersByTimeAsync(500);
    return { healthy, flaky, file, ready };
  }

  it('resumes the receiver after recovery instead of aborting its partial session', async () => {
    const { flaky, ready } = await interruptBroadcast();
    // An abort sent now would arrive after recovery and could discard the resend.
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START]);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([
      MSG.PRELOAD_START,
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
    for (const frame of flaky.wire) {
      expect(frame).toMatchObject({ queueItemId: NEXT, sessionId: ready.sessionId });
    }
    expect(flaky.wire[0]).not.toHaveProperty('restart');
    expect(flaky.wire[1]).toMatchObject({ skipped: false, restart: true });

    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(flaky.wire).toHaveLength(4);
  });

  it('waits for the transition that makes an interrupted route writable', async () => {
    const { flaky } = await interruptBroadcast();
    // A selected-pair change can report recovery while the route is still down.
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START]);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire).at(-1)).toBe(MSG.PRELOAD_END);
  });

  it('resumes the same tuple after the host promoted it to the current file', async () => {
    const { flaky, ready } = await interruptBroadcast();
    setState('files.current', ready);
    setState('playlist.currentQueueItemId', NEXT);
    setState('preload.nextQueueItemId', null);
    setState('preload.activeTarget', null);
    setState('preload.ready', null);
    cancelPreloadTransfer(NEXT, true);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START]);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([
      MSG.PRELOAD_START,
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
  });

  it('sends the deferred abort when the paused preload is cancelled', async () => {
    const { flaky } = await interruptBroadcast();
    cancelPreloadTransfer();
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);
  });

  it('aborts instead of resuming when the paused tuple is no longer resident', async () => {
    const { flaky } = await interruptBroadcast();
    setState('preload.ready', null);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);
  });

  it('forgets a paused lane whose connection was replaced', async () => {
    const { flaky } = await interruptBroadcast();
    bus.emit('network:peer-connection-replaced', flaky.peer.id);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START]);
  });

  describe('as the receiving guest', () => {
    const SID = 41;
    const start = {
      type: MSG.PRELOAD_START,
      name: 'next.mp3',
      mime: 'audio/mpeg',
      total: 3,
      size: CHUNK_SIZE * 3,
      queueItemId: NEXT,
      sessionId: SID,
      skipped: false,
    };
    const chunk = (chunkIndex: number) => ({
      type: MSG.PRELOAD_CHUNK,
      chunk: new Uint8Array(CHUNK_SIZE).fill(chunkIndex + 1),
      chunkIndex,
      queueItemId: NEXT,
      sessionId: SID,
    });
    const end = { type: MSG.PRELOAD_END, name: 'next.mp3', queueItemId: NEXT, sessionId: SID };

    function becomeGuest() {
      const host = connection('restarting-host');
      setState('playlist.items', [
        item(CURRENT, new File(['old'], 'current.mp3')),
        item(NEXT, new File(['next'], 'next.mp3')),
      ]);
      setState('playlist.currentQueueItemId', CURRENT);
      setState('network.appRole', 'guest');
      setState('network.hostConn', host.conn);
      setState('network.connectionType', 'local');
      markQueueAuthorityReady(host.conn);
      resetInboundRateLimit(host.conn.peer);
      return host;
    }

    it('restarts a live partial session so a slow resend cannot outlast its watchdog', async () => {
      const host = becomeGuest();
      for (const frame of [start, chunk(0), chunk(1)]) await handleData(frame, host.conn);
      expect(getState('preload.sessionState').get(SID)).toMatchObject({ progress: 2 });
      // An overlapping lane's START still keeps the prefix.
      await handleData(start, host.conn);
      expect(getState('preload.sessionState').get(SID)).toMatchObject({ progress: 2 });

      // Recovery resends from chunk 0, more slowly than the 15 s progress watchdog.
      await handleData({ ...start, restart: true }, host.conn);
      expect(getState('preload.sessionState').get(SID)).toMatchObject({
        progress: 0,
        skipped: false,
      });
      await handleData(chunk(0), host.conn);
      await vi.advanceTimersByTimeAsync(10_000);
      await handleData(chunk(1), host.conn);
      await vi.advanceTimersByTimeAsync(10_000);
      await handleData(chunk(2), host.conn);
      await handleData(end, host.conn);
      await vi.advanceTimersByTimeAsync(100);
      expect(getState('preload.sessionState').get(SID)).toMatchObject({
        progress: 3,
        finalized: true,
        skipped: false,
      });
    });

    it('keeps a finalized preload when a restart arrives', async () => {
      const host = becomeGuest();
      for (const frame of [start, chunk(0), chunk(1), chunk(2), end]) {
        await handleData(frame, host.conn);
      }
      await vi.advanceTimersByTimeAsync(100);
      const finalized = getState('preload.sessionState').get(SID);
      expect(finalized?.finalized).toBe(true);

      await handleData({ ...start, restart: true }, host.conn);
      expect(getState('preload.sessionState').get(SID)).toBe(finalized);
    });
  });

  it('aborts at once on a provider that never reports ICE recovery', async () => {
    const healthy = connection('healthy-listener');
    const flaky = interruptibleConnection('peerjs-listener', false);
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(healthy.peer, flaky.peer);
    publishPreload(file);
    setState('preload.ready', null);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    flaky.interrupt();
    await vi.advanceTimersByTimeAsync(500);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);

    flaky.recover();
    bus.emit('network:peer-ice-recovered', flaky.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(flaky.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);
  });

  it('still aborts a lane that stalls on a connected route', async () => {
    const healthy = connection('healthy-listener');
    const stalled = interruptibleConnection('stalled-listener');
    const file = new File(['next'], 'next.mp3', { type: 'audio/mpeg' });
    installPeers(healthy.peer, stalled.peer);
    publishPreload(file);
    setState('preload.ready', null);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(types(stalled.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);

    stalled.recover();
    bus.emit('network:peer-ice-recovered', stalled.conn);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(stalled.wire)).toEqual([MSG.PRELOAD_START, MSG.PRELOAD_ABORT]);
  });
});

describe('completed preload duplicate control isolation', () => {
  it.each([
    { chunks: 65, pace: 'five-ms' },
    { chunks: 256, pace: 'batch-fifty-ms' },
  ])(
    'keeps PAUSE deliverable during legacy duplicate chunks ($chunks / $pace)',
    async ({ chunks, pace }) => {
      const target = connection(`legacy-replay-${pace}`);
      const file = new File([new Uint8Array(CHUNK_SIZE * chunks)], 'next.mp3', {
        type: 'audio/mpeg',
      });
      installPeers(target.peer);
      publishPreload(file);
      setState('preload.ready', null);
      schedulePreload(0);
      await vi.advanceTimersByTimeAsync(500);
      const ready = getState('preload.ready')!;
      const frames = [...target.wire];
      expect(frames.filter((frame) => frame.type === MSG.PRELOAD_CHUNK)).toHaveLength(chunks);
      await unicastPreload(target.conn, file, NEXT, ready.sessionId);
      expect(target.wire).toEqual(frames);

      // Older hosts can still produce the duplicate stream. Replay the real
      // sender frames through protocol validation and the real RAM receiver.
      resetPreloadReceiveAuthority();
      setState('network.connectedPeers', []);
      setState('network.appRole', 'guest');
      setState('network.hostConn', target.conn);
      setState('network.connectionType', 'local');
      markQueueAuthorityReady(target.conn);
      resetInboundRateLimit(target.conn.peer);
      for (const frame of frames) await handleData(frame, target.conn);
      const resident = getState('preload.ready');
      expect(getState('preload.sessionState').get(ready.sessionId)?.finalized).toBe(true);
      const onPause = vi.fn();
      registerHandlers({ [MSG.PAUSE]: onPause });
      let replayedChunks = 0;
      for (const frame of frames) {
        await handleData(frame, target.conn);
        if (frame.type === MSG.PRELOAD_CHUNK) {
          replayedChunks++;
          if (pace === 'five-ms') await vi.advanceTimersByTimeAsync(5);
          if (pace === 'batch-fifty-ms' && replayedChunks % 5 === 0)
            await vi.advanceTimersByTimeAsync(50);
        }
      }
      await handleData(
        { type: MSG.PAUSE, time: 0, queueItemId: CURRENT, reason: 'pause' },
        target.conn,
      );
      expect(onPause).toHaveBeenCalledOnce();
      expect(getState('preload.ready')).toBe(resident);

      const validChunk = frames.find((frame) => frame.type === MSG.PRELOAD_CHUNK)!;
      const guard = isActiveHostPreloadChunkForRateLimitForTests;
      expect(guard(validChunk, target.conn)).toBe(true);
      for (const invalid of [
        { ...validChunk, sessionId: ready.sessionId + 1 },
        { ...validChunk, queueItemId: CURRENT },
        { ...validChunk, chunkIndex: chunks },
        { ...validChunk, chunk: new Uint8Array(1) },
        { ...validChunk, unexpected: true },
      ]) {
        expect(guard(invalid, target.conn)).toBe(false);
      }
      expect(guard(validChunk, connection(target.conn.peer).conn)).toBe(false);
    },
  );
});
