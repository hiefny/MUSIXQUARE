/**
 * @vitest-environment jsdom
 *
 * H3 owner queries at the native-control authority (tests first for Phase 6
 * increment 6A-1). hasProtectedTransitionOwner (native-control-authority.ts)
 * hears the legacy rendezvous's stage-2 wait only through the player runtime
 * bridge's owner query, which player.ts answers from its own 'yt-auto-sync'
 * timer, and the guest state actions and rendezvous stages only through the
 * owner query sync.ts registers, which sync.ts answers from its own timers. A
 * raw timer of one of those names is not an owner. The PRO coordinator nudge
 * keeps its timer-name read (RO-13 is owner-in-place).
 *
 * This suite loads the native-control authority and the bridge without
 * player.ts or sync.ts, so only the stand-in queries below answer. The site
 * is a trusted OS/headset PLAY that a Standard host keeps through the
 * autoplay guard (preserveNativeControllerPlayBeforeAutoplayGuard): it is held
 * while an owner is active and decided at once otherwise. Every row restores
 * the default queries, so the rows pass in any order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../pro-room/playback-authority-hooks.ts', () => ({
  routeProPlaybackCommand: vi.fn(() => true),
}));
vi.mock('../../network/peer.ts', () => ({
  safeSend: vi.fn(() => true),
}));

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePaused } from '../../player/ownership.ts';
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
import {
  initYouTubeNativeControlAuthority,
  preserveNativeControllerPlayBeforeAutoplayGuard,
  registerYouTubeNativeControlSyncOwnerQuery,
} from '../native-control-authority.ts';
import { clearYouTubeStableControlExpectations } from '../native-control-origin.ts';
import { configureYouTubePlayerRuntimeHooks } from '../player-runtime-bridge.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'ownerPorts1';

interface FakePlayer extends YouTubePlayerInstance {
  state: number;
}

/** A paused iframe whose plain methods the native-control instrumentation wraps. */
function createPlayer(): FakePlayer {
  let state = 2;
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
    getPlaylistIndex: () => -1,
    getVideoData: () => ({ video_id: VIDEO_ID, title: 'Video' }),
    getPlaylist: () => [],
    setVolume: () => undefined,
  };
}

/** A Standard host whose current YouTube occurrence is paused. */
function installStandardHost(): FakePlayer {
  const player = createPlayer();
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
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
  setYtAutoplayIntent(false);
  setPlaybackYouTubePaused();
  initYouTubeNativeControlAuthority();
  bus.emit('youtube:player-ready');
  return player;
}

/** Is an OS/headset PLAY of the current iframe kept through the autoplay guard now? */
function nativePlayKept(player: FakePlayer): boolean {
  clearYouTubeStableControlExpectations(player);
  setYtAutoplayIntent(false);
  // The OS changes the iframe without a wrapped playVideo() call.
  player.state = 1;
  const kept = preserveNativeControllerPlayBeforeAutoplayGuard(player);
  player.state = 2;
  return kept;
}

/** The bridge with no player.ts behind it, but for the 'yt-auto-sync' owner query. */
function answerAutoSyncOwner(pending: () => boolean): void {
  configureYouTubePlayerRuntimeHooks({
    cancelPendingAutoSync: () => undefined,
    consumePendingAutoSyncOnReady: () => null,
    isYouTubeAutoSyncPending: pending,
    isProPlaybackPauseGatePending: () => false,
    setPendingAutoSyncOnReady: () => undefined,
  });
}

/** Run with sync.ts's owner query answered by `pending`, then restore the default. */
function withSyncOwner(pending: () => boolean, run: () => void): void {
  registerYouTubeNativeControlSyncOwnerQuery(pending);
  try {
    run();
  } finally {
    registerYouTubeNativeControlSyncOwnerQuery(() => false);
  }
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
  answerAutoSyncOwner(() => false);
  clearAllManagedTimers();
  bus.clear();
});

describe('H3 owner queries at the native-control authority (6A-1, tests first)', () => {
  it('keeps a native PLAY at once when no owner is active (control row)', () => {
    const player = installStandardHost();
    expect(nativePlayKept(player)).toBe(true);
  });

  it("holds a native PLAY while the bridge's 'yt-auto-sync' owner query answers pending, though no timer of that name exists", () => {
    const player = installStandardHost();
    answerAutoSyncOwner(() => true);
    expect(nativePlayKept(player)).toBe(false);
    answerAutoSyncOwner(() => false);
    expect(nativePlayKept(player)).toBe(true);
  });

  it.each([
    'yt-auto-sync',
    'yt-clock-action',
    'yt-seek-play',
    'yt-rendezvous-buffer',
    'yt-rendezvous-play',
    'yt-rendezvous-calibrate',
  ] as const)(
    'keeps a native PLAY when only a raw %s timer exists and its owner answers not pending',
    (name) => {
      const player = installStandardHost();
      setManagedTimer(name, () => undefined, 2_000);
      expect(nativePlayKept(player)).toBe(true);
    },
  );

  it('holds a native PLAY while the owner query sync.ts registers answers pending', () => {
    const player = installStandardHost();
    withSyncOwner(
      () => true,
      () => {
        expect(nativePlayKept(player)).toBe(false);
      },
    );
    expect(nativePlayKept(player)).toBe(true);
  });

  it('still holds a native PLAY on a raw PRO coordinator nudge timer, whose name read stays (RO-13)', () => {
    const player = installStandardHost();
    setManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER, () => undefined, 2_000);
    expect(nativePlayKept(player)).toBe(false);
    clearManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);
    expect(nativePlayKept(player)).toBe(true);
  });
});
