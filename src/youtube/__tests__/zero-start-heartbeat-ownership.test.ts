/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  getYtAutoplayIntent,
  resetYouTubeModuleState,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  guestRendezvousSync,
  initYouTubeSync,
  isGuestYouTubeTransitionPending,
  resetYouTubeSyncState,
} from '../sync.ts';
import { configureYouTubePlayerRuntimeHooks } from '../player-runtime-bridge.ts';
import {
  cancelYouTubeZeroStart,
  initYouTubeZeroStart,
  resetYouTubeZeroStart,
  YouTubeZeroStartControllerForTests,
  type YouTubeZeroStartWireMessage,
} from '../zero-start.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const QUEUE_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = 'M7lc1UVf-VE';
const EPOCH = 1_700_000_000_000;
const handlers: Record<string, (data: Record<string, unknown>, conn: DataConnection) => void> = {};
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((registered) => Object.assign(handlers, registered)),
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn() }));
vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: () => Date.now(),
  isClockCalibrated: () => true,
}));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../player/transport.ts', () => ({ fmtTime: (time: number) => String(time) }));
vi.mock('../search.ts', () => ({ fetchPlaylistSubTitles: vi.fn() }));
vi.mock('../iframe-runtime-bridge.ts', () => ({
  cancelGuestEndedFallbackFromSync: vi.fn(),
  hideYouTubeTapToPlayGateFromSync: vi.fn(),
  invalidateYtDurationCacheFromSync: vi.fn(),
  expectYouTubeMetadataVideoIdFromSync: vi.fn(),
  prepareYouTubeMediaReplacementFromSync: vi.fn(() => true),
}));

let player: FakeYtPlayer;
let host: DataConnection;
let fallbackOwnsPlayer = false;

function snapshot(time: number, state = 1): Record<string, unknown> {
  return {
    queueItemId: QUEUE_ID,
    videoId: VIDEO_ID,
    subIndex: 0,
    time,
    hostClock: Date.now(),
    state,
  };
}

function heartbeat(time: number, state = 1): void {
  handlers[MSG.YOUTUBE_SYNC](snapshot(time, state), host);
}

function startGuest(offset: number) {
  setState('sync.youtubeLocalOffset', offset);
  const controller = initYouTubeZeroStart({
    getRole: () => 'guest',
    getLocalPeerId: () => 'guest-one',
    getHostPeerId: () => host.peer,
    getLiveGuestPeerIds: () => [],
    getPlayer: () => player,
    isPlayerReady: () => true,
    isAudioUnlocked: () => true,
    isClockCalibrated: () => true,
    getHostNow: () => Date.now(),
    getClockOffsetMs: () => 0,
    getLocalPlatform: () => 'other',
    sendToPeer: () => true,
    sendToHost: () => true,
    resolveLocalTargetSec: (time) => Math.max(0, time + offset),
    getLocalStartDelayMs: (time) => Math.max(0, -(time + offset)) * 1000,
  });
  player.__onStateChange = ({ data }) => {
    controller.handlePlayerStateChange(data);
  };
  const prepare = {
    type: 'youtube-zero-start-prepare' as const,
    version: 1 as const,
    runId: 'delayed-speaker',
    sequence: 1,
    queueItemId: QUEUE_ID,
    videoId: VIDEO_ID,
    subIndex: 0,
    prepareAtHost: Date.now(),
    decisionAtHost: Date.now() + 2300,
    startDeadlineAtHost: Date.now() + 3000,
    hostPlatform: 'other' as const,
  };
  expect(controller.handlePrepare(host.peer, prepare)).toBe(true);
  vi.advanceTimersByTime(650);
  expect(controller.getSnapshot().phase).toBe('armed');
  const startAtHost = Date.now() + 500;
  expect(
    controller.handleCommit(host.peer, {
      ...prepare,
      type: 'youtube-zero-start-commit',
      startAtHost,
      cohort: ['guest-one'],
      reason: 'all-ready',
    }),
  ).toBe(true);
  return { controller, startAtHost, prepare };
}

