/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routeProPlaybackCommand: vi.fn(() => true),
  safeSend: vi.fn(() => true),
  runBackgroundStopSync: vi.fn((_hiddenMs: number) => undefined),
}));

vi.mock('../../pro-room/playback-authority-hooks.ts', () => ({
  routeProPlaybackCommand: mocks.routeProPlaybackCommand,
}));

vi.mock('../../network/peer.ts', () => ({
  safeSend: mocks.safeSend,
}));

vi.mock('../../player/background-return-sync.ts', () => ({
  runBackgroundStopSync: mocks.runBackgroundStopSync,
}));

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  isLocalYouTubePaused,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { BACKGROUND_STOP_RETURN_GRACE_MS } from '../constants.ts';
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

  it.each([
    { room: 'standard', visibility: 'visible', published: true, endsProRejoin: false },
    { room: 'standard', visibility: 'hidden', published: false, endsProRejoin: false },
    { room: 'pro', visibility: 'visible', published: false, endsProRejoin: true },
    { room: 'pro', visibility: 'hidden', published: false, endsProRejoin: false },
  ] as const)(
    'records a $visibility $room listener iframe PAUSE as a local pause, published as intent: $published',
    ({ room, visibility, published, endsProRejoin }) => {
      // WebKit stops a hidden iframe by itself; only a visible PAUSE is the
      // participant's own, like a lock-screen or media-key PAUSE. A PRO
      // listener keeps its iframe PLAY able to rejoin, so no intent is
      // published; its visible PAUSE only ends a pending rejoin (P4-D7 B).
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
      try {
        const player = createPlayer();
        if (room === 'pro') {
          setState('room.context', {
            kind: 'pro',
            roomId: '000001',
            role: 'member',
            coordinatorId: null,
            epoch: 7,
            snapshotRevision: 11,
            capabilities: [],
          });
        } else {
          setState('network.appRole', 'guest');
          setState('network.hostConn', { open: true, peer: 'host', send: vi.fn() } as never);
          setState('network.isOperator', false);
          setState('network.standardRoomCapabilities', []);
        }
        installCurrentYouTube(player);
        const localPause = vi.fn();
        bus.on('youtube:set-local-paused', localPause);
        const proRejoinEnd = vi.fn();
        bus.on('youtube:pro-listener-visible-pause', proRejoinEnd);

        player.state = 2;
        setPlaybackYouTubePaused();

        expect(isLocalYouTubePaused()).toBe(true);
        if (published) expect(localPause).toHaveBeenCalledExactlyOnceWith(true);
        else expect(localPause).not.toHaveBeenCalled();
        expect(proRejoinEnd).toHaveBeenCalledTimes(endsProRejoin ? 1 : 0);
        expect(mocks.safeSend).not.toHaveBeenCalled();
      } finally {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    },
  );

  describe('a Standard listener iframe PAUSE around a return from hidden (RO-05)', () => {
    function showPage(visibility: DocumentVisibilityState): void {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    function installStandardListener(): FakePlayer {
      const player = createPlayer();
      setState('network.appRole', 'guest');
      setState('network.hostConn', { open: true, peer: 'host', send: vi.fn() } as never);
      setState('network.isOperator', false);
      setState('network.standardRoomCapabilities', []);
      installCurrentYouTube(player);
      return player;
    }

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(document, 'visibilityState');
    });

    it.each([
      { processed: 'while hidden', afterReturnMs: null, browserStop: true },
      { processed: 'at the return', afterReturnMs: 0, browserStop: true },
      {
        processed: 'just inside the grace',
        afterReturnMs: BACKGROUND_STOP_RETURN_GRACE_MS - 1,
        browserStop: true,
      },
      {
        processed: 'at the end of the grace',
        afterReturnMs: BACKGROUND_STOP_RETURN_GRACE_MS,
        browserStop: false,
      },
    ] as const)(
      'takes a PAUSE processed $processed for the browser stop: $browserStop',
      async ({ afterReturnMs, browserStop }) => {
        vi.useFakeTimers();
        showPage('visible');
        const player = installStandardListener();
        const pauseIntent = vi.fn();
        bus.on('youtube:set-local-paused', pauseIntent);

        showPage('hidden');
        vi.advanceTimersByTime(800);
        if (afterReturnMs === null) {
          player.state = 2;
          setPlaybackYouTubePaused();
          expect(mocks.runBackgroundStopSync).not.toHaveBeenCalled();
        }
        showPage('visible');
        if (afterReturnMs !== null) {
          vi.advanceTimersByTime(afterReturnMs);
          player.state = 2;
          setPlaybackYouTubePaused();
        }
        await vi.dynamicImportSettled();

        expect(isLocalYouTubePaused()).toBe(true);
        if (browserStop) {
          // Handed once to the return with the hidden time; no pause intent.
          expect(mocks.runBackgroundStopSync).toHaveBeenCalledExactlyOnceWith(800);
          expect(pauseIntent).not.toHaveBeenCalled();
        } else {
          expect(mocks.runBackgroundStopSync).not.toHaveBeenCalled();
          expect(pauseIntent).toHaveBeenCalledExactlyOnceWith(true);
        }
      },
    );

    it('takes a visible PAUSE without an observed hidden period for the participant pause', async () => {
      vi.useFakeTimers();
      showPage('visible');
      const player = installStandardListener();
      const pauseIntent = vi.fn();
      bus.on('youtube:set-local-paused', pauseIntent);

      // A visibility event that ends no hidden period opens no grace.
      showPage('visible');
      player.state = 2;
      setPlaybackYouTubePaused();
      await vi.dynamicImportSettled();

      expect(mocks.runBackgroundStopSync).not.toHaveBeenCalled();
      expect(pauseIntent).toHaveBeenCalledExactlyOnceWith(true);
    });
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
