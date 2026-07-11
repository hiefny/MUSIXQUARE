/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MSG, PLAYBACK_STATE, CHUNK_SIZE } from '../../core/constants.ts';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { getPreloadMemoryStats, initPreload, schedulePreload, unicastPreload } from '../preload.ts';
import { setRepeatMode, setShuffle } from '../../player/playlist.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';

const storageMocks = vi.hoisted(() => ({
  readStoredFile: vi.fn(),
}));

const Q0 = '00000000-0000-4000-8000-000000000001';
const Q1 = '00000000-0000-4000-8000-000000000002';
const Q2 = '00000000-0000-4000-8000-000000000003';
let queueSequence = 10;
const nextQueueItemId = () =>
  `00000000-0000-4000-8000-${String(queueSequence++).padStart(12, '0')}`;

vi.mock('../storage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage.ts')>();
  return { ...actual, readStoredFile: storageMocks.readStoredFile };
});

beforeEach(() => {
  resetState();
  bus.clear();
  storageMocks.readStoredFile.mockReset();
  storageMocks.readStoredFile.mockResolvedValue(null);
  queueSequence = 10;
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── schedulePreload ─────────────────────────────────────────────────

describe('schedulePreload', () => {
  it('can be called without error', () => {
    expect(() => schedulePreload()).not.toThrow();
  });

  it('does not crash when playlist is empty', () => {
    // playlist.items defaults to [] in initial state
    expect(getState('playlist.items')).toEqual([]);
    expect(() => schedulePreload()).not.toThrow();
  });
});

// ─── Initial Preload State ───────────────────────────────────────────

describe('initial preload state', () => {
  it('isPreloading is false', () => {
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('nextQueueItemId is null', () => {
    expect(getState('preload.nextQueueItemId')).toBeNull();
  });

  it('ready is null', () => {
    expect(getState('preload.ready')).toBeNull();
  });
});

describe('pre-admission preload buffer bounds', () => {
  it('caps unknown sessions globally while preserving the newest contiguous prefix', async () => {
    vi.useFakeTimers();
    initPreload();
    const hostConn = { open: true, peer: 'host-early', send: vi.fn() } as unknown as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('network.sessionCode', '123456');
    setState('playlist.items', [makeFileTrack('newest.mp3', Q0)]);

    for (let sessionId = 1; sessionId <= 5; sessionId++) {
      for (let index = 0; index < 20; index++) {
        await handleData(
          {
            type: MSG.PRELOAD_CHUNK,
            sessionId,
            queueItemId: Q0,
            chunkIndex: index,
            chunk: new Uint8Array([index]),
          },
          hostConn,
        );
      }
    }

    expect(getPreloadMemoryStats()).toMatchObject({
      reorderSessions: 3,
      reorderChunks: 60,
      reorderBytes: 60,
    });

    await handleData(
      {
        type: MSG.PRELOAD_START,
        sessionId: 5,
        queueItemId: Q0,
        name: 'newest.mp3',
        total: 20,
        size: 19 * CHUNK_SIZE + 1,
      },
      hostConn,
    );
    await vi.runOnlyPendingTimersAsync();
    expect(getState('preload.sessionState').get(5)?.progress).toBe(20);

    setState('network.sessionCode', '');
    const { resetStoredFileAdmissionsForTests } = await import('../storage.ts');
    resetStoredFileAdmissionsForTests();
  });

  it('releases an admitted partial preload when no progress arrives', async () => {
    vi.useFakeTimers();
    initPreload();
    const hostConn = { open: true, peer: 'host-stall', send: vi.fn() } as unknown as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('network.sessionCode', '123456');
    setState('playlist.items', [
      makeFileTrack('stalled.mp3', Q0),
      makeFileTrack('also-stalled.mp3', Q1),
    ]);

    await handleData(
      {
        type: MSG.PRELOAD_START,
        sessionId: 21,
        queueItemId: Q0,
        name: 'stalled.mp3',
        total: 1,
        size: 1,
      },
      hostConn,
    );
    await handleData(
      {
        type: MSG.PRELOAD_START,
        sessionId: 22,
        queueItemId: Q1,
        name: 'also-stalled.mp3',
        total: 1,
        size: 1,
      },
      hostConn,
    );
    const { storedFileAdmissionStatsForTests, resetStoredFileAdmissionsForTests } =
      await import('../storage.ts');
    expect(storedFileAdmissionStatsForTests()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 21, phase: 'assembling' }),
        expect.objectContaining({ sessionId: 22, phase: 'assembling' }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getState('preload.sessionState').get(21)?.skipped).toBe(true);
    expect(getState('preload.sessionState').get(22)?.skipped).toBe(true);
    expect(storedFileAdmissionStatsForTests()).toEqual([]);

    setState('network.sessionCode', '');
    resetStoredFileAdmissionsForTests();
  });
});

// ─── Shuffle end-of-pass preload ─────────────────────────────────────

function makeFileTrack(name: string, queueItemId = nextQueueItemId()): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name,
    title: name,
    file: new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' }),
    videoId: null,
    playlistId: null,
  };
}

describe('preloadNextTrack shuffle target (SA-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic Fisher-Yates: random=0.99 → j===i every pass → order [0,1,2]
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setState('playlist.items', [
      makeFileTrack('a.mp3'),
      makeFileTrack('b.mp3'),
      makeFileTrack('c.mp3'),
    ]);
  });

  it('does NOT stage a random preload at shuffle pass end with repeat OFF', async () => {
    setState('playlist.currentQueueItemId', getState('playlist.items')[2]!.queueItemId);
    setRepeatMode(0, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    // No preload target may be staged after a non-repeating shuffle pass ends.
    expect(getState('preload.nextQueueItemId')).toBeNull();
    expect(getState('preload.ready')).toBeNull();
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('still preloads the shuffle-next mid-pass', async () => {
    setState('playlist.currentQueueItemId', getState('playlist.items')[0]!.queueItemId);
    setRepeatMode(0, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(getState('preload.nextQueueItemId')).toBe(getState('playlist.items')[1]!.queueItemId);
    expect(getState('preload.ready')).not.toBeNull();
  });

  it('still preloads the wrap target at pass end with repeat ALL', async () => {
    setState('playlist.currentQueueItemId', getState('playlist.items')[2]!.queueItemId);
    setRepeatMode(1, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(getState('preload.nextQueueItemId')).toBe(getState('playlist.items')[0]!.queueItemId);
    expect(getState('preload.ready')).not.toBeNull();
  });
});

// ─── Per-peer backpressure exclusion ────────────────────────
//
// Pins the shared chunk-pump behavior in backgroundTransfer: one
// backpressure-stalled peer must neither stall the whole preload broadcast
// nor keep receiving chunks after timing out — it gets a targeted
// PRELOAD_ABORT and the session stays alive for everyone else.

/** Two chunks so post-exclusion streaming to survivors is observable. */
function makeChunkyFileTrack(name: string, queueItemId = nextQueueItemId()): PlaylistItem {
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

function makeBulkConn(peer: string, bufferedAmount = 0, readyState = 'open'): DataConnection {
  return {
    open: true,
    peer,
    send: vi.fn(),
    dataChannel: { readyState, bufferedAmount },
  } as unknown as DataConnection;
}

function connectBulkPeers(conns: DataConnection[]): void {
  setState(
    'network.connectedPeers',
    conns.map((conn, i) => ({
      id: conn.peer,
      status: 'connected',
      conn,
      isDataTarget: true,
      connectionType: 'local',
      joinOrder: i + 1,
    })),
  );
  setState('network.activeHostConnByPeerId', new Map(conns.map((conn) => [conn.peer, conn])));
}

function msgsOf(conn: DataConnection, type: string): Array<Record<string, unknown>> {
  return (conn.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((m) => m.type === type);
}

describe('backgroundTransfer per-peer backpressure exclusion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Sequential mode (decoupled from shuffle internals): current 0 → preload 1.
    setState('playlist.items', [makeFileTrack('now.mp3'), makeChunkyFileTrack('next.mp3')]);
    setState('playlist.currentQueueItemId', getState('playlist.items')[0]!.queueItemId);
    setState('playlist.repeatMode', 0);
    setState('playlist.isShuffle', false);
  });

  it('resolves a serialized preload target by stable queue identity after reorder', async () => {
    const now = makeFileTrack('now.mp3');
    const middle = makeChunkyFileTrack('middle.mp3');
    const target = makeChunkyFileTrack('target.mp3');
    setState('playlist.items', [now, middle, target]);
    setState('playlist.currentQueueItemId', now.queueItemId);

    const frozenConn = makeBulkConn('peer-frozen', 10 * 1024 * 1024);
    connectBulkPeers([frozenConn]);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('preload.nextQueueItemId')).toBe(middle.queueItemId);

    // The successor snapshots target before awaiting the congested transfer.
    setState('playlist.currentQueueItemId', middle.queueItemId);
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(1);

    // Reorder without changing the target occurrence or its File identity.
    // Drop future peers so the successor completes immediately once admitted.
    setState('playlist.items', [now, target, middle]);
    setState('network.connectedPeers', []);
    setState('network.activeHostConnByPeerId', new Map());
    await vi.advanceTimersByTimeAsync(31_000);

    expect(getState('preload.nextQueueItemId')).toBe(target.queueItemId);
    expect(getState('preload.activeTarget')).toMatchObject({
      queueItemId: target.queueItemId,
      indexHint: 1,
    });
    expect(getState('preload.ready')?.blob).toBe(target.file);
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('excludes a backpressure-stalled peer and keeps streaming to healthy peers', async () => {
    const healthyConn = makeBulkConn('peer-healthy', 0);
    const frozenConn = makeBulkConn('peer-frozen', 10 * 1024 * 1024); // frozen above 256KB limit
    connectBulkPeers([healthyConn, frozenConn]);

    schedulePreload(0);
    // Lockstep semantics: the healthy peer's chunks beyond chunk 0 only flow
    // AFTER the frozen peer's 30s exclusion window — assert only after the
    // full timer advance, never timing-based.
    await vi.advanceTimersByTimeAsync(35_000);

    const sid = getState('preload.sessionId');

    // Healthy peer: full stream — header, both chunks, END.
    expect(msgsOf(healthyConn, MSG.PRELOAD_START)).toHaveLength(1);
    expect(msgsOf(healthyConn, MSG.PRELOAD_CHUNK)).toHaveLength(2);
    expect(msgsOf(healthyConn, MSG.PRELOAD_END)).toHaveLength(1);
    expect(msgsOf(healthyConn, MSG.PRELOAD_ABORT)).toHaveLength(0);

    // Frozen peer: header, then exactly ONE targeted ABORT for the live sid.
    // No chunks at all (the per-peer wait runs before the send, so a
    // non-draining channel is never flooded) and no END (END would arm the
    // guest's 10s deferred-END timer churn — ABORT is the teardown signal).
    expect(msgsOf(frozenConn, MSG.PRELOAD_START)).toHaveLength(1);
    const aborts = msgsOf(frozenConn, MSG.PRELOAD_ABORT);
    expect(aborts).toHaveLength(1);
    expect(aborts[0].sessionId).toBe(sid);
    expect(msgsOf(frozenConn, MSG.PRELOAD_CHUNK)).toHaveLength(0);
    expect(msgsOf(frozenConn, MSG.PRELOAD_END)).toHaveLength(0);
  });

  it('does not escalate a single stalled peer to session-level teardown', async () => {
    const healthyConn = makeBulkConn('peer-healthy', 0);
    const frozenConn = makeBulkConn('peer-frozen', 10 * 1024 * 1024);
    connectBulkPeers([healthyConn, frozenConn]);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(35_000);

    // The preload session survived the stalled peer: cache intact and
    // consistent (atomic snapshot), sessionId never bumped by a cancel,
    // and isPreloading settled false through the natural completion path.
    expect(getState('preload.nextQueueItemId')).toBe(getState('playlist.items')[1]!.queueItemId);
    expect(getState('preload.ready')).not.toBeNull();
    expect(getState('preload.activeTarget')?.sessionId).toBe(getState('preload.sessionId'));
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('pre-excludes peers with dead data channels from the preload broadcast entirely', async () => {
    const healthyConn = makeBulkConn('peer-healthy', 0);
    const deadConn = makeBulkConn('peer-dead', 0, 'closed');
    connectBulkPeers([healthyConn, deadConn]);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(2_000);

    // Dead channel: not even a PRELOAD_START header (writability pre-filter,
    // parity with broadcastFile) — no stream that can never arrive.
    expect(deadConn.send).not.toHaveBeenCalled();

    // Healthy peer: unaffected full stream.
    expect(msgsOf(healthyConn, MSG.PRELOAD_START)).toHaveLength(1);
    expect(msgsOf(healthyConn, MSG.PRELOAD_CHUNK)).toHaveLength(2);
    expect(msgsOf(healthyConn, MSG.PRELOAD_END)).toHaveLength(1);
  });
});

describe('PLAY_PRELOADED guard', () => {
  it('does not enter preload activation while a system-audio placeholder owns playback', async () => {
    initPreload();
    const hostConn = { open: true, peer: 'host-1', send: vi.fn() } as unknown as DataConnection;
    setState('network.hostConn', hostConn);
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });
    const blob = new Blob(['should-not-activate']);
    setState('playlist.items', [makeFileTrack('song.mp3', Q0)]);
    setState('playlist.currentQueueItemId', Q0);
    setState('preload.nextQueueItemId', Q0);
    setState('preload.ready', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 9,
      size: blob.size,
      mime: blob.type,
      blob,
    });
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleData(
      {
        type: MSG.PLAY_PRELOADED,
        queueItemId: Q0,
        name: 'song.mp3',
      },
      hostConn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('preload.nextQueueItemId')).toBe(Q0);
    expect(getState('preload.ready')).not.toBeNull();
    expect(usePreloaded).not.toHaveBeenCalled();
  });
});

describe('PLAY_PRELOADED exact track identity', () => {
  function makeHostConnection(): DataConnection {
    return {
      open: true,
      peer: 'host-identity',
      send: vi.fn(),
    } as unknown as DataConnection;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    initPreload();
    setState('network.connectionType', 'local');
  });

  it('does not promote a finalized same-name Blob from another queue item', async () => {
    const hostConn = makeHostConnection();
    setState('network.hostConn', hostConn);
    const items = [makeFileTrack('same.mp3', Q0), makeFileTrack('same.mp3', Q1)];
    const blob = new Blob(['index-zero']);
    setState('playlist.items', items);
    setState('preload.nextQueueItemId', Q0);
    setState('preload.ready', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'same.mp3',
      sessionId: 11,
      size: blob.size,
      mime: blob.type,
      blob,
    });

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleData({ type: MSG.PLAY_PRELOADED, queueItemId: Q1, name: 'same.mp3' }, hostConn);
    await vi.advanceTimersByTimeAsync(400);

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(hostConn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.REQUEST_DATA_RECOVERY,
        queueItemId: Q1,
        fileName: 'same.mp3',
      }),
    );
  });

  it('does not wait on an in-progress same-name preload for another queue item', async () => {
    const hostConn = makeHostConnection();
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeFileTrack('same.mp3', Q0), makeFileTrack('same.mp3', Q1)]);
    setState(
      'preload.sessionState',
      new Map([
        [
          12,
          {
            skipped: false,
            progress: 1,
            total: 2,
            name: 'same.mp3',
            queueItemId: Q0,
            indexHint: 0,
            size: 2,
            mime: 'audio/mpeg',
            nextExpectedChunk: 1,
            finalized: false,
          },
        ],
      ]),
    );

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleData({ type: MSG.PLAY_PRELOADED, queueItemId: Q1, name: 'same.mp3' }, hostConn);
    await vi.advanceTimersByTimeAsync(400);

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(hostConn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_DATA_RECOVERY, queueItemId: Q1 }),
    );
  });

  it('does not let a same-name different-queue-item Blob win the recovery jitter race', async () => {
    const hostConn = makeHostConnection();
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeFileTrack('same.mp3', Q0), makeFileTrack('same.mp3', Q1)]);

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleData({ type: MSG.PLAY_PRELOADED, queueItemId: Q1, name: 'same.mp3' }, hostConn);

    // A different track completes before the jitter fires. Filename equality
    // must not suppress the fresh recovery request for Q1.
    const staleBlob = new Blob(['index-zero']);
    setState('preload.nextQueueItemId', Q0);
    setState('preload.ready', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'same.mp3',
      sessionId: 13,
      size: staleBlob.size,
      mime: staleBlob.type,
      blob: staleBlob,
    });
    await vi.advanceTimersByTimeAsync(400);

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(hostConn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_DATA_RECOVERY, queueItemId: Q1 }),
    );
  });
});

