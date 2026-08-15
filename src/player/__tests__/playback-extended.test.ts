/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  MAX_SYSTEM_AUDIO_DEVICES,
  MSG,
  PLAYBACK_STATE,
  TRANSFER_STATE,
} from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import {
  getCurrentAudioBuffer,
  getCurrentLoadEpoch,
  newLoadEpoch,
  getPendingPlayTime,
  setPendingPlayTime,
  setCurrentAudioBuffer,
  setPlayerNode,
} from '../_state.ts';
import { initPlayback } from '../playback.ts';
import {
  pause,
  setLocalManualSyncOffset,
  stopPlayerNode,
  stopAllMedia,
  togglePlay,
  updatePlayState,
} from '../transport.ts';
import {
  isExternalOwner,
  isSystemAudioOwner,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackSystemAudioPlaying,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';
import { broadcast, sendToHost } from '../../network/peer.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import { registerProRoomMediaHooks, type ProRoomMediaHooks } from '../../pro-room/media-hooks.ts';
import { log } from '../../core/log.ts';
import { configureSystemAudioCaptureActivityProbe } from '../../audio/system-capture-activity-port.ts';

const lazyPlaylistMocks = vi.hoisted(() => ({
  loadPlaylistModule: vi.fn(),
}));

const QID_OLD = '00000000-0000-4000-8000-000000000001';
const QID_NEW = '00000000-0000-4000-8000-000000000002';

function playlistItem(queueItemId: string, name: string, title = name): PlaylistItem {
  return { queueItemId, type: 'file', name, title, videoId: null, playlistId: null };
}

function connectedPeer(slot: number): ConnectedPeer {
  return {
    id: `peer-${slot}`,
    slot,
    label: `Peer ${slot}`,
    conn: null,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: slot,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

function dataConnection(peer: string, send = vi.fn()): DataConnection {
  return {
    open: true,
    peer,
    send,
    close: vi.fn(),
    on: () => undefined,
  };
}

function setResidentFile(queueItemId: string, indexHint: number, name: string): void {
  const blob = new File(['audio'], name, { type: 'audio/mpeg' });
  setState('files.current', {
    queueItemId,
    indexHint,
    name,
    sessionId: 1,
    blob,
    mime: blob.type,
    size: blob.size,
  });
}

function expectCorrelatedRequest(
  send: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
): void {
  expect(send).toHaveBeenCalledWith({
    ...expected,
    requestId: expect.any(Number),
  });
  const matchingCall = send.mock.calls.find(([message]) =>
    Object.entries(expected).every(
      ([key, value]) => (message as Record<string, unknown> | undefined)?.[key] === value,
    ),
  );
  const requestId = (matchingCall?.[0] as { requestId?: unknown } | undefined)?.requestId;
  expect(requestId).toEqual(expect.any(Number));
  expect(requestId as number).toBeGreaterThan(0);
}

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
}));

