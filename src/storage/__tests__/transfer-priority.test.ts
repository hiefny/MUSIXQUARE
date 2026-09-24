/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG, TRANSFER_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
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
import { resetAllStoredFiles } from '../storage.ts';
import * as storage from '../storage.ts';
import { cancelIncomingFileTransfer, initTransfer } from '../transfer.ts';
import { armPreloadAdmissionWatchdog, recordMainReceiveProgress } from '../preload-watchdog.ts';
import {
  broadcastFile,
  broadcastFileDebounced,
  cancelOutgoingFileTransfers,
  hasPendingCurrentFileTransfer,
  unicastFile,
} from '../transfer-send.ts';

const CURRENT = '50000000-0000-4000-8000-000000000001';
const NEXT = '50000000-0000-4000-8000-000000000002';
const FUTURE = '50000000-0000-4000-8000-000000000003';
type Frame = Record<string, unknown>;

function item(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

function connection(id: string, bufferedAmount = 0) {
  const wire: Frame[] = [];
  const channel = Object.assign(new EventTarget(), {
    readyState: 'open',
    bufferedAmount,
    bufferedAmountLowThreshold: 0,
  });
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

function holdRead(file: File) {
  let resolve!: (bytes: ArrayBuffer) => void;
  const promise = new Promise<ArrayBuffer>((done) => {
    resolve = done;
  });
  const read = vi.spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => promise } as Blob);
  return { read, release: () => resolve(new ArrayBuffer(file.size)) };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetFileDeliveryPolicies();
  resetInboundRateLimit('host');
  initTransfer();
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

describe('current-file priority across real sender and preload lanes', () => {
  it('starts a completed fast peer preload without an ACK while another main peer remains blocked', async () => {
    const fast = connection('fast');
    const slow = connection('slow', 1024 * 1024);
    const current = new File(['current'], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    installPeers(fast.peer, slow.peer);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    publishCurrent(current);
    const main = broadcastFile(current, CURRENT, 6);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(fast.wire.map((frame) => frame.type)).toEqual([
      MSG.FILE_START,
      MSG.FILE_CHUNK,
      MSG.FILE_END,
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
    expect(fast.peer.preloadedQueueItemIds?.size).toBe(0);
    expect(hasPendingCurrentFileTransfer(fast.conn)).toBe(false);
    expect(hasPendingCurrentFileTransfer(slow.conn)).toBe(true);
    expect(slow.wire.map((frame) => frame.type)).toEqual([MSG.FILE_START]);
    slow.channel.bufferedAmount = 0;
    slow.channel.dispatchEvent(new Event('bufferedamountlow'));
    await vi.advanceTimersByTimeAsync(100);
    await main;
    expect(slow.wire.map((frame) => frame.type)).toEqual([
      MSG.FILE_START,
      MSG.FILE_CHUNK,
      MSG.FILE_END,
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
  });

  it('keeps preload START behind the current-file broadcast debounce', async () => {
    const target = connection('pending-broadcast');
    const current = new File(['current'], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    installPeers(target.peer);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    publishCurrent(current);
    broadcastFileDebounced(current, CURRENT, 6);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(target.wire).toEqual([]);
    expect(hasPendingCurrentFileTransfer(target.conn)).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(target.wire.map((frame) => frame.type)).toEqual([
      MSG.FILE_START,
      MSG.FILE_CHUNK,
      MSG.FILE_END,
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
  });

  it('parks an already-read preload chunk when a main owner arrives during its Blob read', async () => {
    const target = connection('post-read-owner');
    const current = new File(['main'], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    const heldMain = holdRead(current);
    const heldNext = holdRead(next);
    installPeers(target.peer);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    publishCurrent(current);
    publishPreload(next);
    const preload = unicastPreload(target.conn, next, NEXT, 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(heldNext.read).toHaveBeenCalledOnce();
    const main = unicastFile(target.conn, current, 0, 6, { queueItemId: CURRENT });
    await vi.advanceTimersByTimeAsync(100);
    expect(heldMain.read).toHaveBeenCalledOnce();
    heldNext.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(target.wire.some((frame) => frame.type === MSG.PRELOAD_CHUNK)).toBe(false);
    heldMain.release();
    await vi.advanceTimersByTimeAsync(150);
    await Promise.all([main, preload]);
    expect(target.wire.map((frame) => frame.type)).toEqual([
      MSG.PRELOAD_START,
      MSG.FILE_START,
      MSG.FILE_CHUNK,
      MSG.FILE_END,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
    expect(heldNext.read).toHaveBeenCalledOnce();
  });

  it.each(['unicast', 'broadcast'] as const)(
    'rechecks %s preload priority after a post-read capacity wait',
    async (lane) => {
      const target = connection('capacity-owner');
      const current = new File(['main'], 'current.mp3');
      const next = new File(['next'], 'next.mp3');
      const heldMain = holdRead(current);
      const heldNext = holdRead(next);
      installPeers(target.peer);
      setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
      publishCurrent(current);
      let preload: Promise<void> | undefined;
      if (lane === 'unicast') {
        publishPreload(next);
        preload = unicastPreload(target.conn, next, NEXT, 7);
      } else schedulePreload(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(heldNext.read).toHaveBeenCalledOnce();
      // The preload has already read its only chunk, but a full channel parks
      // it at the second capacity wait, after its last priority observation.
      target.channel.bufferedAmount = 1024 * 1024;
      heldNext.release();
      await vi.advanceTimersByTimeAsync(0);
      const main = unicastFile(target.conn, current, 0, 6, { queueItemId: CURRENT });
      await vi.advanceTimersByTimeAsync(100);
      target.channel.bufferedAmount = 0;
      target.channel.dispatchEvent(new Event('bufferedamountlow'));
      await vi.advanceTimersByTimeAsync(100);
      const prematureChunks = target.wire.filter((frame) => frame.type === MSG.PRELOAD_CHUNK);
      const mainWasStillPending = hasPendingCurrentFileTransfer(target.conn);
      heldMain.release();
      await vi.advanceTimersByTimeAsync(150);
      await main;
      await preload;
      expect(mainWasStillPending).toBe(true);
      expect(prematureChunks).toEqual([]);
      expect(target.wire.map((frame) => frame.type)).toEqual([
        MSG.PRELOAD_START,
        MSG.FILE_START,
        MSG.FILE_CHUNK,
        MSG.FILE_END,
        MSG.PRELOAD_CHUNK,
        MSG.PRELOAD_END,
      ]);
    },
  );

  it('does not spend the preload capacity timeout while main broadcast keeps its larger window busy', async () => {
    const target = connection('foreground-window');
    const current = new File([new Uint8Array(CHUNK_SIZE * 4)], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    const heldNext = holdRead(next);
    const mainReads: Array<() => void> = [];
    vi.spyOn(current, 'slice').mockImplementation(
      () =>
        ({
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              mainReads.push(() => resolve(new ArrayBuffer(CHUNK_SIZE)));
            }),
        }) as Blob,
    );
    installPeers(target.peer);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    publishCurrent(current);
    publishPreload(next);
    const preload = unicastPreload(target.conn, next, NEXT, 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(heldNext.read).toHaveBeenCalledOnce();
    // Foreground's 512 KiB window keeps making progress. The 256 KiB
    // speculative lane must pause, without treating this as its own stall.
    target.channel.bufferedAmount = 300 * 1024;
    heldNext.release();
    await vi.advanceTimersByTimeAsync(0);
    const main = broadcastFile(current, CURRENT, 6);
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(index === 0 ? 5_000 : 10_000);
      expect(mainReads).toHaveLength(index + 1);
      mainReads[index]!();
      await vi.advanceTimersByTimeAsync(1);
      expect(target.wire.filter((frame) => frame.type === MSG.FILE_CHUNK)).toHaveLength(index + 1);
      expect(target.wire.some((frame) => frame.type === MSG.PRELOAD_CHUNK)).toBe(false);
    }
    await main;
    target.channel.bufferedAmount = 0;
    target.channel.dispatchEvent(new Event('bufferedamountlow'));
    await vi.advanceTimersByTimeAsync(100);
    await preload;
    expect(target.wire.filter((frame) => frame.type === MSG.PRELOAD_CHUNK)).toHaveLength(1);
    expect(target.wire.at(-1)?.type).toBe(MSG.PRELOAD_END);
    expect(heldNext.read).toHaveBeenCalledOnce();
  });

  it('lets an exact promoted preload finish before its successor despite an obsolete main owner', async () => {
    const target = connection('promoted-owner');
    const current = new File(['old'], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    const future = new File(['future'], 'future.mp3');
    const heldMain = holdRead(current);
    const heldNext = holdRead(next);
    installPeers(target.peer);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next), item(FUTURE, future)]);
    publishCurrent(current);
    const obsoleteMain = unicastFile(target.conn, current, 0, 6, { queueItemId: CURRENT });
    await vi.advanceTimersByTimeAsync(100);
    publishPreload(next);
    const promoted = unicastPreload(target.conn, next, NEXT, 7);
    await vi.advanceTimersByTimeAsync(100);
    expect(heldNext.read).not.toHaveBeenCalled();
    publishCurrent(next, NEXT, 7);
    publishPreload(future, FUTURE, 8);
    const successor = unicastPreload(target.conn, future, FUTURE, 8);
    await vi.advanceTimersByTimeAsync(100);
    expect(heldNext.read).toHaveBeenCalledOnce();
    expect(
      target.wire.some((frame) => frame.type === MSG.PRELOAD_START && frame.queueItemId === FUTURE),
    ).toBe(false);
    heldNext.release();
    await vi.advanceTimersByTimeAsync(150);
    await Promise.all([promoted, successor]);
    const preloadWire = target.wire.filter((frame) => String(frame.type).startsWith('preload-'));
    expect(preloadWire.map((frame) => [frame.type, frame.queueItemId])).toEqual([
      [MSG.PRELOAD_START, NEXT],
      [MSG.PRELOAD_CHUNK, NEXT],
      [MSG.PRELOAD_END, NEXT],
      [MSG.PRELOAD_START, FUTURE],
      [MSG.PRELOAD_CHUNK, FUTURE],
      [MSG.PRELOAD_END, FUTURE],
    ]);
    heldMain.release();
    await vi.advanceTimersByTimeAsync(100);
    await obsoleteMain;
    expect(target.wire.some((frame) => frame.type === MSG.FILE_CHUNK)).toBe(false);
  });

  it('does not let an old connection owner block a replacement with the same peer ID', async () => {
    const old = connection('reconnected');
    const replacement = connection('reconnected');
    const current = new File(['main'], 'current.mp3');
    const next = new File(['next'], 'next.mp3');
    const held = holdRead(current);
    installPeers(old.peer);
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    publishCurrent(current);
    publishPreload(next);
    const main = unicastFile(old.conn, current, 0, 6, { queueItemId: CURRENT });
    await vi.advanceTimersByTimeAsync(100);
    const stalePreload = unicastPreload(old.conn, next, NEXT, 7);
    await vi.advanceTimersByTimeAsync(50);
    installPeers(replacement.peer);
    bus.emit('network:peer-connection-replaced', replacement.conn.peer);
    expect(hasPendingCurrentFileTransfer(replacement.conn)).toBe(false);
    const freshPreload = unicastPreload(replacement.conn, next, NEXT, 7);
    held.release();
    await vi.advanceTimersByTimeAsync(150);
    await Promise.all([main, stalePreload, freshPreload]);
    expect(old.wire.map((frame) => frame.type)).toEqual([MSG.FILE_START]);
    expect(replacement.wire.map((frame) => frame.type)).toEqual([
      MSG.PRELOAD_START,
      MSG.PRELOAD_CHUNK,
      MSG.PRELOAD_END,
    ]);
  });
});

describe('preload receive watchdog while the main file owns bandwidth', () => {
  it.each([
    'resume-next',
    'grace-expires',
    'cancel-main',
    'missing-main',
    'unrelated-main',
    'released-ready',
  ] as const)(
    'retains final main-byte progress at the preload deadline, then %s',
    async (outcome) => {
      const target = connection('host');
      setState('network.appRole', 'guest');
      setState('network.hostConn', target.conn);
      setState('network.connectionType', 'local');
      markQueueAuthorityReady(target.conn);
      const current = new File([new Uint8Array(CHUNK_SIZE + 1)], 'current.mp3');
      const next = new File([new Uint8Array(CHUNK_SIZE + 1)], 'next.mp3');
      setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
      setState('playlist.currentQueueItemId', CURRENT);
      // Keep the completed main file in the real PROCESSING phase, before the
      // async RAM read/decode continuation. Preload reads remain real.
      vi.spyOn(storage, 'readStoredFile').mockImplementationOnce(() => new Promise(() => {}));
      const preloadMeta = {
        queueItemId: NEXT,
        sessionId: 7,
        name: next.name,
        mime: next.type,
        total: 2,
        size: next.size,
      };
      await handleData({ type: MSG.PRELOAD_START, ...preloadMeta }, target.conn);
      await handleData(
        {
          type: MSG.PRELOAD_CHUNK,
          queueItemId: NEXT,
          sessionId: 7,
          chunkIndex: 0,
          chunk: new Uint8Array(CHUNK_SIZE).fill(3),
        },
        target.conn,
      );
      const mainMeta = {
        queueItemId: CURRENT,
        sessionId: 6,
        name: current.name,
        mime: current.type,
        total: 2,
        size: current.size,
      };
      await handleData({ type: MSG.FILE_START, ...mainMeta }, target.conn);
      await vi.advanceTimersByTimeAsync(10_000);
      await handleData(
        { type: MSG.FILE_CHUNK, ...mainMeta, chunkIndex: 0, chunk: new Uint8Array(CHUNK_SIZE) },
        target.conn,
      );
      await vi.advanceTimersByTimeAsync(4_999);
      await handleData(
        { type: MSG.FILE_CHUNK, ...mainMeta, chunkIndex: 1, chunk: new Uint8Array([8]) },
        target.conn,
      );
      expect(getState('transfer.receivedCount')).toBe(2);
      expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
      if (outcome === 'cancel-main') cancelIncomingFileTransfer('watchdog cancellation regression');
      if (outcome === 'missing-main') setState('transfer.meta', null);
      if (outcome === 'unrelated-main') setState('playlist.currentQueueItemId', NEXT);
      if (outcome === 'grace-expires' || outcome === 'released-ready') {
        // finalizeGuestFile publishes the exact resident before READY. A
        // released READY resident must not keep speculative storage alive.
        setState(
          'files.current',
          outcome === 'grace-expires' ? resident(current, CURRENT, 6) : null,
        );
        setState('transfer.state', TRANSFER_STATE.READY);
      }
      await vi.advanceTimersByTimeAsync(2);
      const eligible = outcome === 'resume-next' || outcome === 'grace-expires';
      expect(getState('preload.sessionState').get(7)).toMatchObject({
        skipped: !eligible,
        progress: 1,
      });
      if (outcome === 'resume-next') {
        // The sender's parked priority gate can take up to 50 ms to notice END.
        await vi.advanceTimersByTimeAsync(49);
        await handleData(
          {
            type: MSG.PRELOAD_CHUNK,
            queueItemId: NEXT,
            sessionId: 7,
            chunkIndex: 1,
            chunk: new Uint8Array([9]),
          },
          target.conn,
        );
        expect(getState('preload.ready')?.queueItemId).toBe(NEXT);
        expect(getState('preload.ready')?.blob.size).toBe(next.size);
      } else if (outcome === 'grace-expires') {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(getState('preload.sessionState').get(7)?.skipped).toBe(true);
      }
    },
  );

  it.each(['main', 'promoted'] as const)(
    'does not grant grace for %s bytes accepted before the watchdog armed',
    async (lane) => {
      setState('playlist.currentQueueItemId', NEXT);
      setState(
        'preload.sessionState',
        new Map([
          [
            7,
            {
              queueItemId: NEXT,
              skipped: false,
              finalized: false,
              progress: 1,
              total: 2,
              name: 'next.mp3',
              indexHint: 1,
              size: CHUNK_SIZE + 1,
              mime: '',
              nextExpectedChunk: 1,
            },
          ],
          [
            6,
            {
              queueItemId: CURRENT,
              skipped: false,
              finalized: true,
              progress: 2,
              total: 2,
              name: 'current.mp3',
              indexHint: 0,
              size: CHUNK_SIZE + 1,
              mime: '',
              nextExpectedChunk: 2,
            },
          ],
        ]),
      );
      setState('transfer.meta', {
        queueItemId: CURRENT,
        sessionId: 6,
        name: 'current.mp3',
        total: 2,
        size: CHUNK_SIZE + 1,
        mime: '',
      });
      setState('transfer.receivedCount', 2);
      setState('transfer.state', lane === 'main' ? TRANSFER_STATE.PROCESSING : TRANSFER_STATE.IDLE);
      recordMainReceiveProgress(CURRENT, 6);
      if (lane === 'main') {
        const sessions = new Map(getState('preload.sessionState'));
        sessions.delete(6);
        setState('preload.sessionState', sessions);
      }
      const stalled = vi.fn();
      armPreloadAdmissionWatchdog(7, 15_000, stalled);
      // Only selection changes after admission. Previously accepted progress
      // cannot earn a new lease merely by becoming the current identity.
      setState('playlist.currentQueueItemId', CURRENT);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stalled).toHaveBeenCalledOnce();
    },
  );

  it('retains the completed promoted preload progress for one bounded successor grace', async () => {
    const target = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', target.conn);
    setState('network.connectionType', 'local');
    markQueueAuthorityReady(target.conn);
    const current = new File([new Uint8Array(CHUNK_SIZE + 1)], 'current.mp3');
    const next = new File([new Uint8Array(CHUNK_SIZE + 1)], 'next.mp3');
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    setState('playlist.currentQueueItemId', CURRENT);
    for (const [queueItemId, file, sessionId] of [
      [CURRENT, current, 6],
      [NEXT, next, 7],
    ] as const) {
      await handleData(
        {
          type: MSG.PRELOAD_START,
          queueItemId,
          sessionId,
          name: file.name,
          mime: file.type,
          total: 2,
          size: file.size,
        },
        target.conn,
      );
      await handleData(
        {
          type: MSG.PRELOAD_CHUNK,
          queueItemId,
          sessionId,
          chunkIndex: 0,
          chunk: new Uint8Array(CHUNK_SIZE),
        },
        target.conn,
      );
    }
    await vi.advanceTimersByTimeAsync(14_999);
    await handleData(
      {
        type: MSG.PRELOAD_CHUNK,
        queueItemId: CURRENT,
        sessionId: 6,
        chunkIndex: 1,
        chunk: new Uint8Array([8]),
      },
      target.conn,
    );
    expect(getState('preload.sessionState').get(6)?.finalized).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(getState('preload.sessionState').get(7)).toMatchObject({ skipped: false, progress: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getState('preload.sessionState').get(7)?.skipped).toBe(true);
  });

  it('recognizes fresh main bytes after a delayed same-session resume lowers the count', async () => {
    const target = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', target.conn);
    setState('network.connectionType', 'local');
    markQueueAuthorityReady(target.conn);
    const current = new File([new Uint8Array(CHUNK_SIZE * 5 + 1)], 'current.mp3');
    const next = new File([new Uint8Array(CHUNK_SIZE + 1)], 'next.mp3');
    setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
    setState('playlist.currentQueueItemId', CURRENT);
    await handleData(
      {
        type: MSG.PRELOAD_START,
        queueItemId: NEXT,
        sessionId: 7,
        name: next.name,
        mime: next.type,
        total: 2,
        size: next.size,
      },
      target.conn,
    );
    await handleData(
      {
        type: MSG.PRELOAD_CHUNK,
        queueItemId: NEXT,
        sessionId: 7,
        chunkIndex: 0,
        chunk: new Uint8Array(CHUNK_SIZE).fill(3),
      },
      target.conn,
    );
    const mainMeta = {
      queueItemId: CURRENT,
      sessionId: 6,
      name: current.name,
      mime: current.type,
      total: 6,
      size: current.size,
    };
    await handleData({ type: MSG.FILE_START, ...mainMeta }, target.conn);
    const receiveChunk = (chunkIndex: number) =>
      handleData(
        {
          type: MSG.FILE_CHUNK,
          ...mainMeta,
          chunkIndex,
          chunk: new Uint8Array(CHUNK_SIZE),
        },
        target.conn,
      );
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(3_000);
      await receiveChunk(index);
    }
    expect(getState('transfer.receivedCount')).toBe(3);
    // At 15 s the preload watchdog retains its bytes and checkpoints count 3.
    await vi.advanceTimersByTimeAsync(6_001);
    expect(getState('preload.sessionState').get(7)).toMatchObject({
      skipped: false,
      progress: 1,
    });

    // A resume requested at count 1 can arrive after already-queued bulk chunks
    // 1/2. The real receive handler rebases the same identity to startChunk 1;
    // no fixture state mutation or artificial RAM loss is needed.
    await handleData({ type: MSG.FILE_RESUME, ...mainMeta, startChunk: 1 }, target.conn);
    expect(getState('transfer.receivedCount')).toBe(1);
    await receiveChunk(1);
    expect(getState('transfer.receivedCount')).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getState('preload.sessionState').get(7)).toMatchObject({
      skipped: false,
      progress: 1,
    });
    expect(getState('transfer.receivedCount')).toBeLessThan(mainMeta.total);

    // Neither the reduced counter nor unchanged RECEIVING state earns another
    // lease without fresh accepted bytes.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getState('preload.sessionState').get(7)?.skipped).toBe(true);
    expect(getState('preload.ready')).toBeNull();
  });

  it.each(['complete-preload', 'main-stalls'] as const)(
    'keeps accepted preload bytes during real main progress, then %s',
    async (outcome) => {
      const target = connection('host');
      setState('network.appRole', 'guest');
      setState('network.hostConn', target.conn);
      setState('network.connectionType', 'local');
      markQueueAuthorityReady(target.conn);
      const current = new File([new Uint8Array(CHUNK_SIZE * 3 + 1)], 'current.mp3');
      const next = new File([new Uint8Array(CHUNK_SIZE + 1)], 'next.mp3');
      setState('playlist.items', [item(CURRENT, current), item(NEXT, next)]);
      setState('playlist.currentQueueItemId', CURRENT);
      await handleData(
        {
          type: MSG.PRELOAD_START,
          queueItemId: NEXT,
          sessionId: 7,
          name: next.name,
          mime: next.type,
          total: 2,
          size: next.size,
        },
        target.conn,
      );
      await handleData(
        {
          type: MSG.PRELOAD_CHUNK,
          queueItemId: NEXT,
          sessionId: 7,
          chunkIndex: 0,
          chunk: new Uint8Array(CHUNK_SIZE).fill(3),
        },
        target.conn,
      );
      await handleData(
        {
          type: MSG.FILE_START,
          queueItemId: CURRENT,
          sessionId: 6,
          name: current.name,
          mime: current.type,
          total: 4,
          size: current.size,
        },
        target.conn,
      );
      for (let index = 0; index < 3; index++) {
        await vi.advanceTimersByTimeAsync(10_000);
        await handleData(
          {
            type: MSG.FILE_CHUNK,
            queueItemId: CURRENT,
            sessionId: 6,
            name: current.name,
            total: 4,
            size: current.size,
            mime: current.type,
            chunkIndex: index,
            chunk: new Uint8Array(CHUNK_SIZE),
          },
          target.conn,
        );
        expect(getState('transfer.receivedCount')).toBe(index + 1);
        expect(getState('preload.sessionState').get(7)).toMatchObject({
          skipped: false,
          progress: 1,
        });
      }
      if (outcome === 'complete-preload') {
        await handleData(
          {
            type: MSG.PRELOAD_CHUNK,
            queueItemId: NEXT,
            sessionId: 7,
            chunkIndex: 1,
            chunk: new Uint8Array([9]),
          },
          target.conn,
        );
        const ready = getState('preload.ready');
        expect(ready?.queueItemId).toBe(NEXT);
        expect(ready?.blob.size).toBe(CHUNK_SIZE + 1);
        const bytes = new Uint8Array(await ready!.blob.arrayBuffer());
        expect(bytes[0]).toBe(3);
        expect(bytes.at(-1)).toBe(9);
      } else {
        // A single late main chunk may justify one more lease, but unchanged
        // RECEIVING state cannot extend the preload indefinitely.
        await vi.advanceTimersByTimeAsync(30_001);
        expect(getState('preload.sessionState').get(7)?.skipped).toBe(true);
        expect(getState('preload.ready')).toBeNull();
      }
    },
  );
});
