/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import {
  consumePendingAutoSyncOnReady,
  getPendingAutoSyncOnReady,
  setPendingAutoSyncOnReady,
} from '../../youtube/player.ts';
import { setPlaybackYouTubePlaying } from '../ownership.ts';
import {
  setRepeatMode,
  setShuffle,
  getShuffleNextPlayableIndex,
  advanceToShuffleNextIndex,
  advanceToShufflePreviousIndex,
  clearPreloadState,
  initPlaylist,
  playNextTrack,
  playPrevTrack,
  playTrack,
} from '../playlist.ts';
import { broadcastFileDebounced } from '../../storage/transfer.ts';
import { getCurrentLoadEpoch, setCurrentAudioBuffer } from '../_state.ts';
import { initDecodeHandlers } from '../decode.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

beforeEach(() => {
  vi.restoreAllMocks();
  resetState();
  bus.clear();
  setPendingAutoSyncOnReady(false);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: null,
    isOp,
    preloadedIndexes: new Set<number>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

describe('setRepeatMode', () => {
  it('sets repeat mode 0 (off)', () => {
    setRepeatMode(0, false);
    expect(getState('playlist.repeatMode')).toBe(0);
  });

  it('sets repeat mode 1 (all)', () => {
    setRepeatMode(1, false);
    expect(getState('playlist.repeatMode')).toBe(1);
  });

  it('sets repeat mode 2 (one)', () => {
    setRepeatMode(2, false);
    expect(getState('playlist.repeatMode')).toBe(2);
  });
});

describe('setShuffle', () => {
  it('enables shuffle', () => {
    setShuffle(true, false);
    expect(getState('playlist.isShuffle')).toBe(true);
  });

  it('disables shuffle', () => {
    setShuffle(false, false);
    expect(getState('playlist.isShuffle')).toBe(false);
  });
});

describe('shuffle row order helpers', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'c.mp3', videoId: null, playlistId: null },
    ]);
  });

  it('finds the next playable row without falling back to a fresh random pick', () => {
    setState('playlist.currentTrackIndex', 1);
    setRepeatMode(0, false);
    setShuffle(true, false);

    expect(getShuffleNextPlayableIndex((idx) => idx !== 2)).toBe(-1);

    setRepeatMode(1, false);
    expect(getShuffleNextPlayableIndex((idx) => idx !== 2)).toBe(0);
  });

  it('wraps previous row navigation through the same shuffle order', () => {
    setState('playlist.currentTrackIndex', 0);
    setRepeatMode(1, false);
    setShuffle(true, false);

    expect(advanceToShufflePreviousIndex()).toBe(2);
  });

  it('advances next row and reshuffles at repeat-all pass end', () => {
    setState('playlist.currentTrackIndex', 2);
    setRepeatMode(1, false);
    setShuffle(true, false);

    expect(advanceToShuffleNextIndex()).toBe(0);
  });
});