vi.mock('../playlist-loader.ts', () => ({
  loadPlaylistModule: lazyPlaylistMocks.loadPlaylistModule,
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.mocked(broadcast).mockClear();
  vi.mocked(sendToHost).mockClear();
  lazyPlaylistMocks.loadPlaylistModule.mockReset();
  lazyPlaylistMocks.loadPlaylistModule.mockImplementation(() => import('../playlist.ts'));
});

afterEach(() => {
  registerProRoomMediaHooks(null);
});

function persistentProMediaHooks(queueItemId: string): ProRoomMediaHooks {
  return {
    addFiles: () => false,
    addYouTube: () => false,
    updateTrackMetadata: () => false,
    removeTracks: () => false,
    reorderTrack: () => false,
    resolveFile: () => null,
    handlesPersistentFile: (candidate) => candidate === queueItemId,
  };
}

// ─── getCurrentAudioBuffer ───────────────────────────────────────────

describe('getCurrentAudioBuffer', () => {
  it('returns null initially', () => {
    expect(getCurrentAudioBuffer()).toBeNull();
  });
});

// ─── getCurrentLoadEpoch / newLoadEpoch ──────────────────────────────

describe('getCurrentLoadEpoch', () => {
  it('returns 0 initially', () => {
    expect(getCurrentLoadEpoch()).toBe(0);
  });
});

describe('newLoadEpoch', () => {
  it('increments and returns new value', () => {
    const initial = getCurrentLoadEpoch();
    const next = newLoadEpoch();
    expect(next).toBe(initial + 1);
    expect(getCurrentLoadEpoch()).toBe(next);
  });
});

// ─── getPendingPlayTime / setPendingPlayTime ─────────────────────────

describe('getPendingPlayTime', () => {
  it('returns undefined initially', () => {
    expect(getPendingPlayTime()).toBeUndefined();
  });
});

describe('setPendingPlayTime', () => {
  it('sets and getPendingPlayTime returns the value', () => {
    setPendingPlayTime(5);
    expect(getPendingPlayTime()).toBe(5);
  });
});

describe('setLocalManualSyncOffset', () => {
  it('keeps the logical track position stable when changing offset during playback', () => {
    setPlaybackFilePlaying();
    setState('player.startedAt', 100);
    setState('sync.localOffset', 0.25);

    const next = setLocalManualSyncOffset(0.5);

    expect(next).toBe(0.5);
    expect(getState('sync.localOffset')).toBe(0.5);
    expect(getState('player.startedAt')).toBe(100.25);
  });

  it('clamps manual file offsets to the supported nudge range', () => {
    const next = setLocalManualSyncOffset(99);

    expect(next).toBe(3);
    expect(getState('sync.localOffset')).toBe(3);
  });
});

// ─── stopPlayerNode ──────────────────────────────────────────────────

describe('stopPlayerNode', () => {
  it('does not throw when no player node exists', () => {
    expect(() => stopPlayerNode()).not.toThrow();
  });
});

// ─── stopAllMedia ────────────────────────────────────────────────────

describe('stopAllMedia', () => {
  it('force-stops an active local capture through the leaf activity port', () => {
    const forceStop = vi.fn();
    bus.on('system-audio:force-stop', forceStop);
    const restoreProbe = configureSystemAudioCaptureActivityProbe(() => true);

    try {
      stopAllMedia({ silent: true });
    } finally {
      restoreProbe();
    }

    expect(forceStop).toHaveBeenCalledTimes(1);
  });

  it('resets playback mode/activity to idle', () => {
    setPlaybackFilePlaying();
    stopAllMedia();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('requests visualizer fade-out instead of frame hold', () => {
    const fade = vi.fn();
    const hold = vi.fn();
    bus.on('visualizer:fade-out', fade);
    bus.on('visualizer:hold-frame', hold);

    stopAllMedia({ silent: true });

    expect(fade).toHaveBeenCalledTimes(1);
    expect(hold).not.toHaveBeenCalled();
  });

  it('broadcasts PAUSE with reason=transition for silent track-change path', () => {
    setPlaybackFilePlaying();

    stopAllMedia({ silent: true });

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pause', reason: 'transition' }),
    );
  });

  it('clears YouTube mode during a silent audio takeover', () => {
    setPlaybackYouTubePlaying();

    stopAllMedia({ silent: true });

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('broadcasts PAUSE with reason=stop for explicit terminal stops', () => {
    setPlaybackFilePlaying();

    stopAllMedia();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pause', reason: 'stop' }),
    );
  });

  it('can cancel in-flight loads when taking playback ownership away', () => {
    const before = getCurrentLoadEpoch();

    stopAllMedia({ cancelInFlight: true });

    expect(getCurrentLoadEpoch()).toBe(before + 1);
  });

  it('keeps the existing load token on silent track-change stops', () => {
    const before = getCurrentLoadEpoch();

    stopAllMedia({ silent: true });

    expect(getCurrentLoadEpoch()).toBe(before);
  });
});

describe('external playback mode guards', () => {
  it('treats the system-audio receiving placeholder as system-audio ownership', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    expect(isSystemAudioOwner()).toBe(true);
    expect(isExternalOwner()).toBe(true);
  });
});

describe('pause', () => {
  it('holds the current visualizer frame for an explicit pause', () => {
    const hold = vi.fn();
    bus.on('visualizer:hold-frame', hold);
    setPlaybackFilePlaying();

    pause();

    expect(hold).toHaveBeenCalledTimes(1);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('does not hold the visualizer for programmatic rendezvous pauses', () => {
    const hold = vi.fn();
    bus.on('visualizer:hold-frame', hold);
    setPlaybackFilePlaying();

    pause(0, { holdVisualizer: false });

    expect(hold).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('stops a remote pause before applying the paused lifecycle state', async () => {
    const stop = vi.fn();
    const disconnect = vi.fn();
    const conn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', conn);
    setState('playlist.items', [playlistItem(QID_OLD, 'song.mp3', 'Song')]);
    setState('playlist.currentQueueItemId', QID_OLD);
    setPlaybackFilePlaying();
    setPlayerNode({
      stop,
      disconnect,
      onended: vi.fn(),
      buffer: {} as AudioBuffer,
    } as unknown as AudioBufferSourceNode);

    initPlayback();
    await handleData({ type: MSG.PAUSE, time: 12, queueItemId: QID_OLD, reason: 'stop' }, conn);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getState('player.pausedAt')).toBe(12);
    expect(getState('playback.activity')).toBe('paused');
  });

  it('reuses an idle late-join PAUSE position when an operator requests play', async () => {
    const conn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    setState('playlist.currentQueueItemId', QID_OLD);
    setState('playlist.items', [playlistItem(QID_OLD, 'song.mp3', 'Song')]);

    initPlayback();
    markQueueAuthorityReady(conn);
    await handleData({ type: MSG.PAUSE, time: 42, queueItemId: QID_OLD, reason: 'pause' }, conn);
    expect(getState('player.pausedAt')).toBe(42);
    togglePlay();

    expect(sendToHost).toHaveBeenCalledWith({
      type: MSG.REQUEST_PLAY,
      time: 42,
      queueItemId: QID_OLD,
    });
  });
});

// ─── togglePlay end-of-track race ────────────────────────────────────

describe('togglePlay end-of-track race', () => {
  it('advances a pending natural-end transition instead of broadcasting stale play', async () => {
    setState('network.appRole', 'host');
    setState('playlist.items', [
      playlistItem(QID_OLD, 'third.mp3', 'Third'),
      playlistItem(QID_NEW, 'fourth.mp3', 'Fourth'),
    ]);
    setState('playlist.currentQueueItemId', QID_OLD);
    setState('player.pausedAt', 0);
    setResidentFile(QID_OLD, 0, 'third.mp3');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setManagedTimer('ended-advance-next', () => {}, 30_000);

    togglePlay();

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAY, queueItemId: QID_OLD }),
    );

    await vi.dynamicImportSettled();

    expect(getState('playlist.currentQueueItemId')).toBe(QID_NEW);
    expect(getManagedTimer('ended-advance-next')).toBeNull();
  });

  it('contains a rejected lazy advance after a natural track end', async () => {
    const error = new Error('playlist chunk unavailable');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    lazyPlaylistMocks.loadPlaylistModule.mockRejectedValueOnce(error);
    setState('network.appRole', 'host');
    setState('playlist.items', [playlistItem(QID_OLD, 'ended.mp3', 'Ended')]);
    setState('playlist.currentQueueItemId', QID_OLD);
    setResidentFile(QID_OLD, 0, 'ended.mp3');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setPlaybackFilePaused();
    setManagedTimer('ended-advance-next', () => {}, 30_000);

    togglePlay();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[Play] Failed to advance the playlist after track end:',
        error,
      ),
    );
    warn.mockRestore();
  });
});

