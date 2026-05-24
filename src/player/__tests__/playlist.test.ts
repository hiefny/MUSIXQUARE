/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
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
  clearPreloadState,
  initPlaylist,
  playTrack,
} from '../playlist.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
  setPendingAutoSyncOnReady(false);
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