describe('playNext/playPrev mode-branch parity', () => {
  function setupModeBranch(owner: 'file' | 'youtube', currentIndex: number): void {
    resetState();
    bus.clear();
    setPendingAutoSyncOnReady(false);
    setState('player.isFirstTrackLoad', false);
    setState('playlist.currentTrackIndex', currentIndex);
    setState(
      'playlist.items',
      owner === 'youtube'
        ? [
            { type: 'youtube', name: 'A', videoId: 'VIDEO_AAAAA', playlistId: null },
            { type: 'youtube', name: 'B', videoId: 'VIDEO_BBBBB', playlistId: null },
            { type: 'youtube', name: 'C', videoId: 'VIDEO_CCCCC', playlistId: null },
          ]
        : [
            { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
            { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
            { type: 'file', name: 'c.mp3', videoId: null, playlistId: null },
          ],
    );
    setRepeatMode(1, false);
    setShuffle(true, false);

    if (owner === 'youtube') {
      setPlaybackYouTubePlaying();
      bus.on('youtube:try-next-internal', (done: (success: boolean) => void) => done(false));
      bus.on('youtube:try-prev-internal', (done: (success: boolean) => void) => done(false));
      bus.on('youtube:load', () => {});
    }
  }

  it('shuffle Next chooses the same next row in local and YouTube fallback branches', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    setupModeBranch('file', 1);
    playNextTrack();
    const localNext = getState('playlist.currentTrackIndex');

    setupModeBranch('youtube', 1);
    playNextTrack();
    const youtubeNext = getState('playlist.currentTrackIndex');

    expect(localNext).toBe(2);
    expect(youtubeNext).toBe(localNext);
  });

  it('shuffle Prev wraps the same previous row in local and YouTube fallback branches', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    setupModeBranch('file', 0);
    playPrevTrack();
    const localPrev = getState('playlist.currentTrackIndex');

    setupModeBranch('youtube', 0);
    playPrevTrack();
    const youtubePrev = getState('playlist.currentTrackIndex');

    expect(localPrev).toBe(2);
    expect(youtubePrev).toBe(localPrev);
  });
});

describe('clearPreloadState', () => {
  it('resets preload.nextTrackIndex to -1', () => {
    setRepeatMode(0, false); // ensure state initialized
    clearPreloadState();
    expect(getState('preload.nextTrackIndex')).toBe(-1);
  });
});

describe('playTrack YouTube auto-rendezvous', () => {
  it('keeps pending auto-sync armed after fresh non-YouTube -> YouTube load cleanup', async () => {
    setState('player.isFirstTrackLoad', false);
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      { type: 'file', name: 'local.mp3', videoId: null, playlistId: null },
      { type: 'youtube', name: 'Video', videoId: 'VIDEO_ID_01', playlistId: null },
    ]);

    bus.on('youtube:stop-mode', () => setPendingAutoSyncOnReady(false));
    bus.on('player:stop-all-media', () => {
      bus.emit('youtube:stop-mode', { silent: false });
    });
    bus.on('youtube:load', () => {
      bus.emit('player:stop-all-media');
    });

    await playTrack(1);

    expect(getPendingAutoSyncOnReady()).toBe(true);
    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      isTrackTransition: false,
      targetTime: 0,
      subIndex: 0,
      videoId: 'VIDEO_ID_01',
      skipSeek: true,
    });
  });

  it('marks YouTube-to-YouTube loads as track transitions', async () => {
    setPlaybackYouTubePlaying();
    setState('player.isFirstTrackLoad', false);
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      { type: 'youtube', name: 'Old Video', videoId: 'OLD_VIDEO_01', playlistId: null },
      { type: 'youtube', name: 'New Video', videoId: 'NEW_VIDEO_01', playlistId: null },
    ]);

    bus.on('youtube:load', () => {});

    await playTrack(1);

    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      isTrackTransition: true,
      targetTime: 0,
      subIndex: 0,
      videoId: 'NEW_VIDEO_01',
      skipSeek: true,
    });
  });

  it('broadcasts the requested YouTube playlist sub-index on playTrack', async () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    setState('player.isFirstTrackLoad', false);
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      {
        type: 'youtube',
        name: 'Playlist',
        title: 'Playlist',
        videoId: 'entryVideo',
        playlistId: 'playlist-1',
      },
    ]);
    setState('youtube.subItemsMap', {
      'playlist-1': {
        ids: ['firstVideo', 'secondVideo'],
        titles: ['First', 'Second'],
      },
    });

    bus.on('youtube:load', () => {});

    await playTrack(0, 1);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_PLAY,
        videoId: 'secondVideo',
        playlistId: 'playlist-1',
        index: 0,
        subIndex: 1,
      }),
    );
  });

  it('drops a local-file broadcast parked in the debounce window when switching to YouTube', async () => {
    // local→YouTube inside the 300ms send-debounce window: without
    // cancelPendingBroadcast in the YouTube branch, the timer fires after the
    // switch and pumps the full superseded local file to guests during
    // YouTube playback (guest handleFileStart has no mode gate).
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = {
      peer: 'guest-1',
      open: true,
      send,
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [
      { ...makeConnectedPeer('guest-1', false), conn, connectionType: 'local' },
    ]);
    setState('player.isFirstTrackLoad', false);
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      { type: 'file', name: 'local.mp3', videoId: null, playlistId: null },
      { type: 'youtube', name: 'Video', videoId: 'VIDEO_ID_01', playlistId: null },
    ]);
    bus.on('youtube:load', () => {});

    // Arm the send-side debounce exactly as decode.ts does after a local decode.
    broadcastFileDebounced(new File(['abc'], 'local.mp3', { type: 'audio/mpeg' }), 1, {
      type: MSG.FILE_PREPARE,
      name: 'local.mp3',
      index: 0,
      sessionId: 1,
      mime: 'audio/mpeg',
    });

    await playTrack(1);
    await vi.advanceTimersByTimeAsync(301);

    // The pending local-file announce + chunk stream never fire...
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    // ...while the YouTube switch itself still reached the guest.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.YOUTUBE_PLAY }));
  });
});