// ─── updatePlayState ─────────────────────────────────────────────────

describe('togglePlay file pipeline guard', () => {
  it('ignores play while the next file is decoding even if an old buffer is still resident', () => {
    setState('playlist.items', [
      playlistItem(QID_OLD, 'old.mp3', 'Old'),
      playlistItem(QID_NEW, 'new.mp3', 'New'),
    ]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('player.pausedAt', 0);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setResidentFile(QID_OLD, 0, 'old.mp3');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    togglePlay();

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAY }));
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('contains a rejected lazy playlist load instead of leaking an unhandled rejection', async () => {
    const error = new Error('playlist chunk unavailable');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    lazyPlaylistMocks.loadPlaylistModule.mockRejectedValueOnce(error);
    setState('network.appRole', 'host');
    setState('playlist.items', [playlistItem(QID_OLD, 'retry.mp3', 'Retry')]);
    setState('playlist.currentQueueItemId', QID_OLD);
    setPlaybackFilePaused();

    togglePlay();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[Play] Failed to retry the selected playlist item:',
        error,
      ),
    );
    warn.mockRestore();
  });

  it('contains a rejected lazy restart from the deselected playlist state', async () => {
    const error = new Error('playlist chunk unavailable');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    lazyPlaylistMocks.loadPlaylistModule.mockRejectedValueOnce(error);
    setState('network.appRole', 'host');
    setState('playlist.items', [playlistItem(QID_OLD, 'first.mp3', 'First')]);
    setState('playlist.currentQueueItemId', null);

    togglePlay();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[Play] Failed to restart the first playlist item:', error),
    );
    warn.mockRestore();
  });
});

