/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetState, setState } from '../../core/state.ts';
import { setManagedTimer } from '../../core/timers.ts';
import {
  incrementSessionId,
  isYtPrimeReady,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setYouTubePlayer,
  setYtPrimed,
} from '../_state.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import { YOUTUBE_PRIME_VIDEO_ID } from '../constants.ts';
import { RetainedYouTubePlayerController } from '../retained-player-controller.ts';

type RetainedPlayerControllerPorts = ConstructorParameters<
  typeof RetainedYouTubePlayerController
>[0];

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/platform.ts', () => ({ IS_IOS: true, IS_ANDROID: false }));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
}));

const QUEUE_ITEM_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_QUEUE_ITEM_ID = '99999999-9999-4999-8999-999999999999';
const TARGET_VIDEO_ID = 'targetVid01';
const SECOND_TARGET_VIDEO_ID = 'targetVid02';

interface MutablePlayerHarness {
  player: YouTubePlayerInstance;
  commands: string[];
  setIdentity(videoId: string, state: number): void;
  setMuteReadable(value: boolean | null): void;
}

function createPlayer(): MutablePlayerHarness {
  let videoId = 'outgoing01';
  let state = 2;
  let muted = false;
  let muteReadable: boolean | null = true;
  const commands: string[] = [];
  const player = {
    cueVideoById: vi.fn((nextVideoId: string) => {
      commands.push(`cue:${nextVideoId}`);
    }),
    loadVideoById: vi.fn(),
    loadPlaylist: vi.fn(),
    cuePlaylist: vi.fn(),
    pauseVideo: vi.fn(() => commands.push('pause')),
    playVideo: vi.fn(),
    stopVideo: vi.fn(() => commands.push('stop')),
    destroy: vi.fn(() => commands.push('destroy')),
    seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getPlayerState: vi.fn(() => state),
    getPlaylistIndex: vi.fn(() => 0),
    getVideoData: vi.fn(() => ({ video_id: videoId })),
    getPlaylist: vi.fn(() => [videoId]),
    setVolume: vi.fn(),
    mute: vi.fn(() => {
      commands.push('mute');
      if (muteReadable !== null) muted = true;
    }),
    unMute: vi.fn(() => {
      muted = false;
    }),
    isMuted: vi.fn(() => {
      if (muteReadable === null) throw new Error('mute state unavailable');
      return muteReadable ? muted : false;
    }),
  } satisfies YouTubePlayerInstance;
  return {
    player,
    commands,
    setIdentity(nextVideoId, nextState) {
      videoId = nextVideoId;
      state = nextState;
    },
    setMuteReadable(value) {
      muteReadable = value;
      if (value === false) muted = false;
    },
  };
}

function latestTimer(name: string): (() => void) | undefined {
  const calls = vi.mocked(setManagedTimer).mock.calls.filter(([timerName]) => timerName === name);
  return calls.at(-1)?.[1];
}

function createController(overrides: Partial<RetainedPlayerControllerPorts> = {}) {
  let controller: RetainedYouTubePlayerController;
  const releaseObservations: Array<{ pending: boolean; ignored: boolean }> = [];
  const ports: RetainedPlayerControllerPorts = {
    loadTarget: vi.fn(),
    dispatchStableState: vi.fn((player, state) => {
      releaseObservations.push({
        pending: controller.isTargetHandoffPending(player),
        ignored: controller.shouldIgnoreCallback(player, state),
      });
    }),
    invalidateDurationCache: vi.fn(),
    hideSyncOverlay: vi.fn(),
    finalizeDestroy: vi.fn(),
    ...overrides,
  };
  controller = new RetainedYouTubePlayerController(ports);
  return { controller, ports, releaseObservations };
}

function confirmPrimeParking(
  controller: RetainedYouTubePlayerController,
  harness: MutablePlayerHarness,
): void {
  expect(markYtPlayerReady(harness.player)).toBe(true);
  harness.setIdentity(YOUTUBE_PRIME_VIDEO_ID, 5);
  latestTimer('yt-retained-player-park-confirm')?.();
  latestTimer('yt-retained-player-park-confirm')?.();
  expect(controller.isParked(harness.player)).toBe(true);
  expect(isYtPrimeReady()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  resetYouTubeModuleState();
  Object.assign(globalThis, {
    YT: {
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    },
  });
});