describe('remove-track playlist-empty teardown supersedes in-flight loads', () => {
  // Removing the ONLY track can land inside that track's own decode window
  // (click → remove within 0.1–10s). The empty branch must bump the load
  // epoch (stopAllMedia({cancelInFlight:true})) so the resolving decode dies
  // at its epoch checkpoint instead of resurrecting the deleted track —
  // blob/meta(index -1) republish, play re-enable, FILE_START(-1) broadcast,
  // audible autoplay. The inert-decode half is pinned in decode.test.ts.
  it('bumps the load epoch when the last track is removed', () => {
    initPlaylist();
    setState('playlist.items', [
      { type: 'file', name: 'only.mp3', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 0);

    const before = getCurrentLoadEpoch();
    bus.emit('playlist:remove-track', 0);

    expect(getState('playlist.items')).toHaveLength(0);
    expect(getState('playlist.currentTrackIndex')).toBe(-1);
    expect(getCurrentLoadEpoch()).toBe(before + 1);
  });

  it('does NOT bump the epoch when a non-current track is removed (live load must survive)', () => {
    initPlaylist();
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 0);

    const before = getCurrentLoadEpoch();
    bus.emit('playlist:remove-track', 1);

    expect(getState('playlist.items')).toHaveLength(1);
    expect(getCurrentLoadEpoch()).toBe(before);
  });
});

describe('late-join playlist bootstrap', () => {
  it('marks repeat and shuffle mode frames as bootstrap so guests do not toast', () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    initPlaylist();
    setState('playlist.repeatMode', 2);
    setState('playlist.isShuffle', false);
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 1);

    bus.emit('network:peer-connected', conn);

    expect(send).toHaveBeenCalledWith({ type: MSG.REPEAT_MODE, value: 2, _bootstrap: true });
    expect(send).toHaveBeenCalledWith({
      type: MSG.SHUFFLE_MODE,
      value: false,
      _bootstrap: true,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAYLIST_UPDATE, currentTrackIndex: 1 }),
    );
  });
});