// ─── handleRequestPlay file pipeline guard ──────────────────────────
// A host receiving REQUEST_PLAY during file preparation must not start the
// resident buffer under the new track index.

describe('handleRequestPlay file pipeline guard', () => {
  it('drops OP REQUEST_PLAY while the next file is decoding', async () => {
    setState('playlist.items', [
      playlistItem(QID_OLD, 'old.mp3', 'Old'),
      playlistItem(QID_NEW, 'new.mp3', 'New'),
    ]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('player.pausedAt', 0);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setResidentFile(QID_OLD, 0, 'old.mp3');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const opConn = dataConnection('op-1');
    setState('network.connectedPeers', [
      { ...connectedPeer(1), id: 'op-1', label: 'OP', isOp: true, conn: opConn },
    ]);

    initPlayback();
    await handleData({ type: MSG.REQUEST_PLAY, time: 0, queueItemId: QID_NEW }, opConn);

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAY }));
  });
});

describe('operator seek canonicalization', () => {
  function arrangePausedHost(duration: number): DataConnection {
    setState('playlist.items', [playlistItem(QID_OLD, 'song.mp3', 'Song')]);
    setState('playlist.currentQueueItemId', QID_OLD);
    setCurrentAudioBuffer({ duration } as AudioBuffer);
    setPlaybackFilePaused();

    const opConn = dataConnection('op-seek');
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[opConn.peer, opConn]]));
    setState('network.connectedPeers', [
      { ...connectedPeer(1), id: 'op-seek', label: 'OP', isOp: true, conn: opConn },
    ]);
    initPlayback();
    return opConn;
  }

  it('uses one duration-clamped position for host state and broadcast', async () => {
    const opConn = arrangePausedHost(120);

    await handleData({ type: MSG.REQUEST_SEEK, time: 999, queueItemId: QID_OLD }, opConn);

    expect(getState('player.pausedAt')).toBeCloseTo(119.9, 6);
    expect(broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 119.9,
      queueItemId: QID_OLD,
      reason: 'seek',
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
    'does not let a non-normal duration corrupt a finite seek (%s)',
    async (duration) => {
      const opConn = arrangePausedHost(duration);

      await handleData({ type: MSG.REQUEST_SEEK, time: 42, queueItemId: QID_OLD }, opConn);

      expect(getState('player.pausedAt')).toBe(42);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.PAUSE, time: 42, queueItemId: QID_OLD }),
      );
    },
  );
});