describe('retained YouTube player controller', () => {
  it('keeps hard-mute, pause, and silent-PRIME cue order inside one parking owner', () => {
    const harness = createPlayer();
    const { controller, ports } = createController();
    setYouTubePlayer(harness.player);

    expect(controller.park(harness.player)).toBe(true);
    expect(harness.commands.slice(0, 3)).toEqual([
      'mute',
      'pause',
      `cue:${YOUTUBE_PRIME_VIDEO_ID}`,
    ]);
    expect(controller.isParked(harness.player)).toBe(true);
    expect(isYtPrimeReady()).toBe(false);

    confirmPrimeParking(controller, harness);
    expect(ports.invalidateDurationCache).toHaveBeenCalledOnce();
    expect(ports.hideSyncOverlay).toHaveBeenCalledOnce();

    controller.forget(harness.player);
    expect(controller.isParked(harness.player)).toBe(false);
  });

  it('fences a superseded target generation and accepts the latest release boundary', () => {
    const harness = createPlayer();
    const { controller, ports, releaseObservations } = createController();
    setYouTubePlayer(harness.player);
    expect(controller.park(harness.player)).toBe(true);
    confirmPrimeParking(controller, harness);

    setState('playback.mode', 'youtube');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    const sessionId = incrementSessionId();
    expect(
      controller.armHandoff(harness.player, {
        videoId: TARGET_VIDEO_ID,
        playlistId: null,
        commandPlaylistId: null,
        autoplay: false,
        subIndex: 0,
        sessionId,
        sameVideoReuse: false,
      }),
    ).toBe('ready');

    expect(controller.markLoadCommand(harness.player, TARGET_VIDEO_ID, null, 0, true)).toBe(true);
    const stalePoll = latestTimer('yt-retained-player-target-confirm');

    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    const replacementSessionId = incrementSessionId();
    expect(
      controller.armHandoff(harness.player, {
        videoId: SECOND_TARGET_VIDEO_ID,
        playlistId: null,
        commandPlaylistId: null,
        autoplay: false,
        subIndex: 0,
        sessionId: replacementSessionId,
        sameVideoReuse: false,
      }),
    ).toBe('ready');
    expect(controller.markLoadCommand(harness.player, SECOND_TARGET_VIDEO_ID, null, 0, true)).toBe(
      true,
    );
    harness.setIdentity(SECOND_TARGET_VIDEO_ID, 5);

    stalePoll?.();
    expect(controller.isTargetHandoffPending(harness.player)).toBe(true);
    expect(ports.dispatchStableState).not.toHaveBeenCalled();

    latestTimer('yt-retained-player-target-confirm')?.();
    latestTimer('yt-retained-player-target-confirm')?.();
    expect(controller.isTargetHandoffPending(harness.player)).toBe(false);
    expect(ports.dispatchStableState).toHaveBeenCalledOnce();
    expect(releaseObservations).toEqual([{ pending: true, ignored: false }]);
    expect(controller.shouldIgnoreCallback(harness.player, 5)).toBe(false);
  });

  it('re-proves a post-bounce PRIME without issuing a second cue', () => {
    const harness = createPlayer();
    const { controller } = createController();
    setYouTubePlayer(harness.player);
    expect(controller.park(harness.player)).toBe(true);
    confirmPrimeParking(controller, harness);
    setYtPrimed(true);
    harness.setMuteReadable(false);

    expect(controller.ensureHardMuted(harness.player)).toBe(true);
    expect(isYtPrimeReady()).toBe(false);
    expect(harness.player.cueVideoById).toHaveBeenCalledOnce();

    harness.setMuteReadable(true);
    latestTimer('yt-retained-player-park-confirm')?.();
    latestTimer('yt-retained-player-park-confirm')?.();

    expect(controller.verifyBeforePrimeBounce(harness.player)).toBe(true);
    expect(harness.player.cueVideoById).toHaveBeenCalledOnce();
    expect(harness.player.destroy).not.toHaveBeenCalled();
  });

  it('drops a deferred handoff when playback ownership exits YouTube', () => {
    const harness = createPlayer();
    const { controller, ports } = createController();
    setYouTubePlayer(harness.player);
    expect(controller.park(harness.player)).toBe(true);
    setState('playback.mode', 'youtube');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    const sessionId = incrementSessionId();
    expect(
      controller.armHandoff(harness.player, {
        videoId: TARGET_VIDEO_ID,
        playlistId: null,
        commandPlaylistId: null,
        autoplay: false,
        subIndex: 0,
        sessionId,
        sameVideoReuse: false,
      }),
    ).toBe('deferred');

    setState('playback.mode', 'file');
    harness.setIdentity(YOUTUBE_PRIME_VIDEO_ID, 5);
    latestTimer('yt-retained-player-park-confirm')?.();
    latestTimer('yt-retained-player-park-confirm')?.();

    expect(ports.loadTarget).not.toHaveBeenCalled();
    expect(harness.player.destroy).not.toHaveBeenCalled();
    expect(controller.isParked(harness.player)).toBe(true);
  });

  it('destroys an offscreen owner when physical mute cannot be proven', () => {
    const harness = createPlayer();
    harness.setMuteReadable(false);
    const { controller, ports } = createController();
    setYouTubePlayer(harness.player);
    expect(controller.park(harness.player)).toBe(true);

    for (let poll = 0; poll < 25; poll += 1) {
      latestTimer('yt-retained-player-park-confirm')?.();
    }

    expect(controller.isParked(harness.player)).toBe(false);
    expect(harness.player.destroy).toHaveBeenCalledOnce();
    expect(ports.finalizeDestroy).toHaveBeenCalledWith({ resetHost: true, recreatePrime: true });
  });
});
