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
vi.mock('../../network/peer.ts', () => ({ safeSend: mocks.safeSend }));

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
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
import { PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER } from '../local-offset.ts';
import { initYouTubeNativeControlAuthority } from '../native-control-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'abcdefghijk';

interface CallbackPlayer extends YouTubePlayerInstance {
  deliverState(state: number): void;
}

function createPlayer(): CallbackPlayer {
  let state = 1;
  let position = 42.25;
  // Plain functions are intentional: vi.fn player methods bypass production
  // native-control instrumentation. Commands also stay asynchronous, as the
  // IFrame API does; only a delivered callback changes its reported state.
  return {
    playVideo: () => undefined,
    pauseVideo: () => undefined,
    loadVideoById: () => undefined,
    loadPlaylist: () => undefined,
    cueVideoById: () => undefined,
    cuePlaylist: () => undefined,
    stopVideo: () => undefined,
    destroy: () => undefined,
    seekTo: (seconds) => {
      position = seconds;
    },
    getCurrentTime: () => position,
    getDuration: () => 300,
    getPlayerState: () => state,
    getPlaylistIndex: () => -1,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [],
    setVolume: () => undefined,
    deliverState(next) {
      state = next;
      // Match iframe.ts projection: BUFFERING does not change activity;
      // PAUSED and PLAYING synchronously reach the native-authority listener.
      if (next === 2) setPlaybackYouTubePaused();
      if (next === 1) setPlaybackYouTubePlaying();
    },
  };
}

function installCurrentYouTube(player: CallbackPlayer, room: 'standard' | 'pro'): void {
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  if (room === 'pro') {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
  }
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      title: 'Video',
      videoId: VIDEO_ID,
      playlistId: null,
    } as PlaylistItem,
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setYouTubePlayer(player);
  markYtPlayerReady(player);
  setYtAutoplayIntent(true);
  setPlaybackYouTubePlaying();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  bus.clear();
  resetState();
  resetYouTubeModuleState();
  setLocalYouTubePaused(false);
  vi.clearAllMocks();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('seek callback ownership at the native-control boundary', () => {
  it.each(['standard', 'pro'] as const)(
    'does not promote a PAUSED/PLAYING seek callback trace during a %s local nudge',
    (room) => {
      const player = createPlayer();
      installCurrentYouTube(player, room);
      const autoPlay = vi.fn();
      bus.on('youtube:auto-play', autoPlay);
      setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, () => undefined, 7_000);

      player.seekTo(42.35, true);
      vi.advanceTimersByTime(100);
      player.deliverState(3);
      vi.advanceTimersByTime(100);
      player.deliverState(2);
      vi.advanceTimersByTime(100);
      player.deliverState(1);

      expect(autoPlay).not.toHaveBeenCalled();
      expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
      expect(mocks.safeSend).not.toHaveBeenCalled();
    },
  );

  it('does not promote a seek PLAYING callback while a host rendezvous owns playback', () => {
    const player = createPlayer();
    installCurrentYouTube(player, 'standard');
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    setManagedTimer('yt-auto-sync', () => undefined, 2_000);

    player.pauseVideo();
    player.seekTo(45, true);
    vi.advanceTimersByTime(100);
    player.deliverState(2);
    expect(autoPlay).not.toHaveBeenCalled();
    // A PLAYING straggler during the seek-buffer window precedes the
    // scheduled playVideo. It is part of that operation, not a new OS PLAY.
    vi.advanceTimersByTime(100);
    player.deliverState(3);
    vi.advanceTimersByTime(100);
    player.deliverState(1);

    expect(autoPlay).not.toHaveBeenCalled();
  });

  it.each([
    PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
    'yt-auto-sync',
    'yt-clock-action',
    'yt-seek-play',
    'yt-rendezvous-buffer',
    'yt-rendezvous-play',
    'yt-rendezvous-calibrate',
  ])('restores native PAUSE immediately after %s releases playback', (owner) => {
    const player = createPlayer();
    installCurrentYouTube(player, 'standard');
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    setManagedTimer(owner, () => undefined, 2_000);
    player.seekTo(42.35, true);
    player.deliverState(2);
    player.deliverState(1);
    expect(autoPlay).not.toHaveBeenCalled();

    clearManagedTimer(owner);
    player.deliverState(2);

    expect(autoPlay).toHaveBeenCalledExactlyOnceWith({
      targetTime: 42.35,
      skipSeek: false,
      zeroStart: false,
      state: 2,
    });
  });

  it.each(['standard', 'pro'] as const)(
    'does not swallow a native %s PAUSE when a completed seek never emitted PAUSED',
    (room) => {
      const player = createPlayer();
      installCurrentYouTube(player, room);
      const autoPlay = vi.fn();
      bus.on('youtube:auto-play', autoPlay);
      setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, () => undefined, 500);
      player.seekTo(42.35, true);
      player.deliverState(3);
      player.deliverState(1);
      vi.advanceTimersByTime(500);

      player.deliverState(2);

      if (room === 'standard') {
        expect(autoPlay).toHaveBeenCalledOnce();
        expect(autoPlay.mock.calls[0][0].state).toBe(2);
      } else {
        expect(mocks.routeProPlaybackCommand).toHaveBeenCalledExactlyOnceWith(
          { kind: 'pause', queueItemId: QUEUE_ITEM_ID, positionSeconds: 42.35 },
          { wasPlaying: true },
        );
      }
    },
  );
});