// ─── handlePlayMsg lifecycle gate (DOWNLOADING/DECODING defer) ──────
// Sibling of the AWAITING_PRELOAD branch: a host PLAY broadcast that
// arrives while the guest's own pipeline is still preparing must defer
// to pendingPlayTime instead of replaying the previous track's buffer.

describe('handlePlayMsg lifecycle gate', () => {
  it('defers play time when host PLAY arrives during DECODING', async () => {
    const hostConn = dataConnection('host-1');
    setState('network.hostConn', hostConn);
    setState('playlist.items', [
      playlistItem(QID_OLD, 'old.mp3', 'Old'),
      playlistItem(QID_NEW, 'new.mp3', 'New'),
    ]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setResidentFile(QID_OLD, 0, 'old.mp3');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 42, queueItemId: QID_NEW, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(42);
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('defers play time when host PLAY arrives during DOWNLOADING', async () => {
    const hostConn = dataConnection('host-1');
    setState('network.hostConn', hostConn);
    setState('playlist.items', [
      playlistItem(QID_OLD, 'old.mp3', 'Old'),
      playlistItem(QID_NEW, 'new.mp3', 'New'),
    ]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setResidentFile(QID_OLD, 0, 'old.mp3');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 7, queueItemId: QID_NEW, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(7);
    expect(getState('playback.activity')).not.toBe('playing');
  });
});

// ─── handlePlayMsg orphaned-pipeline recovery ──────────────────────
// A mode switch can end an inbound pipeline while leaving the selected index.
// A later PLAY must request the current file because no live pipeline can
// consume pendingPlayTime and sync bootstrap requires a buffer.

describe('handlePlayMsg orphaned-pipeline recovery', () => {
  it('keeps PLAY pending and requests the persistent PRO file when PLAY wins the race', async () => {
    const exactHostSend = vi.fn();
    const hostConn = dataConnection('pro-coordinator', exactHostSend);
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    setState('playlist.items', [playlistItem(QID_NEW, 'persistent.flac', 'Persistent')]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setCurrentAudioBuffer(null);
    registerProRoomMediaHooks(persistentProMediaHooks(QID_NEW));

    initPlayback();
    await handleData(
      { type: MSG.PLAY, time: 18, queueItemId: QID_NEW, name: 'persistent.flac' },
      hostConn,
    );

    expect(getPendingPlayTime()).toBe(18);
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: QID_NEW,
      name: 'persistent.flac',
      reason: 'pro_room_no_buffer',
    });
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('requests the current file when PLAY arrives with no buffer and no inbound pipeline', async () => {
    const exactHostSend = vi.fn();
    const hostConn = dataConnection('host-1', exactHostSend);
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      playlistItem(QID_OLD, 'old.mp3', 'Old'),
      playlistItem(QID_NEW, 'new.mp3', 'New'),
    ]);
    setState('playlist.currentQueueItemId', QID_NEW);
    // lifecycle IDLE: the prior transfer was torn down, nothing inbound
    setCurrentAudioBuffer(null);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 30, queueItemId: QID_NEW, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(30);
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: QID_NEW,
      name: 'new.mp3',
      reason: 'no_buffer',
    });
  });

  it('does not fire the recovery request while a pipeline is inbound (DOWNLOADING)', async () => {
    const exactHostSend = vi.fn();
    const hostConn = dataConnection('host-1', exactHostSend);
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [playlistItem(QID_NEW, 'new.mp3', 'New')]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setCurrentAudioBuffer(null);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 30, queueItemId: QID_NEW, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(30);
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
  });

  // A live transfer state must suppress orphan recovery even if lifecycle
  // temporarily reads IDLE; restarting would discard partial progress.
  it('does not fire the recovery request while transfer.state is RECEIVING even if lifecycle reads IDLE', async () => {
    const exactHostSend = vi.fn();
    const hostConn = dataConnection('host-1', exactHostSend);
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [playlistItem(QID_NEW, 'new.mp3', 'New')]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setCurrentAudioBuffer(null);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 30, queueItemId: QID_NEW, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(30);
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
  });

  it('does not reopen an occurrence this device already failed to decode', async () => {
    const exactHostSend = vi.fn();
    const hostConn = dataConnection('host-1', exactHostSend);
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [playlistItem(QID_NEW, 'unsupported.flac', 'Unsupported')]);
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('playback.lifecycle', PLAYBACK_STATE.FAILED);
    const { markTrackFailed } = await import('../_state.ts');
    markTrackFailed(`queue:${QID_NEW}`);

    initPlayback();
    await handleData(
      { type: MSG.PLAY, time: 30, queueItemId: QID_NEW, name: 'unsupported.flac' },
      hostConn,
    );

    expect(getPendingPlayTime()).toBeUndefined();
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
  });
});