describe('preload completion session identity', () => {
  beforeEach(async () => {
    setState('network.connectionType', 'local');
    const { resetFileRequestAuthority } = await import('../../network/file-request-authority.ts');
    resetFileRequestAuthority();
  });

  function hostConnection(): DataConnection {
    return {
      open: true,
      peer: 'host-completion',
      send: vi.fn(),
    } as unknown as DataConnection;
  }

  async function sendStart(
    conn: DataConnection,
    sessionId: number,
    queueItemId: string,
    name: string,
  ): Promise<void> {
    await handleData(
      {
        type: MSG.PRELOAD_START,
        name,
        mime: 'audio/mpeg',
        total: 1,
        size: 3,
        queueItemId,
        sessionId,
        skipped: false,
      },
      conn,
    );
  }

  it('revalidates the exact session after a deferred RAM read', async () => {
    initPreload();
    const conn = hostConnection();
    setState('network.hostConn', conn);
    setState('playlist.items', [makeFileTrack('now.mp3', Q0), makeFileTrack('same.mp3', Q1)]);

    await sendStart(conn, 5, Q1, 'same.mp3');
    await handleData({ type: MSG.PLAY_PRELOADED, queueItemId: Q1, name: 'same.mp3' }, conn);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);

    let resolveRead: (file: File | null) => void = () => undefined;
    storageMocks.readStoredFile.mockReturnValueOnce(
      new Promise<File | null>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    bus.emit('storage:preload-file-ready', 'same.mp3', 5, Q1);
    await vi.waitFor(() =>
      expect(storageMocks.readStoredFile).toHaveBeenCalledWith(Q1, 'same.mp3', true, 5),
    );

    // The same queue occurrence and filename are reused by a newer transfer while
    // the exact old RAM slot is being wrapped. Session identity must win.
    await sendStart(conn, 6, Q1, 'same.mp3');
    resolveRead(new File(['old'], 'same.mp3', { type: 'audio/mpeg' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(getState('preload.activeTarget')?.sessionId).toBe(6);
    expect(getState('preload.nextQueueItemId')).toBeNull();
    expect(getState('preload.ready')).toBeNull();
    expect(usePreloaded).not.toHaveBeenCalled();
  });

  it('does not use an older same-queue completion for a different awaited name', async () => {
    initPreload();
    const conn = hostConnection();
    setState('network.hostConn', conn);
    setState('playlist.items', [makeFileTrack('now.mp3', Q0), makeFileTrack('old.mp3', Q1)]);

    await sendStart(conn, 10, Q1, 'old.mp3');
    await handleData({ type: MSG.PLAY_PRELOADED, queueItemId: Q1, name: 'old.mp3' }, conn);
    await sendStart(conn, 11, Q1, 'new.mp3');

    bus.emit('storage:preload-file-ready', 'old.mp3', 10, Q1);
    await Promise.resolve();

    expect(storageMocks.readStoredFile).not.toHaveBeenCalled();
    expect(getState('preload.activeTarget')).toEqual(
      expect.objectContaining({ sessionId: 11, queueItemId: Q1, name: 'new.mp3' }),
    );
  });

  it('settles the exact file request when its awaited preload becomes ready', async () => {
    initPreload();
    const conn = hostConnection();
    setState('network.hostConn', conn);
    setState('playlist.items', [makeFileTrack('now.mp3', Q0), makeFileTrack('same.mp3', Q1)]);
    await sendStart(conn, 5, Q1, 'same.mp3');
    await handleData({ type: MSG.PLAY_PRELOADED, queueItemId: Q1, name: 'same.mp3' }, conn);
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');
    beginFileRequest(conn, Q1, 5);
    storageMocks.readStoredFile.mockResolvedValueOnce(
      new File(['abc'], 'same.mp3', { type: 'audio/mpeg' }),
    );

    bus.emit('storage:preload-file-ready', 'same.mp3', 5, Q1);
    await vi.waitFor(() => expect(getState('preload.ready')?.queueItemId).toBe(Q1));

    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
  });
});

describe('unicastPreload source liveness', () => {
  function installPeer(file: Blob, bufferedAmount = 0): DataConnection {
    const conn = {
      open: true,
      peer: 'preload-peer',
      send: vi.fn(),
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [
      {
        id: conn.peer,
        status: 'connected',
        conn,
        isDataTarget: true,
        connectionType: 'local',
        joinOrder: 1,
      },
    ]);
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    const ready = {
      queueItemId: Q2,
      indexHint: 2,
      name: 'next.mp3',
      sessionId: 20,
      size: file.size,
      mime: file.type,
      blob: file,
    };
    setState('preload.ready', ready);
    setState('preload.nextQueueItemId', Q2);
    setState('preload.activeTarget', ready);
    return conn;
  }

  function messages(conn: DataConnection, type: string): Array<Record<string, unknown>> {
    return vi
      .mocked(conn.send)
      .mock.calls.map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === type);
  }

  it('lets only the exact successor emit when two unicasts overlap', async () => {
    const first = new Blob(['first'], { type: 'audio/mpeg' });
    const conn = installPeer(first);
    const firstSend = unicastPreload(conn, first, Q2, 20);

    const successor = new Blob(['successor'], { type: 'audio/mpeg' });
    setState('preload.ready', {
      ...getState('preload.ready')!,
      size: successor.size,
      mime: successor.type,
      blob: successor,
    });
    const successorSend = unicastPreload(conn, successor, Q2, 20);
    await Promise.all([firstSend, successorSend]);

    expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(1);
    expect(messages(conn, MSG.PRELOAD_CHUNK)).toHaveLength(1);
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(1);
  });

  it('stops after backpressure when the source tuple is replaced', async () => {
    vi.useFakeTimers();
    const selected = new Blob(['blocked'], { type: 'audio/mpeg' });
    const conn = installPeer(selected, 1024 * 1024) as DataConnection & {
      dataChannel: { readyState: string; bufferedAmount: number };
    };

    const pending = unicastPreload(conn, selected, Q2, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(1);

    setState('preload.ready', {
      ...getState('preload.ready')!,
      blob: new Blob(['replacement']),
    });
    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(messages(conn, MSG.PRELOAD_CHUNK)).toHaveLength(0);
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(0);
  });

  it('rechecks the exact source after an asynchronous slice read', async () => {
    let resolveRead: (value: ArrayBuffer) => void = () => undefined;
    const read = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    const selected = {
      size: 3,
      type: 'audio/mpeg',
      slice: vi.fn(() => ({ arrayBuffer: () => read })),
    } as unknown as Blob;
    const conn = installPeer(selected);

    const pending = unicastPreload(conn, selected, Q2, 20);
    await vi.waitFor(() => expect(messages(conn, MSG.PRELOAD_START)).toHaveLength(1));
    setState('preload.ready', {
      ...getState('preload.ready')!,
      blob: new Blob(['replacement']),
    });
    resolveRead(new Uint8Array([1, 2, 3]).buffer);
    await pending;

    expect(messages(conn, MSG.PRELOAD_CHUNK)).toHaveLength(0);
    expect(messages(conn, MSG.PRELOAD_END)).toHaveLength(0);
  });
});
