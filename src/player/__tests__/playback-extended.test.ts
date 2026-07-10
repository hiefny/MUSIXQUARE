/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
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
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.mocked(broadcast).mockClear();
  vi.mocked(sendToHost).mockClear();
});

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
    setPlaybackFilePlaying();
    setPlayerNode({
      stop,
      disconnect,
      onended: vi.fn(),
      buffer: {} as AudioBuffer,
    } as unknown as AudioBufferSourceNode);

    initPlayback();
    await handleData({ type: MSG.PAUSE, time: 12, reason: 'stop' }, conn);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getState('player.pausedAt')).toBe(12);
    expect(getState('playback.activity')).toBe('paused');
  });
});

// ─── togglePlay end-of-track race ────────────────────────────────────

describe('togglePlay end-of-track race', () => {
  it('advances a pending natural-end transition instead of broadcasting stale play', async () => {
    setState('playlist.items', [
      {
        type: 'file',
        name: 'third.mp3',
        title: 'Third',
        videoId: null,
        playlistId: null,
      },
      {
        type: 'file',
        name: 'fourth.mp3',
        title: 'Fourth',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentTrackIndex', 0);
    setState('player.pausedAt', 0);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setManagedTimer('ended-advance-next', () => {}, 30_000);

    togglePlay();

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAY, index: 0 }),
    );

    await vi.dynamicImportSettled();

    expect(getState('playlist.currentTrackIndex')).toBe(1);
    expect(getManagedTimer('ended-advance-next')).toBeNull();
  });
});

// ─── updatePlayState ─────────────────────────────────────────────────

describe('togglePlay file pipeline guard', () => {
  it('ignores play while the next file is decoding even if an old buffer is still resident', () => {
    setState('playlist.items', [
      { type: 'file', name: 'old.mp3', title: 'Old', videoId: null, playlistId: null },
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 1);
    setState('player.pausedAt', 0);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    togglePlay();

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAY }));
    expect(getState('playback.activity')).not.toBe('playing');
  });
});

// ─── handleRequestPlay file pipeline guard ──────────────────────────
// Sibling of togglePlay's guard (4901b9cd): host receiving an OP guest's
// REQUEST_PLAY while its own file pipeline is preparing must not play the
// stale resident buffer + broadcast PLAY with the NEW track index.

describe('handleRequestPlay file pipeline guard', () => {
  it('drops OP REQUEST_PLAY while the next file is decoding', async () => {
    setState('playlist.items', [
      { type: 'file', name: 'old.mp3', title: 'Old', videoId: null, playlistId: null },
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 1);
    setState('player.pausedAt', 0);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const opConn = { open: true, peer: 'op-1' } as DataConnection;
    setState('network.connectedPeers', [
      {
        id: 'op-1',
        slot: 0,
        label: 'OP',
        isOp: true,
        conn: opConn,
        preloadedIndexes: new Set<number>(),
        status: 'connected',
        isDataTarget: true,
        joinOrder: 0,
        connectionType: 'unknown',
        lastHeartbeat: 0,
      } satisfies ConnectedPeer,
    ]);

    initPlayback();
    await handleData({ type: MSG.REQUEST_PLAY, time: 0 }, opConn);

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.PLAY }));
  });
});

// ─── handlePlayMsg lifecycle gate (DOWNLOADING/DECODING defer) ──────
// Sibling of the AWAITING_PRELOAD branch: a host PLAY broadcast that
// arrives while the guest's own pipeline is still preparing must defer
// to pendingPlayTime instead of replaying the previous track's buffer.

describe('handlePlayMsg lifecycle gate', () => {
  it('defers play time when host PLAY arrives during DECODING', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('playlist.items', [
      { type: 'file', name: 'old.mp3', title: 'Old', videoId: null, playlistId: null },
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 1);
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 42, index: 1, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(42);
    expect(getState('playback.activity')).not.toBe('playing');
  });

  it('defers play time when host PLAY arrives during DOWNLOADING', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('playlist.items', [
      { type: 'file', name: 'old.mp3', title: 'Old', videoId: null, playlistId: null },
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 1);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 7, index: 1, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(7);
    expect(getState('playback.activity')).not.toBe('playing');
  });
});

// ─── handlePlayMsg orphaned-pipeline recovery (SA-03) ────────────────
// A mode switch (e.g. system-audio session) can kill an in-flight download:
// chunks get dropped via the external-owner gate, and after the mode ends
// the guest sits with no buffer, lifecycle IDLE, and an index that matches
// the host's. A later plain PLAY used to only store pendingPlayTime — with
// no inbound pipeline and no SYNC_PONG bootstrap (needs a buffer), the
// guest stayed silent until the host changed tracks.

describe('handlePlayMsg orphaned-pipeline recovery', () => {
  it('requests the current file when PLAY arrives with no buffer and no inbound pipeline', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      { type: 'file', name: 'old.mp3', title: 'Old', videoId: null, playlistId: null },
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 1);
    // lifecycle IDLE: the prior transfer was torn down, nothing inbound
    setCurrentAudioBuffer(null);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 30, index: 1, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(30);
    expect(sendToHost).toHaveBeenCalledWith({
      type: MSG.REQUEST_CURRENT_FILE,
      name: 'new.mp3',
      index: 1,
      reason: 'no_buffer',
    });
  });

  it('does not fire the recovery request while a pipeline is inbound (DOWNLOADING)', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 0);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    setCurrentAudioBuffer(null);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 30, index: 0, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(30);
    expect(sendToHost).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
  });

  // DV-1 belt (device-test find): the lifecycle FSM was disengaged (IDLE)
  // during fresh downloads, so PLAY mid-transfer hit this branch and the
  // host's unicast-from-0 response reset the partial download to 0%. Even
  // with the FSM fix, a LIVE transfer.state must keep SA-03 inert.
  it('does not fire the recovery request while transfer.state is RECEIVING even if lifecycle reads IDLE', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      { type: 'file', name: 'new.mp3', title: 'New', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 0);
    setState('playback.lifecycle', PLAYBACK_STATE.IDLE);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setCurrentAudioBuffer(null);

    initPlayback();
    await handleData({ type: MSG.PLAY, time: 30, index: 0, name: 'new.mp3' }, hostConn);

    expect(getPendingPlayTime()).toBe(30);
    expect(sendToHost).not.toHaveBeenCalledWith(
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
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      { type: 'file', name: 'song.mp3', videoId: null, playlistId: null },
    ]);

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        index: 0,
        name: 'song.mp3',
      }),
    );
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('state');
  });

  it('lets demo mode own late-join playback bootstrap', () => {
    initPlayback();
    setPlaybackFilePlaying();
    setState('demo.active', true);
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      { type: 'file', name: 'demo.mp3', videoId: null, playlistId: null },
    ]);

    const send = emitPeerConnected();

    expect(send).not.toHaveBeenCalled();
  });

  it('sends file PAUSE bootstrap with pause reason but no legacy state payload', () => {
    initPlayback();
    setPlaybackFilePaused();
    setState('playlist.currentTrackIndex', 1);
    setState('player.pausedAt', 42);

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        index: 1,
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
});
