/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routeProPlaybackCommand: vi.fn(() => true),
  safeSend: vi.fn(() => true),
}));

vi.mock('../../pro-room/playback-authority-hooks.ts', () => ({
  routeProPlaybackCommand: mocks.routeProPlaybackCommand,
}));

vi.mock('../../network/peer.ts', () => ({
  safeSend: mocks.safeSend,
}));

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { initYouTubeNativeControlAuthority } from '../native-control-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'abcdefghijk';

interface FakePlayer extends YouTubePlayerInstance {
  state: number;
}

function createPlayer(initialState = 1): FakePlayer {
  let state = initialState;
  return {
    get state() {
      return state;
    },
    set state(value: number) {
      state = value;
    },
    playVideo: () => {
      state = 1;
    },
    pauseVideo: () => {
      state = 2;
    },
    loadVideoById: () => {
      state = 1;
    },
    loadPlaylist: () => {
      state = 1;
    },
    cueVideoById: () => {
      state = 2;
    },
    cuePlaylist: () => {
      state = 2;
    },
    stopVideo: () => {
      state = 0;
    },
    destroy: () => undefined,
    seekTo: () => undefined,
    getCurrentTime: () => 42.25,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => 0,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [VIDEO_ID],
    setVolume: () => undefined,
  };
}

function installCurrentYouTube(player: FakePlayer): void {
  const item = {
    queueItemId: QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: VIDEO_ID,
    playlistId: null,
  } as PlaylistItem;
  setState('playlist.items', [item]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(true);
  setPlaybackYouTubePlaying();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
}

beforeEach(() => {
  clearAllManagedTimers();
  bus.clear();
  resetState();
  resetYouTubeModuleState();
  setLocalYouTubePaused(false);
  vi.clearAllMocks();
});

afterEach(() => {
  clearAllManagedTimers();
});

describe('iframe-native YouTube control authority', () => {
  it('promotes a standard-host native PAUSE to the room authority path', () => {
    const player = createPlayer();
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    installCurrentYouTube(player);
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);

    player.state = 2;
    setPlaybackYouTubePaused();

    expect(autoPlay).toHaveBeenCalledWith({
      targetTime: 42.25,
      skipSeek: false,
      zeroStart: false,
      state: 2,
    });
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });

  it('routes a PRO-controller native PAUSE through server authority', () => {
    const player = createPlayer();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
    installCurrentYouTube(player);

    player.state = 2;
    setPlaybackYouTubePaused();

    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith(
      {
        kind: 'pause',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 42.25,
      },
      { wasPlaying: true },
    );
  });

  it('does not promote an application-owned pauseVideo transition', () => {
    const player = createPlayer();
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    installCurrentYouTube(player);
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);

    player.pauseVideo();
    setPlaybackYouTubePaused();

    expect(autoPlay).not.toHaveBeenCalled();
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });
});
