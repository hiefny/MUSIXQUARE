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
