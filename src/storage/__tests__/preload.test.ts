/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MSG, PLAYBACK_STATE, CHUNK_SIZE } from '../../core/constants.ts';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { initPreload, schedulePreload } from '../preload.ts';
import { setRepeatMode, setShuffle } from '../../player/playlist.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
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

  it('nextTrackIndex is -1', () => {
    expect(getState('preload.nextTrackIndex')).toBe(-1);
  });

  it('nextFileBlob is null', () => {
    expect(getState('preload.nextFileBlob')).toBeNull();
  });
});

// ─── Shuffle end-of-pass preload (SA-01) ─────────────────────────────

function makeFileTrack(name: string): PlaylistItem {
  return {
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
    setState('playlist.currentTrackIndex', 2); // last slot in order [0,1,2]
    setRepeatMode(0, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    // Pre-fix this staged a random index (0 or 1), which playNextTrack's
    // preferredIndex fast-accept then used to bypass handleEndOfPlaylist.
    expect(getState('preload.nextTrackIndex')).toBe(-1);
    expect(getState('preload.nextFileBlob')).toBeNull();
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('still preloads the shuffle-next mid-pass', async () => {
    setState('playlist.currentTrackIndex', 0);
    setRepeatMode(0, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(getState('preload.nextTrackIndex')).toBe(1);
    expect(getState('preload.nextFileBlob')).not.toBeNull();
  });

  it('still preloads the wrap target at pass end with repeat ALL', async () => {
    setState('playlist.currentTrackIndex', 2);
    setRepeatMode(1, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(getState('preload.nextTrackIndex')).toBe(0);
    expect(getState('preload.nextFileBlob')).not.toBeNull();
  });
});

// ─── Per-peer backpressure exclusion (STO-BACKPRESSURE) ──────────────
//
// Pins the shared chunk-pump behavior in backgroundTransfer: one
// backpressure-stalled peer must neither stall the whole preload broadcast
// nor keep receiving chunks after timing out — it gets a targeted
// PRELOAD_ABORT and the session stays alive for everyone else.

/** Two chunks so post-exclusion streaming to survivors is observable. */
function makeChunkyFileTrack(name: string): PlaylistItem {
  return {
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
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.repeatMode', 0);
    setState('playlist.isShuffle', false);
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
    expect(getState('preload.nextTrackIndex')).toBe(1);
    expect(getState('preload.nextFileBlob')).not.toBeNull();
    expect(getState('preload.meta')?.sessionId).toBe(getState('preload.sessionId'));
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
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    await handleData(
      {
        type: MSG.PLAY_PRELOADED,
        index: 0,
        name: 'song.mp3',
      },
      { open: true, peer: 'host-1' } as DataConnection,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('preload.nextTrackIndex')).toBe(-1);
    expect(getState('preload.nextFileBlob')).toBeNull();
  });
});
