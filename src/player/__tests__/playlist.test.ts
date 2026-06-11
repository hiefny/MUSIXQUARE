/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
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
  playTrack,
} from '../playlist.ts';
import { broadcastFileDebounced } from '../../storage/transfer.ts';
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
    getState('network.connectedPeers').push(makeConnectedPeer(conn.peer, true));

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);

    expect(getState('audio.reverbDecay')).toBe(8);
  });
});
