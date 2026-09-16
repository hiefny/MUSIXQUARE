/** @vitest-environment jsdom */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { initPlaylist } from '../../player/playlist.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../../storage/preload.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';

const QY = '00000000-0000-4000-8000-000000000003';
const QA = '00000000-0000-4000-8000-000000000004';
const QB = '00000000-0000-4000-8000-000000000005';

function fileTrack(queueItemId: string, name: string): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name,
    title: name,
    file: new File([new Uint8Array(CHUNK_SIZE + 16)], name, { type: 'audio/mpeg' }),
    videoId: null,
    playlistId: null,
  };
}
function currentTrack(type: 'youtube' | 'file'): PlaylistItem {
  if (type === 'file') return fileTrack(QY, 'current.mp3');
  return {
    queueItemId: QY,
    type: 'youtube',
    name: 'current YT',
    title: 'current YT',
    videoId: 'abcdefghijk',
    playlistId: null,
  };
}
function connect(bufferedAmount = 0): DataConnection {
  const conn = {
    open: true,
    peer: 'reorder-guest',
    send: vi.fn(),
    dataChannel: { readyState: 'open', bufferedAmount },
  } as unknown as DataConnection;
  const peer: ConnectedPeer = {
    id: conn.peer,
    slot: 1,
    label: conn.peer,
    conn,
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
  return conn;
}
function messages(conn: DataConnection, type: string) {
  return (conn.send as ReturnType<typeof vi.fn>).mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((msg) => msg.type === type);
}
function reorder(queueItemId: string, beforeQueueItemId: string | null) {
  bus.emit('playlist:reorder-track', queueItemId, beforeQueueItemId, getState('playlist.revision'));
}
async function ack(
  conn: DataConnection,
  queueItemId: string,
  sessionId = getState('preload.sessionId'),
) {
  await handleData({ type: MSG.PRELOAD_ACK, queueItemId, sessionId }, conn);
}
function stageResident(item: PlaylistItem, sessionId: number): void {
  const file = item.file!;
  const resident = {
    queueItemId: item.queueItemId,
    sessionId,
    indexHint: getState('playlist.items').indexOf(item),
    name: file.name,
    size: file.size,
    mime: file.type,
    blob: file,
  };
  setState('preload.sessionId', sessionId);
  setState('preload.nextQueueItemId', item.queueItemId);
  setState('preload.activeTarget', resident);
  setState('preload.ready', resident);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  resetFileDeliveryPolicies();
  bus.clear();
  resetPreloadReceiveAuthority();
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  setState('network.sessionCode', '123456');
  setState('playback.mode', 'youtube');
  setState('playback.activity', 'playing');
  setState('playlist.isShuffle', false);
  setState('playlist.repeatMode', 0);
  initPreload();
  initPlaylist();
});
afterEach(async () => {
  cancelPreloadTransfer();
  await vi.advanceTimersByTimeAsync(100);
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('preload residency across real host reorders', () => {
  it.each(['youtube', 'file'] as const)(
    'resends A after B replaces it while current is %s',
    async (currentType) => {
      setState('playback.mode', currentType);
      const current = currentTrack(currentType);
      const a = fileTrack(QA, 'A.mp3');
      const b = fileTrack(QB, 'B.mp3');
      setState('playlist.items', [current, a, b]);
      setState('playlist.currentQueueItemId', current.queueItemId);
      const conn = connect();
      const cacheAtStart: string[][] = [];
      vi.mocked(conn.send).mockImplementation((message) => {
        if ((message as { type?: unknown }).type === MSG.PRELOAD_START) {
          cacheAtStart.push([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]);
        }
      });
      schedulePreload(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(messages(conn, MSG.PRELOAD_START)).toEqual([
        expect.objectContaining({ queueItemId: QA, skipped: false }),
      ]);
      expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(1);
      await ack(conn, QA);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QA]);
      const firstSessionId = getState('preload.sessionId');

      reorder(QB, QA);
      await vi.advanceTimersByTimeAsync(600);
      expect(messages(conn, MSG.PRELOAD_START)[1]).toMatchObject({
        queueItemId: QB,
        skipped: false,
      });
      expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(2);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);
      await ack(conn, QA, firstSessionId);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);
      await ack(conn, QB);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QB]);

      reorder(QA, QB);
      await vi.advanceTimersByTimeAsync(600);
      const thirdStart = messages(conn, MSG.PRELOAD_START)[2]!;
      expect(thirdStart).toMatchObject({ queueItemId: QA, skipped: false });
      expect(
        messages(conn, MSG.PRELOAD_CHUNK).filter((msg) => msg.sessionId === thirdStart.sessionId),
      ).toHaveLength(2);
      expect(messages(conn, MSG.PRELOAD_END)[2]).toMatchObject({
        queueItemId: QA,
        sessionId: thirdStart.sessionId,
      });
      expect(cacheAtStart).toEqual([[], [], []]);
      await ack(conn, QA, firstSessionId);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);
      await ack(conn, QA);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QA]);
      expect(getState('preload.ready')?.queueItemId).toBe(QA);
      expect(getState('preload.isPreloading')).toBe(false);
      expect(getState('playlist.currentQueueItemId')).toBe(QY);
      // A is now legitimately resident again; retain its completed transfer.
      schedulePreload(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(3);
    },
  );

  it('coalesces drags within 500ms and preserves an actually resident A', async () => {
    setState('playlist.items', [
      currentTrack('youtube'),
      fileTrack(QA, 'A.mp3'),
      fileTrack(QB, 'B.mp3'),
    ]);
    setState('playlist.currentQueueItemId', QY);
    const conn = connect();
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    await ack(conn, QA);
    for (let i = 0; i < 6; i++) {
      reorder(QB, QA);
      await vi.advanceTimersByTimeAsync(100);
      reorder(QA, QB);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(600);
    expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(1);
    expect(getState('preload.ready')?.queueItemId).toBe(QA);
  });

  it('preserves a peer resident when another session skips the same target', async () => {
    setState('playlist.items', [currentTrack('youtube'), fileTrack(QA, 'A.mp3')]);
    setState('playlist.currentQueueItemId', QY);
    const conn = connect();
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    await ack(conn, QA);
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('preload.nextQueueItemId', null);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(messages(conn, MSG.PRELOAD_START)[1]).toMatchObject({ queueItemId: QA, skipped: true });
    expect(messages(conn, MSG.PRELOAD_CHUNK)).toHaveLength(2);
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(2);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QA]);
  });

  it('finishes a pending A and converges to the last reordered B after serialization', async () => {
    setState('playlist.items', [
      currentTrack('youtube'),
      fileTrack(QA, 'A.mp3'),
      fileTrack(QB, 'B.mp3'),
    ]);
    setState('playlist.currentQueueItemId', QY);
    const conn = connect(10 * 1024 * 1024);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 3; i++) {
      reorder(QB, QA);
      await vi.advanceTimersByTimeAsync(600);
      reorder(QA, QB);
      await vi.advanceTimersByTimeAsync(600);
    }
    reorder(QB, QA);
    await vi.advanceTimersByTimeAsync(600);
    expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(1);
    (conn.dataChannel as unknown as { bufferedAmount: number }).bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages(conn, MSG.PRELOAD_START).map((m) => m.queueItemId)).toEqual([QA, QB]);
    expect(messages(conn, MSG.PRELOAD_START).map((m) => m.skipped)).toEqual([false, false]);
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(2);
    expect(getState('preload.ready')?.queueItemId).toBe(QB);
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('resends A even when replacement B was aborted before completing or ACKing', async () => {
    setState('playlist.items', [
      currentTrack('youtube'),
      fileTrack(QA, 'A.mp3'),
      fileTrack(QB, 'B.mp3'),
    ]);
    setState('playlist.currentQueueItemId', QY);
    const conn = connect();
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    await ack(conn, QA);
    (conn.dataChannel as unknown as { bufferedAmount: number }).bufferedAmount = 10 * 1024 * 1024;

    reorder(QB, QA);
    await vi.advanceTimersByTimeAsync(600);
    const secondStart = messages(conn, MSG.PRELOAD_START)[1]!;
    expect(secondStart).toMatchObject({ queueItemId: QB, skipped: false });
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(1);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);

    reorder(QA, QB);
    await vi.advanceTimersByTimeAsync(600);
    expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(2);
    // B's preexisting stream must settle before the queued successor A starts.
    // B's 30s pressure timeout must not restore its evicted predecessor A.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(messages(conn, MSG.PRELOAD_ABORT)).toEqual([
      expect.objectContaining({ queueItemId: QB, sessionId: secondStart.sessionId }),
    ]);
    expect(messages(conn, MSG.PRELOAD_START)[2]).toMatchObject({ queueItemId: QA, skipped: false });
    (conn.dataChannel as unknown as { bufferedAmount: number }).bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages(conn, MSG.PRELOAD_END)[1]).toMatchObject({ queueItemId: QA });
    expect(
      messages(conn, MSG.PRELOAD_CHUNK).filter(
        (msg) => msg.sessionId !== messages(conn, MSG.PRELOAD_START)[0]!.sessionId,
      ),
    ).toHaveLength(2);
    expect(getState('preload.ready')?.queueItemId).toBe(QA);
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it.each(['before-final-debounce', 'after-final-debounce'] as const)(
    'A keeps its original stream when B waits then latest target returns to A (%s)',
    async (drainTiming) => {
      setState('playlist.items', [
        currentTrack('youtube'),
        fileTrack(QA, 'A.mp3'),
        fileTrack(QB, 'B.mp3'),
      ]);
      setState('playlist.currentQueueItemId', QY);
      const conn = connect(10 * 1024 * 1024);
      schedulePreload(0);
      await vi.advanceTimersByTimeAsync(100);
      const originalSid = getState('preload.sessionId');
      // Host ready already contains its local source even before guest bytes.
      expect(getState('preload.ready')?.queueItemId).toBe(QA);
      expect(messages(conn, MSG.PRELOAD_CHUNK)).toHaveLength(0);
      expect(getState('preload.isPreloading')).toBe(true);

      reorder(QB, QA);
      await vi.advanceTimersByTimeAsync(600);
      // B's real scheduled callback is now awaiting A's transfer promise.
      expect(messages(conn, MSG.PRELOAD_START).map((m) => m.queueItemId)).toEqual([QA]);
      reorder(QA, QB);
      if (drainTiming === 'after-final-debounce') {
        await vi.advanceTimersByTimeAsync(600);
        // Final A's ready fast path has returned, but original A still owns
        // its transfer and remains streaming. It was never cancelled.
        expect(getState('preload.isPreloading')).toBe(true);
        expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(0);
      }
      (conn.dataChannel as unknown as { bufferedAmount: number }).bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(messages(conn, MSG.PRELOAD_START)).toEqual([
        expect.objectContaining({ queueItemId: QA, sessionId: originalSid, skipped: false }),
      ]);
      expect(messages(conn, MSG.PRELOAD_CHUNK).map((m) => m.chunkIndex)).toEqual([0, 1]);
      expect(messages(conn, MSG.PRELOAD_END)).toEqual([
        expect.objectContaining({ queueItemId: QA, sessionId: originalSid }),
      ]);
      expect(messages(conn, MSG.PRELOAD_ABORT)).toHaveLength(0);
      expect(getState('preload.ready')?.queueItemId).toBe(QA);
      expect(getState('preload.isPreloading')).toBe(false);
      expect(getState('playlist.currentQueueItemId')).toBe(QY);
      await ack(conn, QA);
      expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QA]);
    },
  );

  it('invalidates the prior peer resident before a unicast replacement START', async () => {
    const a = fileTrack(QA, 'A.mp3');
    const b = fileTrack(QB, 'B.mp3');
    setState('playlist.items', [currentTrack('youtube'), a, b]);
    setState('playlist.currentQueueItemId', QY);
    const conn = connect();
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    await ack(conn, QA);
    const oldSessionId = getState('preload.sessionId');
    const nextSessionId = oldSessionId + 1;
    stageResident(b, nextSessionId);
    const cacheAtStart: string[][] = [];
    vi.mocked(conn.send)
      .mockClear()
      .mockImplementation((message) => {
        if ((message as { type?: unknown }).type === MSG.PRELOAD_START) {
          cacheAtStart.push([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]);
        }
      });

    await unicastPreload(conn, b.file!, QB, nextSessionId);

    expect(cacheAtStart).toEqual([[]]);
    expect(messages(conn, MSG.PRELOAD_START)).toEqual([
      expect.objectContaining({ queueItemId: QB, sessionId: nextSessionId, skipped: false }),
    ]);
    expect(messages(conn, MSG.PRELOAD_CHUNK)).toHaveLength(2);
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(1);
    await ack(conn, QA, oldSessionId);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);
    await ack(conn, QB, nextSessionId);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QB]);
  });

  it('does not let a superseded unicast or ACK erase its replacement connection residency', async () => {
    const a = fileTrack(QA, 'A.mp3');
    const b = fileTrack(QB, 'B.mp3');
    setState('playlist.items', [currentTrack('youtube'), a, b]);
    setState('playlist.currentQueueItemId', QY);
    const oldConn = connect();
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
    await ack(oldConn, QA);
    const nextSessionId = getState('preload.sessionId') + 1;
    stageResident(b, nextSessionId);
    vi.mocked(oldConn.send).mockClear();

    const staleUnicast = unicastPreload(oldConn, b.file!, QB, nextSessionId);
    // The transport guard yields once. Replace the exact connection while
    // preserving the peer ID; old callbacks must leave this peer untouched.
    const replacement = { ...oldConn, send: vi.fn() } as DataConnection;
    const oldPeer = getState('network.connectedPeers')[0]!;
    setState('network.connectedPeers', [{ ...oldPeer, conn: replacement }]);
    setState('network.activeHostConnByPeerId', new Map([[replacement.peer, replacement]]));
    await staleUnicast;
    await ack(oldConn, QB, nextSessionId);

    expect(oldConn.send).not.toHaveBeenCalled();
    expect(replacement.send).not.toHaveBeenCalled();
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QA]);

    await unicastPreload(replacement, b.file!, QB, nextSessionId);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);
    expect(messages(replacement, MSG.PRELOAD_START)).toHaveLength(1);
    await ack(replacement, QB, nextSessionId);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([QB]);
  });
});