beforeEach(() => {
  clearAllManagedTimers();
  resetState();
  resetYouTubeModuleState();
  bus.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  fallbackOwnsPlayer = false;
  configureYouTubePlayerRuntimeHooks({
    cancelPendingAutoSync: () => {
      cancelYouTubeZeroStart('superseded', false);
      fallbackOwnsPlayer = false;
    },
    consumePendingAutoSyncOnReady: () => null,
    setPendingAutoSyncOnReady: () => undefined,
    isYouTubeZeroStartExternalFallbackActive: () => fallbackOwnsPlayer,
  });
  host = { peer: 'host-one', open: true, send: vi.fn(), close: vi.fn(), on: vi.fn() };
  player = makeFakeYtPlayer({
    __videoId: VIDEO_ID,
    __currentTime: 0,
    __state: 2,
    __duration: 300,
    __advanceClock: true,
    __autoPlayOnLoad: true,
  });
  setYouTubePlayer(player as unknown as YouTubePlayerInstance);
  setPlaybackYouTubePlaying();
  setState('network.appRole', 'guest');
  setState('network.myId', 'guest-one');
  setState('network.hostConn', host);
  setState('playlist.items', [
    { queueItemId: QUEUE_ID, type: 'youtube', name: 'Video', videoId: VIDEO_ID, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ID);
  setState('youtube.currentSubIndex', 0);
  initYouTubeSync();
  resetYouTubeSyncState();
});

afterEach(() => {
  resetYouTubeZeroStart();
  resetYouTubeSyncState();
  clearAllManagedTimers();
  fallbackOwnsPlayer = false;
  vi.useRealTimers();
});

describe('heartbeat ownership during a participant-local YouTube start', () => {
  it.each([-9.999, -5, -0.25, 0, 9.999])(
    'keeps offset %s when the host resumes its ordinary heartbeat first',
    (offset) => {
      const { controller, startAtHost } = startGuest(offset);
      vi.advanceTimersByTime(4500);
      // The host has finished its own short calibration window. A delayed
      // guest can still own a paused iframe for several more seconds.
      const expectedState = offset < -4 ? 2 : 1;
      expect(player.getPlayerState()).toBe(expectedState);
      player.__log.length = 0;
      heartbeat(4);
      expect(player.getPlayerState()).toBe(expectedState);
      expect(player.__log).toHaveLength(0);

      vi.advanceTimersByTime(11000);
      expect(controller.getSnapshot().phase).toBe('idle');
      expect(player.getCurrentTime() - (Date.now() - startAtHost) / 1000).toBeCloseTo(offset, 5);
      expect(player.isMuted()).toBe(false);
    },
  );

  it('refreshes the snapshot during the hold for the next local rendezvous', () => {
    const { controller } = startGuest(-9.999);
    vi.advanceTimersByTime(4500);
    heartbeat(4);
    vi.advanceTimersByTime(6000);
    controller.cancel('cancelled', false);
    player.__log.length = 0;
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    expect(player.__log.find((call) => call.op === 'seekTo')?.args?.[0]).toBeCloseTo(1.501, 5);
  });

  it('does not let incidental paused feedback revoke the scheduled play intent', () => {
    startGuest(-9.999);
    vi.advanceTimersByTime(4500);
    setYtAutoplayIntent(true);
    player.__log.length = 0;
    heartbeat(4, 2);
    expect(player.__log).toHaveLength(0);
    expect(getYtAutoplayIntent()).toBe(true);
  });

  it('still honors an authoritative abort followed by the host pause', () => {
    const { controller, prepare } = startGuest(-9.999);
    vi.advanceTimersByTime(4500);
    heartbeat(4);
    // Host transport actions broadcast ABORT before their replacement state.
    expect(
      controller.handleAbort(host.peer, {
        ...prepare,
        type: 'youtube-zero-start-abort',
        reason: 'superseded',
      }),
    ).toBe(true);
    handlers[MSG.YOUTUBE_STATE](snapshot(4, 2), host);
    player.__log.length = 0;
    vi.advanceTimersByTime(12000);
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(player.getPlayerState()).toBe(2);
    expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
  });

  it('honors a new host pause after the host has retired its own zero-start barrier', () => {
    setState('sync.youtubeLocalOffset', -9.999);
    let hostController!: YouTubeZeroStartControllerForTests;
    const guestController = initYouTubeZeroStart({
      getRole: () => 'guest',
      getLocalPeerId: () => 'guest-one',
      getHostPeerId: () => host.peer,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => player,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: () => true,
      sendToHost: (message) => {
        if (message.type === 'youtube-zero-start-capability')
          hostController.handleCapability('guest-one', message);
        if (message.type === 'youtube-zero-start-armed')
          hostController.handleArmed('guest-one', message);
        return true;
      },
      resolveLocalTargetSec: (time) => Math.max(0, time - 9.999),
      getLocalStartDelayMs: (time) => Math.max(0, 9.999 - time) * 1000,
    });
    player.__onStateChange = ({ data }) => {
      guestController.handlePlayerStateChange(data);
    };
    const hostPlayer = makeFakeYtPlayer({
      __videoId: VIDEO_ID,
      __autoPlayOnLoad: true,
      __advanceClock: true,
    });
    const outbound: YouTubeZeroStartWireMessage[] = [];
    hostController = new YouTubeZeroStartControllerForTests({
      getRole: () => 'host',
      getLocalPeerId: () => host.peer,
      getHostPeerId: () => null,
      getLiveGuestPeerIds: () => ['guest-one'],
      getPlayer: () => hostPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToHost: () => true,
      sendToPeer: (_peerId, message) => {
        outbound.push(message);
        if (message.type === 'youtube-zero-start-prepare')
          guestController.handlePrepare(host.peer, message);
        if (message.type === 'youtube-zero-start-commit')
          guestController.handleCommit(host.peer, message);
        if (message.type === 'youtube-zero-start-abort')
          guestController.handleAbort(host.peer, message);
        if (message.type === 'youtube-zero-start-timeline')
          guestController.handleTimeline(host.peer, message);
        return true;
      },
    });
    hostPlayer.__onStateChange = ({ data }) => {
      hostController.handlePlayerStateChange(data);
    };
    expect(guestController.advertiseCapability()).toBe(true);
    expect(
      hostController.beginHostTransition({ queueItemId: QUEUE_ID, videoId: VIDEO_ID, subIndex: 0 }),
    ).toBe(true);
    // The host's release and calibration finish before the guest's local wait.
    vi.advanceTimersByTime(6500);
    expect(hostController.getSnapshot().phase).toBe('idle');
    expect(guestController.getSnapshot().phase).toBe('scheduled');
    outbound.length = 0;
    hostController.cancel('superseded', true);
    expect(outbound).toHaveLength(0);

    handlers[MSG.YOUTUBE_STATE](snapshot(6, 2), host);
    player.__log.length = 0;
    vi.advanceTimersByTime(12000);
    expect(guestController.getSnapshot().phase).toBe('idle');
    expect(player.getPlayerState()).toBe(2);
    expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
    hostController.reset();
  });

  it.each([1, 2, 0, 3])('respects external fallback ownership for heartbeat state %s', (state) => {
    // The bounded fallback is a different owner: the controller has already
    // retired its failed prepare, but recovery still holds this iframe.
    fallbackOwnsPlayer = true;
    player.mute();
    player.__log.length = 0;
    setYtAutoplayIntent(true);
    heartbeat(4, state);
    expect(player.__log).toHaveLength(0);
    expect(player.getPlayerState()).toBe(2);
    expect(player.isMuted()).toBe(true);
    expect(getYtAutoplayIntent()).toBe(true);

    fallbackOwnsPlayer = false;
    heartbeat(20, 1);
    expect(player.getCurrentTime()).toBe(20);
    expect(player.getPlayerState()).toBe(1);
  });

  it('uses snapshots received under fallback ownership after that owner retires', () => {
    fallbackOwnsPlayer = true;
    heartbeat(20);
    fallbackOwnsPlayer = false;
    expect(guestRendezvousSync({ silent: true }).status).toBe('started');
    expect(player.__log.find((call) => call.op === 'seekTo')?.args?.[0]).toBe(21.5);
  });

  it.each([1, 3, 5])('ignores incidental state %s while preserving its fresh snapshot', (state) => {
    const { controller } = startGuest(-9.999);
    vi.advanceTimersByTime(4500);
    player.__log.length = 0;
    handlers[MSG.YOUTUBE_STATE](snapshot(4, state), host);
    expect(controller.getSnapshot().phase).toBe('scheduled');
    expect(player.__log).toHaveLength(0);
  });

  it.each(['scheduled', 'fallback'] as const)(
    'lets an explicit seek and its final rendezvous supersede %s ownership without ABORT',
    (owner) => {
      const controller = owner === 'scheduled' ? startGuest(-9.999).controller : null;
      setState('sync.youtubeLocalOffset', -9.999);
      if (owner === 'fallback') fallbackOwnsPlayer = true;
      vi.advanceTimersByTime(4500);
      handlers[MSG.YOUTUBE_STATE]({ ...snapshot(100), hostPlayAt: 0 }, host);
      expect(controller?.getSnapshot().phase ?? 'idle').toBe('idle');
      expect(fallbackOwnsPlayer).toBe(false);
      vi.advanceTimersByTime(500);
      expect(player.getPlayerState()).toBe(1);
      handlers[MSG.YOUTUBE_SYNC]({ ...snapshot(100.5), isManual: true }, host);
      expect(isGuestYouTubeTransitionPending()).toBe(true);
      vi.advanceTimersByTime(4000);
      expect(player.getCurrentTime()).toBeCloseTo(104.5 - 9.999, 5);
      expect(isGuestYouTubeTransitionPending()).toBe(false);
      const position = player.getCurrentTime();
      player.__log.length = 0;
      vi.advanceTimersByTime(12000);
      expect(player.getCurrentTime()).toBeCloseTo(position + 12, 5);
      expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
    },
  );

  it('retains external fallback on feedback but retires it for an explicit pause', () => {
    fallbackOwnsPlayer = true;
    for (const state of [1, 3, 5]) {
      handlers[MSG.YOUTUBE_STATE](snapshot(4, state), host);
      expect(fallbackOwnsPlayer).toBe(true);
      expect(player.__log).toHaveLength(0);
    }
    handlers[MSG.YOUTUBE_STATE](snapshot(4, 2), host);
    expect(fallbackOwnsPlayer).toBe(false);
    expect(player.getPlayerState()).toBe(2);
    expect(player.getCurrentTime()).toBe(4);
  });
});
