/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { resetState, setState } from '../../core/state.ts';
import { setManagedTimer } from '../../core/timers.ts';
import {
  incrementSessionId,
  isYtPrimeReady,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setYouTubePlayer,
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
  getManagedTimer: vi.fn(),
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
    getVolume: vi.fn(() => 100),
    getVideoLoadedFraction: vi.fn(() => 1),
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

function establishTargetA() {
  const harness = createPlayer();
  const { controller, ports } = createController();
  setYouTubePlayer(harness.player);
  expect(controller.park(harness.player)).toBe(true);
  confirmPrimeParking(controller, harness);
  setState('playback.mode', 'youtube');
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Playlist',
      videoId: TARGET_VIDEO_ID,
      playlistId: 'PL_AUDIT',
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('youtube.subItemsMap', {
    PL_AUDIT: { ids: [TARGET_VIDEO_ID, SECOND_TARGET_VIDEO_ID], titles: [] },
  });
  const sessionId = incrementSessionId();
  controller.armHandoff(harness.player, {
    videoId: TARGET_VIDEO_ID,
    playlistId: 'PL_AUDIT',
    commandPlaylistId: null,
    autoplay: false,
    subIndex: 0,
    sessionId,
    sameVideoReuse: false,
  });
  controller.markLoadCommand(harness.player, TARGET_VIDEO_ID, null, 0, true);
  harness.setIdentity(TARGET_VIDEO_ID, 5);
  latestTimer('yt-retained-player-target-confirm')?.();
  latestTimer('yt-retained-player-target-confirm')?.();
  expect(controller.shouldIgnoreCallback(harness.player, 5)).toBe(false);
  return { harness, controller, ports };
}

const handlers = vi.hoisted(
  () => new Map<string, (data: Record<string, unknown>, conn: unknown) => void>(),
);
vi.mock('../../network/protocol.ts', () => ({
  verifyOperator: () => true,
  registerHandlers: (registered: Record<string, never>) =>
    Object.entries(registered).forEach(([key, value]) => handlers.set(key, value)),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: () => true,
  sendToHost: vi.fn(),
}));
vi.mock('../../player/transport.ts', () => ({ fmtTime: (value: number) => String(value) }));
vi.mock('../search.ts', () => ({ fetchPlaylistSubTitles: vi.fn(async () => {}) }));
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import {
  configureYouTubeIframeRuntimeHooks,
  prepareYouTubeMediaReplacementFromSync,
} from '../iframe-runtime-bridge.ts';
import { getCurrentSessionId, getYtAutoplayIntent } from '../_state.ts';

beforeEach(() => {
  bus.clear();
  initYouTubeSync();
  resetYouTubeSyncState();
});
afterEach(() => bus.clear());

function bindController(controller: RetainedYouTubePlayerController) {
  configureYouTubeIframeRuntimeHooks({
    prepareMediaReplacement: (player, request) => controller.prepareSyncHandoff(player, request),
    expectMetadataVideoId: vi.fn(),
    hideTapToPlayGate: vi.fn(),
    invalidateDurationCache: vi.fn(),
    cancelGuestEndedFallback: vi.fn(),
  });
}

const hostConnection = { open: true, peer: 'host' };
function sendMismatch(type: string, state: number, videoId = SECOND_TARGET_VIDEO_ID) {
  handlers.get(type)!(
    { queueItemId: QUEUE_ITEM_ID, videoId, subIndex: 1, state, time: 12 },
    hostConnection,
  );
}

it.each(
  [MSG.YOUTUBE_STATE, MSG.YOUTUBE_SYNC].flatMap((type) => [1, 2].map((state) => ({ type, state }))),
)(
  'reconciles retained guest $type state=$state through stable target handoff',
  ({ type, state }) => {
    const { harness, controller } = establishTargetA();
    bindController(controller);
    setState('network.hostConn', hostConnection as never);
    setState('sync.youtubeLocalOffset', 0.25);
    vi.mocked(harness.player.cueVideoById!).mockClear();

    sendMismatch(type, state);

    if (state === 1) {
      expect(harness.player.loadVideoById).toHaveBeenCalledWith(SECOND_TARGET_VIDEO_ID);
      expect(harness.player.cueVideoById).not.toHaveBeenCalled();
    } else {
      expect(harness.player.cueVideoById).toHaveBeenCalledWith(SECOND_TARGET_VIDEO_ID, 12.25);
      expect(harness.player.loadVideoById).not.toHaveBeenCalled();
    }
    expect(getYtAutoplayIntent()).toBe(state === 1);
    expect(controller.isTargetHandoffPending(harness.player)).toBe(true);
    harness.setIdentity(TARGET_VIDEO_ID, 0);
    expect(controller.shouldIgnoreCallback(harness.player, 0)).toBe(true);
    const nativeState = state === 1 ? 1 : 5;
    harness.setIdentity(SECOND_TARGET_VIDEO_ID, nativeState);
    expect(controller.shouldIgnoreCallback(harness.player, nativeState)).toBe(true);
    latestTimer('yt-retained-player-target-confirm')?.();
    expect(controller.isTargetHandoffPending(harness.player)).toBe(true);
    latestTimer('yt-retained-player-target-confirm')?.();
    expect(controller.isTargetHandoffPending(harness.player)).toBe(false);
    expect(controller.shouldIgnoreCallback(harness.player, nativeState)).toBe(false);
    harness.setIdentity(TARGET_VIDEO_ID, 0);
    expect(controller.shouldIgnoreCallback(harness.player, 0)).toBe(true);
  },
);

it.each([MSG.YOUTUBE_STATE, MSG.YOUTUBE_SYNC])(
  'does not let %s steal a pending canonical handoff',
  (type) => {
    const { harness, controller } = establishTargetA();
    bindController(controller);
    setState('network.hostConn', hostConnection as never);
    controller.armHandoff(harness.player, {
      videoId: SECOND_TARGET_VIDEO_ID,
      playlistId: null,
      commandPlaylistId: null,
      autoplay: false,
      subIndex: 1,
      sessionId: getCurrentSessionId(),
      sameVideoReuse: false,
    });
    controller.markLoadCommand(harness.player, SECOND_TARGET_VIDEO_ID, null, 1, true);
    const pendingPoll = latestTimer('yt-retained-player-target-confirm');
    sendMismatch(type, 1, 'targetVid03');
    expect(harness.player.loadVideoById).not.toHaveBeenCalled();
    expect(latestTimer('yt-retained-player-target-confirm')).toBe(pendingPoll);
    harness.setIdentity(SECOND_TARGET_VIDEO_ID, 5);
    pendingPoll?.();
    latestTimer('yt-retained-player-target-confirm')?.();
    expect(controller.shouldIgnoreCallback(harness.player, 5)).toBe(false);
  },
);

it.each(['player', 'queue', 'session', 'mode'] as const)(
  'rejects a stale %s before issuing a physical command',
  (stale) => {
    const { harness, controller } = establishTargetA();
    bindController(controller);
    const request = {
      videoId: SECOND_TARGET_VIDEO_ID,
      subIndex: 1,
      autoplay: true,
      queueItemId: QUEUE_ITEM_ID,
      sessionId: getCurrentSessionId(),
    };
    if (stale === 'player') setYouTubePlayer(createPlayer().player);
    if (stale === 'queue') setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    if (stale === 'session') incrementSessionId();
    if (stale === 'mode') setState('playback.mode', 'file');
    expect(prepareYouTubeMediaReplacementFromSync(harness.player, request)).toBe(false);
    expect(harness.player.loadVideoById).not.toHaveBeenCalled();
  },
);

it.each(
  [MSG.YOUTUBE_STATE, MSG.YOUTUBE_SYNC].flatMap((type) => [1, 2].map((state) => ({ type, state }))),
)('preserves ordinary desktop $type state=$state media commands', ({ type, state }) => {
  const { harness, controller } = establishTargetA();
  controller.forget(harness.player);
  bindController(controller);
  setState('network.hostConn', hostConnection as never);
  vi.mocked(harness.player.cueVideoById!).mockClear();
  sendMismatch(type, state);
  if (state === 1)
    expect(harness.player.loadVideoById).toHaveBeenCalledWith(SECOND_TARGET_VIDEO_ID);
  else expect(harness.player.cueVideoById).toHaveBeenCalledWith(SECOND_TARGET_VIDEO_ID, 12);
  expect(controller.isTargetHandoffPending(harness.player)).toBe(false);
});
