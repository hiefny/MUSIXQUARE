/**
 * @vitest-environment jsdom
 *
 * Every control entry point that can start file playback must drop the action
 * while the pipeline is preparing (DOWNLOADING / AWAITING_PRELOAD / DECODING) — the
 * resident AudioBuffer still belongs to the PREVIOUS track during that
 * window, so playing would emit stale audio and broadcast the NEW index.
 *
 * If you add a new caller of transport.play() that can fire from user/
 * network input, add a case here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { transition } from '../lifecycle.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';
import { getPendingPlayTime, setCurrentAudioBuffer } from '../_state.ts';
import { play, seekTo, skipTime } from '../transport.ts';
import { playPrevTrack } from '../playlist.ts';
import { initPlayback } from '../playback.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';

function makeTrack(name: string): PlaylistItem {
  return { type: 'file', name, title: name, videoId: null, playlistId: null };
}

function makePeerWithSpy(id: string, isOp: boolean): { peer: ConnectedPeer; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const conn = { peer: id, open: true, send } as unknown as DataConnection;
  return {
    peer: {
      id,
      slot: 1,
      label: id,
      conn,
      isOp,
      preloadedIndexes: new Set<number>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
    },
    send,
  };
}

/** Enter a host track-change window with the previous file mode still active. */
function enterBusyWindow(index = 1, name = 'next.mp3'): void {
  transition({ type: 'FILE_PREPARE', variant: 'fresh', index, name });
  setPlaybackFilePlaying();
}

let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();

  const made = makePeerWithSpy('guest-op', true);
  send = made.send;
  setState('network.connectedPeers', [made.peer]);
  setState('playlist.items', [makeTrack('prev.mp3'), makeTrack('next.mp3')]);
  setState('playlist.currentTrackIndex', 1);
});

afterEach(() => {
  clearAllManagedTimers();
});

describe('busy-window guards (SA-04 family)', () => {
  it('seekTo drops the seek and broadcasts nothing while preparing', () => {
    enterBusyWindow();
    seekTo(42);
    expect(send).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(0);
  });

  it('skipTime drops the skip and broadcasts nothing while preparing', () => {
    enterBusyWindow();
    skipTime(10);
    expect(send).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(0);
  });

  it('handleRequestSeek (OP → host) drops the seek while preparing', async () => {
    initPlayback();
    enterBusyWindow();

    const opConn = getState('network.connectedPeers')[0].conn as DataConnection;
    await handleData({ type: MSG.REQUEST_SEEK, time: 42 }, opConn);

    expect(send).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(0);
  });

  it('playPrevTrack restart-current branch drops while preparing (first track)', () => {
    setState('playlist.currentTrackIndex', 0);
    enterBusyWindow(0, 'prev.mp3');
    playPrevTrack();
    expect(send).not.toHaveBeenCalled();
  });

  it('refresh-current-position does not restart the stale buffer while preparing', () => {
    initPlayback();
    enterBusyWindow();
    setCurrentAudioBuffer({ duration: 100 } as unknown as AudioBuffer);

    bus.emit('playback:refresh-current-position');

    // Listener must bail BEFORE play(): even the source-level deferral
    // (pendingPlayTime queue) must not be reached from this path.
    expect(getPendingPlayTime()).toBeUndefined();
  });

  it('play() itself defers to pendingPlayTime as a source-level safety net', async () => {
    enterBusyWindow();
    await play(7);
    expect(getPendingPlayTime()).toBe(7);
    expect(getState('player.startedAt')).toBe(0);
  });
});