describe('decode-fail advance respects end-of-playlist (mode parity)', () => {
  // The failure-skip walk must honor the repeat mode the way every sibling
  // path does: shuffle stops at pass end, natural sequential end stops, so a
  // last-track decode failure with repeat OFF must end the playlist instead
  // of restarting the whole room from track 0. Repeat ALL keeps the wrap.
  // Driven through the OP guest-decode-failed report, which reaches the same
  // markFailedAndAdvance walk the host's own decode failures use.
  function setupOpReporter(): ReturnType<typeof vi.fn> {
    const send = vi.fn();
    const conn = { peer: 'guest-op', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-op', true), conn }]);
    initDecodeHandlers();
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'c.mp3', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 2);
    return send;
  }

  it('repeat OFF: last-track failure ends the playlist instead of wrapping to track 0', async () => {
    vi.useFakeTimers();
    const send = setupOpReporter();
    setRepeatMode(0, false);

    const opConn = getState('network.connectedPeers')[0].conn!;
    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 2 }, opConn);
    await vi.advanceTimersByTimeAsync(700);

    expect(getState('playlist.currentTrackIndex')).toBe(-1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PAUSE, endOfPlaylist: true }),
    );
  });

  it('repeat ALL: last-track failure still wraps the advance to track 0', async () => {
    vi.useFakeTimers();
    setupOpReporter();
    setRepeatMode(1, false);

    const opConn = getState('network.connectedPeers')[0].conn!;
    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 2 }, opConn);
    await vi.advanceTimersByTimeAsync(700);

    expect(getState('playlist.currentTrackIndex')).toBe(0);
  });
});

describe('repeat-one ended-advance after a mid-window removal (SA-12)', () => {
  it('broadcasts the index read at FIRE time, not the captured one', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    initPlaylist();
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'c.mp3', videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 2);
    setRepeatMode(2, false);

    bus.emit('player:ended');
    // A non-current track removal during the 300ms window shifts the
    // current index down — the replay broadcast must follow it.
    setState('playlist.currentTrackIndex', 1);
    await vi.advanceTimersByTimeAsync(320);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAY, time: 0, index: 1 }),
    );
  });
});

describe('fast-replay autoPlayTimer fire-time index (F-2404)', () => {
  it('broadcasts the index read at FIRE time, not the click-time captured one', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    initPlaylist();

    // Host (no hostConn) re-clicks the currently-playing local file at index 2.
    const file = new File([new Uint8Array([1, 2, 3])], 'c.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', videoId: null, playlistId: null },
      { type: 'file', name: 'c.mp3', file, videoId: null, playlistId: null },
    ]);
    setState('playlist.currentTrackIndex', 2);
    setState('player.isFirstTrackLoad', false);
    // Satisfy the same-track fast-replay gate: a resident buffer whose active
    // name matches the clicked track.
    setState('transfer.meta', { name: 'c.mp3', type: 'audio/mpeg', index: 2 });
    setCurrentAudioBuffer({} as AudioBuffer);

    await playTrack(2);
    send.mockClear(); // drop the immediate FILE_PREPARE; only the delayed PLAY matters

    // A lower-index removal during the 3s replay window shifts the current
    // index down. Park the FSM busy so the fire-time play(0) defers (no audio
    // graph in node env) while the replay broadcast still fires.
    setState('playlist.currentTrackIndex', 1);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    await vi.advanceTimersByTimeAsync(3000);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAY, time: 0, index: 1, name: 'c.mp3' }),
    );
  });
});

describe('request-setting authorization', () => {
  beforeEach(() => {
    initPlaylist();
  });

  it('lets demo non-operators use only the settings exposed by demo UI', async () => {
    const conn = makeConnection('guest-demo');
    setState('demo.active', true);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.VBASS, value: 60 }, conn);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.6);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.EXCITER, value: 1 }, conn);
    expect(getState('audio.exciter')).toBe(true);

    await handleData(
      { type: MSG.REQUEST_SETTING, settingType: MSG.STEREO_WIDTH, value: 120 },
      conn,
    );
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.2);

    const beforeDecay = getState('audio.reverbDecay');
    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);
    expect(getState('audio.reverbDecay')).toBe(beforeDecay);
  });

  it('still allows operators to apply full request-setting effects', async () => {
    const conn = makeConnection('guest-op');
    setState('network.connectedPeers', [
      ...getState('network.connectedPeers'),
      makeConnectedPeer(conn.peer, true),
    ]);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);

    expect(getState('audio.reverbDecay')).toBe(8);
  });
});
