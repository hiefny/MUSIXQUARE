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

vi.mock('../../player/transport.ts', () => ({
  togglePlay: vi.fn(),
  stopPlayback: vi.fn(),
  skipTime: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
}));

import { MSG } from '../../core/constants.ts';
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
import { initMediaSession } from '../../player/media-session.ts';

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

function installPausedYouTube(player: FakePlayer): void {
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
  setYtAutoplayIntent(false);
  setPlaybackYouTubePaused();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
}

function emitNativePlay(player: FakePlayer): void {
  player.state = 1;
  setPlaybackYouTubePlaying();
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

describe('iframe-native YouTube PLAY authority', () => {
  it.each([
    { settlement: 'timer', pause: true },
    { settlement: 'paused callback', pause: true },
    { settlement: 'timer', pause: false },
    { settlement: 'paused callback', pause: false },
  ])(
    'settles native local rejoin through $settlement respecting a later hardware PAUSE=$pause',
    async ({ settlement, pause }) => {
      vi.useFakeTimers();
      const original = Object.getOwnPropertyDescriptor(navigator, 'mediaSession');
      try {
        const actions = new Map<string, MediaSessionActionHandler>();
        Object.defineProperty(navigator, 'mediaSession', {
          configurable: true,
          value: {
            setActionHandler: (action: string, handler: MediaSessionActionHandler) => {
              actions.set(action, handler);
            },
          },
        });
        setState('network.appRole', 'guest');
        setState('network.hostConn', { open: true, peer: 'host', send: vi.fn() } as never);
        setState('network.isOperator', false);
        setState('network.standardRoomCapabilities', []);
        const player = createPlayer();
        installPausedYouTube(player);
        initMediaSession();
        const localState = vi.fn();
        bus.on('youtube:set-local-paused', localState);

        emitNativePlay(player);
        // The real native-control path pauses the iframe before rejoining the
        // host timeline. A separate hardware PAUSE supersedes that pending PLAY.
        expect(player.state).toBe(2);
        if (pause) actions.get('pause')!({ action: 'pause' });
        if (settlement === 'paused callback') setPlaybackYouTubePaused();
        await vi.advanceTimersByTimeAsync(300);

        if (pause) expect(localState).not.toHaveBeenCalledWith(false, 'media-session-play');
        else expect(localState).toHaveBeenCalledExactlyOnceWith(false, 'media-session-play');
        expect(mocks.safeSend).not.toHaveBeenCalled();
      } finally {
        clearAllManagedTimers();
        vi.useRealTimers();
        if (original) Object.defineProperty(navigator, 'mediaSession', original);
        else Reflect.deleteProperty(navigator, 'mediaSession');
      }
    },
  );

  it('keeps a standard-room controller playing while requesting host rendezvous', () => {
    const hostConn = { open: true, peer: 'host', send: vi.fn() } as never;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    const player = createPlayer();
    installPausedYouTube(player);

    emitNativePlay(player);

    expect(player.state).toBe(1);
    expect(mocks.safeSend).toHaveBeenCalledWith(hostConn, {
      type: MSG.REQUEST_YOUTUBE_PLAY,
      queueItemId: QUEUE_ITEM_ID,
    });
  });

  it('keeps a PRO controller playing while the server establishes canonical playback', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
    const player = createPlayer();
    installPausedYouTube(player);

    emitNativePlay(player);

    expect(player.state).toBe(1);
    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith({
      kind: 'play',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 42.25,
    });
  });

  it('restores pause when a standard controller cannot send the authority request', () => {
    mocks.safeSend.mockReturnValueOnce(false);
    const hostConn = { open: true, peer: 'host', send: vi.fn() } as never;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    const player = createPlayer();
    installPausedYouTube(player);

    emitNativePlay(player);

    expect(player.state).toBe(2);
  });
});
