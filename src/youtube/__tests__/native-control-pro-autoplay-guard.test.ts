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
import type { PlaylistItem, QueueItemId, RoomCapability } from '../../types/index.ts';
import {
  getYtAutoplayIntent,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  initYouTubeNativeControlAuthority,
  preserveNativeProControllerPlayBeforeAutoplayGuard,
} from '../native-control-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'abcdefghijk';

interface FakePlayer extends YouTubePlayerInstance {
  state: number;
}

function createPlayer(initialState = 2): FakePlayer {
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

function installPausedYouTube(player: FakePlayer, capabilities: RoomCapability[]): void {
  const item = {
    queueItemId: QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: VIDEO_ID,
    playlistId: null,
  } as PlaylistItem;
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 11,
    capabilities,
  });
  setState('playlist.items', [item]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(false);
  setPlaybackYouTubePaused();
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

describe('PRO iframe-native PLAY before the autoplay guard', () => {
  it('preserves a native administrator PLAY and then routes it to PRO authority', () => {
    const player = createPlayer();
    installPausedYouTube(player, ['playback.control']);

    // OS/headset changes the iframe internally, bypassing wrapped JS methods.
    player.state = 1;

    expect(preserveNativeProControllerPlayBeforeAutoplayGuard(player)).toBe(true);
    expect(getYtAutoplayIntent()).toBe(true);

    // This is the normal projection performed later in the iframe callback.
    setPlaybackYouTubePlaying();

    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 42.25,
    });
  });

  it('keeps application-owned PLAY behind the existing pause-back guard', () => {
    const player = createPlayer();
    installPausedYouTube(player, ['playback.control']);

    // The instrumented method arms a programmatic PLAY expectation.
    player.playVideo();

    expect(preserveNativeProControllerPlayBeforeAutoplayGuard(player)).toBe(false);
    expect(getYtAutoplayIntent()).toBe(false);
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });

  it('does not grant a PRO listener room-wide playback authority', () => {
    const player = createPlayer();
    installPausedYouTube(player, []);
    player.state = 1;

    expect(preserveNativeProControllerPlayBeforeAutoplayGuard(player)).toBe(false);
    expect(getYtAutoplayIntent()).toBe(false);
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });
});