describe('updatePlayState', () => {
  it('emits ui:update-play-state with true', () => {
    const handler = vi.fn();
    bus.on('ui:update-play-state', handler);

    updatePlayState(true);

    expect(handler).toHaveBeenCalledWith(true);
  });

  it('emits ui:update-play-state with false', () => {
    const handler = vi.fn();
    bus.on('ui:update-play-state', handler);

    updatePlayState(false);

    expect(handler).toHaveBeenCalledWith(false);
  });
});

describe('late-join playback bootstrap', () => {
  function emitPeerConnected(send = vi.fn()): typeof send {
    bus.emit('network:peer-connected', { open: true, send } as unknown as DataConnection);
    return send;
  }

  it('sends file PLAY bootstrap without legacy state payload', () => {
    initPlayback();
    setPlaybackFilePlaying();
    setState('playlist.currentQueueItemId', QID_OLD);
    setState('playlist.items', [playlistItem(QID_OLD, 'song.mp3')]);
    setResidentFile(QID_OLD, 0, 'song.mp3');

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        queueItemId: QID_OLD,
        name: 'song.mp3',
      }),
    );
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('state');
  });

  it('lets demo mode own late-join playback bootstrap', () => {
    initPlayback();
    setPlaybackFilePlaying();
    setState('demo.active', true);
    setState('playlist.currentQueueItemId', QID_OLD);
    setState('playlist.items', [playlistItem(QID_OLD, 'demo.mp3')]);

    const send = emitPeerConnected();

    expect(send).not.toHaveBeenCalled();
  });

  it('sends file PAUSE bootstrap with pause reason but no legacy state payload', () => {
    initPlayback();
    setPlaybackFilePaused();
    setState('playlist.currentQueueItemId', QID_NEW);
    setState('playlist.items', [playlistItem(QID_NEW, 'song.mp3')]);
    setState('player.pausedAt', 42);

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        queueItemId: QID_NEW,
        reason: 'pause',
        time: 42,
      }),
    );
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('state');
  });

  it('sends system audio bootstrap without file playback payloads', () => {
    initPlayback();
    setPlaybackSystemAudioPlaying();

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: MSG.SYSTEM_AUDIO_START });
  });

  it('does not bootstrap system audio to the fifth device', () => {
    initPlayback();
    setPlaybackSystemAudioPlaying();
    setState(
      'network.connectedPeers',
      Array.from({ length: MAX_SYSTEM_AUDIO_DEVICES }, (_, index) => connectedPeer(index + 1)),
    );

    const send = emitPeerConnected();

    expect(send).not.toHaveBeenCalled();
  });
});
