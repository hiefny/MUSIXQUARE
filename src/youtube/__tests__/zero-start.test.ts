import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { YouTubeZeroStartPlatform } from '../../types/index.ts';
import {
  YouTubeZeroStartControllerForTests as YouTubeZeroStartController,
  getYouTubeZeroStartRelativeLeadForTests as getYouTubeZeroStartRelativeLead,
  type YouTubeZeroStartDependenciesForTests as YouTubeZeroStartDependencies,
  type YouTubeZeroStartPlayer,
  type YouTubeZeroStartWireMessage,
} from '../zero-start.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_GUEST_ID = '44444444-4444-4444-8444-444444444444';
const QUEUE_ITEM_ID = '33333333-3333-4333-8333-333333333333';
const VIDEO_ID = 'M7lc1UVf-VE';

type Harness = {
  host: YouTubeZeroStartController;
  guest: YouTubeZeroStartController;
  hostPlayer: FakeYtPlayer;
  guestPlayer: FakeYtPlayer;
  hostOutbound: YouTubeZeroStartWireMessage[];
  guestOutbound: YouTubeZeroStartWireMessage[];
};

function dispatchToHost(
  controller: YouTubeZeroStartController,
  message: YouTubeZeroStartWireMessage,
): void {
  switch (message.type) {
    case 'youtube-zero-start-capability':
      controller.handleCapability(GUEST_ID, message);
      break;
    case 'youtube-zero-start-armed':
      controller.handleArmed(GUEST_ID, message);
      break;
    default:
      break;
  }
}

function dispatchToGuest(
  controller: YouTubeZeroStartController,
  message: YouTubeZeroStartWireMessage,
): void {
  switch (message.type) {
    case 'youtube-zero-start-prepare':
      controller.handlePrepare(HOST_ID, message);
      break;
    case 'youtube-zero-start-commit':
      controller.handleCommit(HOST_ID, message);
      break;
    case 'youtube-zero-start-abort':
      controller.handleAbort(HOST_ID, message);
      break;
    case 'youtube-zero-start-timeline':
      controller.handleTimeline(HOST_ID, message);
      break;
    default:
      break;
  }
}

function makeHarness(options?: {
  hostPlatform?: YouTubeZeroStartPlatform;
  guestPlatform?: YouTubeZeroStartPlatform;
  guestOffsetSec?: number;
  hostVolume?: number;
  guestVolume?: number;
  guestMuted?: boolean;
  failHostCommitSend?: boolean;
  onHostFallbackRequired?: YouTubeZeroStartDependencies['onHostFallbackRequired'];
}): Harness {
  const hostOutbound: YouTubeZeroStartWireMessage[] = [];
  const guestOutbound: YouTubeZeroStartWireMessage[] = [];
  let host!: YouTubeZeroStartController;
  let guest!: YouTubeZeroStartController;

  const hostPlayer = makeFakeYtPlayer({
    __autoPlayOnLoad: true,
    __volume: options?.hostVolume ?? 37,
    __muted: false,
  });
  const guestPlayer = makeFakeYtPlayer({
    __autoPlayOnLoad: true,
    __volume: options?.guestVolume ?? 0,
    __muted: options?.guestMuted ?? true,
  });
  hostPlayer.__onStateChange = ({ data }) => host.handlePlayerStateChange(data);
  guestPlayer.__onStateChange = ({ data }) => guest.handlePlayerStateChange(data);

  const common = {
    isPlayerReady: () => true,
    isAudioUnlocked: () => true,
    isClockCalibrated: () => true,
    getHostNow: () => Date.now(),
    getClockOffsetMs: () => 0,
    createRunId: (sequence: number) => `run-${sequence}`,
  } satisfies Partial<YouTubeZeroStartDependencies>;

  host = new YouTubeZeroStartController({
    ...common,
    getRole: () => 'host',
    getLocalPeerId: () => HOST_ID,
    getHostPeerId: () => null,
    getLiveGuestPeerIds: () => [GUEST_ID],
    getPlayer: () => hostPlayer as YouTubeZeroStartPlayer,
    getLocalPlatform: () => options?.hostPlatform ?? 'other',
    sendToPeer: (_peerId, message) => {
      hostOutbound.push(message);
      if (options?.failHostCommitSend && message.type === 'youtube-zero-start-commit') {
        return false;
      }
      dispatchToGuest(guest, message);
      return true;
    },
    sendToHost: () => false,
    onHostFallbackRequired: options?.onHostFallbackRequired,
  } as YouTubeZeroStartDependencies);

  const guestOffset = options?.guestOffsetSec ?? 0;
  guest = new YouTubeZeroStartController({
    ...common,
    getRole: () => 'guest',
    getLocalPeerId: () => GUEST_ID,
    getHostPeerId: () => HOST_ID,
    getLiveGuestPeerIds: () => [],
    getPlayer: () => guestPlayer as YouTubeZeroStartPlayer,
    getLocalPlatform: () => options?.guestPlatform ?? 'other',
    sendToPeer: () => false,
    sendToHost: (message) => {
      guestOutbound.push(message);
      dispatchToHost(host, message);
      return true;
    },
    resolveLocalTargetSec: (canonical) => canonical + guestOffset,
    toCanonicalPositionSec: (local) => local - guestOffset,
  } as YouTubeZeroStartDependencies);

  return { host, guest, hostPlayer, guestPlayer, hostOutbound, guestOutbound };
}

describe('YouTubeZeroStartController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires runtime-aware v2 capability from every live guest', () => {
    const player = makeFakeYtPlayer();
    let liveGuests: string[] = [];
    const controller = new YouTubeZeroStartController({
      getRole: () => 'host',
      getLocalPeerId: () => HOST_ID,
      getHostPeerId: () => null,
      getLiveGuestPeerIds: () => liveGuests,
      getPlayer: () => player as YouTubeZeroStartPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: () => true,
      sendToHost: () => false,
    });

    expect(controller.canBeginHostTransition()).toBe(false);
    liveGuests = [GUEST_ID];
    expect(controller.canBeginHostTransition()).toBe(false);
    controller.handleCapability(GUEST_ID, {
      type: 'youtube-zero-start-capability',
      version: 1,
      platform: 'ios',
    });
    expect(controller.canBeginHostTransition()).toBe(false);
    controller.handleCapability(GUEST_ID, {
      type: 'youtube-zero-start-capability',
      version: 2,
      platform: 'ios',
      ready: false,
    });
    expect(controller.canBeginHostTransition()).toBe(true);
    controller.handleCapability(GUEST_ID, {
      type: 'youtube-zero-start-capability',
      version: 2,
      platform: 'ios',
      ready: true,
    });
    expect(controller.canBeginHostTransition()).toBe(true);
  });

  it('arms the first PREPARE when a cold iOS guest becomes ready inside the bounded wait', () => {
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: true, __muted: false, __volume: 71 });
    const outbound: YouTubeZeroStartWireMessage[] = [];
    let runtimeReady = false;
    let controller!: YouTubeZeroStartController;
    controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => (runtimeReady ? (player as YouTubeZeroStartPlayer) : null),
      isPlayerReady: () => runtimeReady,
      isAudioUnlocked: () => runtimeReady,
      isClockCalibrated: () => runtimeReady,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'ios',
      sendToPeer: () => false,
      sendToHost: (message) => {
        outbound.push(message);
        return true;
      },
    });
    player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
    const prepareAtHost = Date.now();

    expect(
      controller.handlePrepare(HOST_ID, {
        type: 'youtube-zero-start-prepare',
        version: 1,
        runId: 'cold-first-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'waiting-ready' });

    vi.advanceTimersByTime(350);
    expect(outbound).toHaveLength(0);
    runtimeReady = true;
    vi.advanceTimersByTime(750);

    expect(outbound.find((message) => message.type === 'youtube-zero-start-armed')).toMatchObject({
      runId: 'cold-first-run',
      audioUnlocked: true,
      platform: 'ios',
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: 'armed' });
    expect(player.isMuted()).toBe(false);
    expect(player.getVolume()).toBe(71);
  });

  it('does not mutate a late player when a waiting-ready guest falls back', () => {
    const player = makeFakeYtPlayer({ __muted: true, __volume: 23 });
    const fallback = vi.fn();
    let playerVisible = false;
    const controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => (playerVisible ? (player as YouTubeZeroStartPlayer) : null),
      isPlayerReady: () => playerVisible,
      isAudioUnlocked: () => false,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'ios',
      sendToPeer: () => false,
      sendToHost: () => true,
      onFallbackRequired: fallback,
    });
    const prepareAtHost = Date.now();

    expect(
      controller.handlePrepare(HOST_ID, {
        type: 'youtube-zero-start-prepare',
        version: 1,
        runId: 'cold-late-player-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'waiting-ready' });

    // WebKit may expose the persistent iframe before its gesture gate opens.
    // The waiting run has not captured or controlled it, so cohort exclusion
    // must hand off without pausing it or rewriting the user's audio state.
    playerVisible = true;
    vi.advanceTimersByTime(100);
    expect(
      controller.handleCommit(HOST_ID, {
        type: 'youtube-zero-start-commit',
        version: 1,
        runId: 'cold-late-player-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        startAtHost: prepareAtHost + 3_000,
        reason: 'guest-timeout',
        cohort: [HOST_ID],
      }),
    ).toBe(true);

    expect(fallback).toHaveBeenCalledOnce();
    expect(player.__log).toEqual([]);
    expect(player.isMuted()).toBe(true);
    expect(player.getVolume()).toBe(23);
  });

  it('advertises and deduplicates runtime readiness across cold and ready states', () => {
    const player = makeFakeYtPlayer();
    const outbound: YouTubeZeroStartWireMessage[] = [];
    let playerReady = false;
    let audioUnlocked = false;
    let clockCalibrated = false;
    const controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => (playerReady ? (player as YouTubeZeroStartPlayer) : null),
      isPlayerReady: () => playerReady,
      isAudioUnlocked: () => audioUnlocked,
      isClockCalibrated: () => clockCalibrated,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'ios',
      sendToPeer: () => false,
      sendToHost: (message) => {
        outbound.push(message);
        return true;
      },
    });

    expect(controller.advertiseCapability()).toBe(true);
    expect(outbound).toEqual([
      {
        type: 'youtube-zero-start-capability',
        version: 2,
        platform: 'ios',
        ready: false,
      },
    ]);

    playerReady = true;
    audioUnlocked = true;
    expect(controller.advertiseCapability()).toBe(true);
    expect(outbound).toHaveLength(1);

    clockCalibrated = true;
    expect(controller.advertiseCapability()).toBe(true);
    expect(controller.advertiseCapability()).toBe(true);
    expect(outbound.at(-1)).toMatchObject({ version: 2, ready: true });
    expect(outbound).toHaveLength(2);

    playerReady = false;
    expect(controller.advertiseCapability()).toBe(true);
    expect(outbound.at(-1)).toMatchObject({ version: 2, ready: false });
    expect(outbound).toHaveLength(3);
  });

  it('hard-mutes before load, restores intentional audio state, and releases an all-ready cohort together', () => {
    const harness = makeHarness({ guestOffsetSec: 0.25, guestVolume: 0, guestMuted: true });
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(harness.host.canBeginHostTransition()).toBe(true);

    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(620);

    const commit = harness.hostOutbound.find(
      (message) => message.type === 'youtube-zero-start-commit',
    );
    expect(commit).toMatchObject({
      reason: 'all-ready',
      cohort: [HOST_ID, GUEST_ID],
      startAtHost: Date.now() + 700,
    });
    expect(harness.hostPlayer.getVolume()).toBe(37);
    expect(harness.hostPlayer.isMuted()).toBe(false);
    expect(harness.guestPlayer.getVolume()).toBe(0);
    expect(harness.guestPlayer.isMuted()).toBe(true);
    expect(harness.guestPlayer.__log.find((call) => call.op === 'loadVideoById')?.args).toEqual([
      VIDEO_ID,
      0.25,
    ]);
    expect(harness.guestPlayer.__log.find((call) => call.op === 'seekTo')?.args).toEqual([
      0.25,
      true,
    ]);

    vi.advanceTimersByTime(700);
    const hostPlay = [...harness.hostPlayer.__log]
      .reverse()
      .find((call) => call.op === 'playVideo');
    const guestPlay = [...harness.guestPlayer.__log]
      .reverse()
      .find((call) => call.op === 'playVideo');
    expect(hostPlay?.at).toBe(guestPlay?.at);
    expect(harness.host.getSnapshot().phase).toBe('playing');
    expect(harness.guest.getSnapshot().phase).toBe('playing');
    expect(harness.host.isProtocolActive()).toBe(true);
    expect(harness.guest.isProtocolActive()).toBe(true);

    vi.advanceTimersByTime(2_750);
    expect(harness.host.isProtocolActive()).toBe(false);
    expect(harness.guest.isProtocolActive()).toBe(false);
    expect(harness.host.getSnapshot().phase).toBe('idle');
    expect(harness.guest.getSnapshot().phase).toBe('idle');
  });

  it('restores a mute choice made while the next track is warming', () => {
    const harness = makeHarness({ hostVolume: 72 });
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(1);
    expect(harness.host.getSnapshot().phase).toBe('warming');
    harness.host.updateDesiredAudioState({ muted: true, volume: 0 });

    vi.advanceTimersByTime(619);
    expect(harness.hostPlayer.getVolume()).toBe(0);
    expect(harness.hostPlayer.isMuted()).toBe(true);
  });

  it('pauses a hard-muted warm-up before restoring audio on cancellation', () => {
    const harness = makeHarness({ hostVolume: 64 });
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(1);
    expect(harness.host.getSnapshot().phase).toBe('warming');
    harness.hostPlayer.__log.length = 0;
    harness.host.cancel('authority-changed', true);

    const operations = harness.hostPlayer.__log.map((call) => call.op);
    expect(operations.indexOf('pauseVideo')).toBeGreaterThanOrEqual(0);
    expect(operations.indexOf('pauseVideo')).toBeLessThan(operations.indexOf('unMute'));
    expect(harness.hostPlayer.getPlayerState()).toBe(2);
    expect(harness.hostPlayer.isMuted()).toBe(false);
    expect(harness.hostPlayer.getVolume()).toBe(64);
  });

  it('does not stop established playback when only post-release calibration is cancelled', () => {
    const harness = makeHarness();
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);
    vi.advanceTimersByTime(1_400);
    expect(harness.host.getSnapshot().phase).toBe('playing');

    harness.hostPlayer.__log.length = 0;
    harness.host.cancel('superseded', true);

    expect(harness.hostPlayer.__log.some((call) => call.op === 'pauseVideo')).toBe(false);
    expect(harness.hostPlayer.getPlayerState()).toBe(1);
  });

  it('does not ABORT healthy guests when a connection is replaced during calibration', () => {
    const harness = makeHarness();
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);
    vi.advanceTimersByTime(1_400);
    expect(harness.host.getSnapshot().phase).toBe('playing');
    expect(harness.guest.getSnapshot().phase).toBe('playing');

    harness.hostOutbound.length = 0;
    harness.host.handlePeerConnectionReplaced(GUEST_ID);

    expect(
      harness.hostOutbound.some((message) => message.type === 'youtube-zero-start-abort'),
    ).toBe(false);
    expect(harness.host.getSnapshot().phase).toBe('idle');
    expect(harness.hostPlayer.getPlayerState()).toBe(1);
    expect(harness.guestPlayer.getPlayerState()).toBe(1);
  });

  it('returns to idle within a bounded window when release play never reports PLAYING', () => {
    const harness = makeHarness();
    harness.hostPlayer.playVideo = () => {
      // Model an iframe that accepts playVideo() but never emits PLAYING.
      // Keep the call visible without mutating the fake player's state.
      harness.hostPlayer.__log.push({ op: 'playVideo', at: Date.now() });
    };

    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(620);
    vi.advanceTimersByTime(700);
    expect(harness.host.getSnapshot().phase).toBe('starting');
    expect(harness.hostPlayer.__log.some((call) => call.op === 'playVideo')).toBe(true);

    vi.advanceTimersByTime(10_000);

    expect(harness.host.isProtocolActive()).toBe(false);
    expect(harness.host.getSnapshot()).toMatchObject({
      phase: 'idle',
      runId: null,
    });
  });

  it('aborts the frozen cohort and hands off once when a COMMIT send fails', () => {
    const fallback = vi.fn();
    const harness = makeHarness({
      failHostCommitSend: true,
      onHostFallbackRequired: fallback,
    });
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(620);

    const releaseMessages = harness.hostOutbound.filter(
      (message) =>
        message.type === 'youtube-zero-start-commit' || message.type === 'youtube-zero-start-abort',
    );
    expect(releaseMessages.map((message) => message.type)).toEqual([
      'youtube-zero-start-commit',
      'youtube-zero-start-abort',
    ]);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        reason: 'commit-send-failed',
      }),
    );
    expect(harness.host.isInFlight()).toBe(false);
    expect(harness.guest.isInFlight()).toBe(false);
    expect(harness.host.getSnapshot().phase).toBe('idle');
    expect(harness.guest.getSnapshot().phase).toBe('idle');
    expect(harness.hostPlayer.getPlayerState()).toBe(2);
    expect(harness.guestPlayer.getPlayerState()).toBe(2);

    vi.advanceTimersByTime(5_000);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('cancels a peer that accepted COMMIT when a later cohort COMMIT send fails', () => {
    const fallback = vi.fn();
    const hostPlayer = makeFakeYtPlayer({ __autoPlayOnLoad: true });
    const firstGuestPlayer = makeFakeYtPlayer({ __autoPlayOnLoad: true });
    const secondGuestPlayer = makeFakeYtPlayer({ __autoPlayOnLoad: true });
    const delivered: Array<{ peerId: string; message: YouTubeZeroStartWireMessage }> = [];
    let host!: YouTubeZeroStartController;
    let firstGuest!: YouTubeZeroStartController;
    let secondGuest!: YouTubeZeroStartController;

    const common = {
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other' as const,
      createRunId: (sequence: number) => `partial-commit-${sequence}`,
    } satisfies Partial<YouTubeZeroStartDependencies>;

    host = new YouTubeZeroStartController({
      ...common,
      getRole: () => 'host',
      getLocalPeerId: () => HOST_ID,
      getHostPeerId: () => null,
      getLiveGuestPeerIds: () => [GUEST_ID, SECOND_GUEST_ID],
      getPlayer: () => hostPlayer as YouTubeZeroStartPlayer,
      sendToPeer: (peerId, message) => {
        delivered.push({ peerId, message });
        if (peerId === SECOND_GUEST_ID && message.type === 'youtube-zero-start-commit') {
          return false;
        }
        dispatchToGuest(peerId === GUEST_ID ? firstGuest : secondGuest, message);
        return true;
      },
      sendToHost: () => false,
      onHostFallbackRequired: fallback,
    } as YouTubeZeroStartDependencies);

    const makeGuest = (peerId: string, player: FakeYtPlayer) =>
      new YouTubeZeroStartController({
        ...common,
        getRole: () => 'guest',
        getLocalPeerId: () => peerId,
        getHostPeerId: () => HOST_ID,
        getLiveGuestPeerIds: () => [],
        getPlayer: () => player as YouTubeZeroStartPlayer,
        sendToPeer: () => false,
        sendToHost: (message) => {
          if (message.type === 'youtube-zero-start-capability') {
            host.handleCapability(peerId, message);
          } else if (message.type === 'youtube-zero-start-armed') {
            host.handleArmed(peerId, message);
          }
          return true;
        },
      } as YouTubeZeroStartDependencies);

    firstGuest = makeGuest(GUEST_ID, firstGuestPlayer);
    secondGuest = makeGuest(SECOND_GUEST_ID, secondGuestPlayer);
    hostPlayer.__onStateChange = ({ data }) => host.handlePlayerStateChange(data);
    firstGuestPlayer.__onStateChange = ({ data }) => firstGuest.handlePlayerStateChange(data);
    secondGuestPlayer.__onStateChange = ({ data }) => secondGuest.handlePlayerStateChange(data);

    expect(firstGuest.advertiseCapability()).toBe(true);
    expect(secondGuest.advertiseCapability()).toBe(true);
    expect(
      host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(620);

    expect(
      delivered
        .filter(
          ({ peerId, message }) =>
            peerId === GUEST_ID &&
            (message.type === 'youtube-zero-start-commit' ||
              message.type === 'youtube-zero-start-abort'),
        )
        .map(({ message }) => message.type),
    ).toEqual(['youtube-zero-start-commit', 'youtube-zero-start-abort']);
    expect(firstGuest.getSnapshot().phase).toBe('idle');
    expect(secondGuest.getSnapshot().phase).toBe('idle');
    expect(fallback).toHaveBeenCalledTimes(1);

    firstGuestPlayer.__log.length = 0;
    vi.advanceTimersByTime(2_000);
    expect(firstGuestPlayer.__log.some((call) => call.op === 'playVideo')).toBe(false);
    expect(firstGuestPlayer.getPlayerState()).toBe(2);
  });

  it('fails a host warm-up finitely when load never reports PLAYING', () => {
    const fallback = vi.fn();
    const harness = makeHarness({ onHostFallbackRequired: fallback });
    harness.hostPlayer.__autoPlayOnLoad = false;
    expect(harness.guest.advertiseCapability()).toBe(true);
    expect(
      harness.host.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(1);
    expect(harness.host.getSnapshot().phase).toBe('warming');
    vi.advanceTimersByTime(10_000);

    expect(harness.host.isProtocolActive()).toBe(false);
    expect(harness.host.isInFlight()).toBe(false);
    expect(harness.host.getSnapshot().phase).toBe('idle');
    expect(harness.guest.getSnapshot().phase).toBe('idle');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'prepare-timeout' }));
  });

  it('bounds a guest warm-up and retains identity for COMMIT recovery', () => {
    const fallback = vi.fn();
    const outbound: YouTubeZeroStartWireMessage[] = [];
    let controller!: YouTubeZeroStartController;
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: false });
    player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
    controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => player as YouTubeZeroStartPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: () => false,
      sendToHost: (message) => {
        outbound.push(message);
        return true;
      },
      onFallbackRequired: fallback,
    });
    const prepareAtHost = Date.now();
    expect(
      controller.handlePrepare(HOST_ID, {
        type: 'youtube-zero-start-prepare',
        version: 1,
        runId: 'guest-warm-timeout',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);

    vi.advanceTimersByTime(10_001);
    expect(controller.isInFlight()).toBe(false);
    expect(controller.isProtocolActive()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'guest-warm-timeout',
      phase: 'error',
    });
    expect(outbound.some((message) => message.type === 'youtube-zero-start-armed')).toBe(false);

    expect(
      controller.handleCommit(HOST_ID, {
        type: 'youtube-zero-start-commit',
        version: 1,
        runId: 'guest-warm-timeout',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        startAtHost: prepareAtHost + 10_500,
        reason: 'guest-timeout',
        cohort: [HOST_ID],
      }),
    ).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'guest-warm-timeout',
        reason: 'prepare-failed',
      }),
    );
  });

  it('hands an unarmed excluded guest to bounded fallback at the host decision', () => {
    const fallback = vi.fn();
    let controller!: YouTubeZeroStartController;
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: false });
    player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
    controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => player as YouTubeZeroStartPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: () => false,
      sendToHost: () => true,
      onFallbackRequired: fallback,
    });
    const prepareAtHost = Date.now();
    controller.handlePrepare(HOST_ID, {
      type: 'youtube-zero-start-prepare',
      version: 1,
      runId: 'excluded-unarmed-run',
      sequence: 1,
      queueItemId: QUEUE_ITEM_ID,
      videoId: VIDEO_ID,
      subIndex: null,
      prepareAtHost,
      decisionAtHost: prepareAtHost + 2_300,
      startDeadlineAtHost: prepareAtHost + 3_000,
      hostPlatform: 'other',
    });
    vi.advanceTimersByTime(2_300);

    expect(controller.getSnapshot().phase).toBe('warming');
    expect(
      controller.handleCommit(HOST_ID, {
        type: 'youtube-zero-start-commit',
        version: 1,
        runId: 'excluded-unarmed-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        startAtHost: prepareAtHost + 3_000,
        reason: 'guest-timeout',
        cohort: [HOST_ID],
      }),
    ).toBe(true);

    expect(controller.isInFlight()).toBe(false);
    expect(controller.isProtocolActive()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'excluded-unarmed-run',
      phase: 'error',
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'excluded-unarmed-run',
        reason: 'cohort-excluded',
        startAtHost: prepareAtHost + 3_000,
        targetPositionSec: 0,
      }),
    );

    vi.advanceTimersByTime(10_000);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('does not leave an armed guest busy forever when COMMIT is missing', () => {
    const fallback = vi.fn();
    let controller!: YouTubeZeroStartController;
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: true });
    player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
    controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => player as YouTubeZeroStartPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: () => false,
      sendToHost: () => true,
      onFallbackRequired: fallback,
    });
    const prepareAtHost = Date.now();
    expect(
      controller.handlePrepare(HOST_ID, {
        type: 'youtube-zero-start-prepare',
        version: 1,
        runId: 'missing-commit-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);

    vi.advanceTimersByTime(700);
    expect(controller.getSnapshot().phase).toBe('armed');
    vi.advanceTimersByTime(2_301);

    expect(controller.isInFlight()).toBe(false);
    expect(controller.isProtocolActive()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'missing-commit-run',
      phase: 'error',
    });
    expect(player.getPlayerState()).toBe(2);
    expect(fallback).not.toHaveBeenCalled();

    // A delayed exact COMMIT remains authoritative and is the only event that
    // may release this failed run. Recovery recomputes the live canonical
    // target instead of replaying a stale 0-second deadline from the past.
    expect(
      controller.handleCommit(HOST_ID, {
        type: 'youtube-zero-start-commit',
        version: 1,
        runId: 'missing-commit-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        startAtHost: prepareAtHost + 3_500,
        reason: 'host-delayed',
        cohort: [HOST_ID],
      }),
    ).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'missing-commit-run',
        reason: 'prepare-failed',
        startAtHost: prepareAtHost + 3_500,
      }),
    );
    expect(controller.isInFlight()).toBe(false);
    expect(controller.isProtocolActive()).toBe(false);
  });

  it('commits at the three-second deadline without an unarmed guest', () => {
    const outbound: YouTubeZeroStartWireMessage[] = [];
    let controller!: YouTubeZeroStartController;
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: true });
    player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
    controller = new YouTubeZeroStartController({
      getRole: () => 'host',
      getLocalPeerId: () => HOST_ID,
      getHostPeerId: () => null,
      getLiveGuestPeerIds: () => [GUEST_ID],
      getPlayer: () => player as YouTubeZeroStartPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: (_peerId, message) => {
        outbound.push(message);
        return true;
      },
      sendToHost: () => false,
      createRunId: () => 'timeout-run',
    });
    controller.handleCapability(GUEST_ID, {
      type: 'youtube-zero-start-capability',
      version: 2,
      platform: 'other',
      ready: true,
    });
    const beganAt = Date.now();
    expect(
      controller.beginHostTransition({
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
      }),
    ).toBe(true);

    vi.advanceTimersByTime(2_300);

    expect(outbound.find((message) => message.type === 'youtube-zero-start-commit')).toMatchObject({
      reason: 'guest-timeout',
      cohort: [HOST_ID],
      startAtHost: beganAt + 3_000,
    });
  });

  it('keeps PREPARE identity when the player is unavailable and requests fallback on COMMIT', () => {
    const fallback = vi.fn();
    const controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => null,
      isPlayerReady: () => false,
      isAudioUnlocked: () => false,
      isClockCalibrated: () => true,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'ios',
      sendToPeer: () => false,
      sendToHost: () => false,
      onFallbackRequired: fallback,
    });
    const prepareAtHost = Date.now();

    expect(
      controller.handlePrepare(HOST_ID, {
        type: 'youtube-zero-start-prepare',
        version: 1,
        runId: 'missing-player-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      runId: 'missing-player-run',
      phase: 'waiting-ready',
    });

    expect(
      controller.handleCommit(HOST_ID, {
        type: 'youtube-zero-start-commit',
        version: 1,
        runId: 'missing-player-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        startAtHost: prepareAtHost + 3_000,
        reason: 'guest-timeout',
        cohort: [HOST_ID],
      }),
    ).toBe(true);
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'missing-player-run',
        reason: 'cohort-excluded',
        startAtHost: prepareAtHost + 3_000,
      }),
    );
  });

  it('hands an armed uncalibrated guest to external fallback without leaving busy active', () => {
    const fallback = vi.fn();
    const busy = vi.fn();
    const outbound: YouTubeZeroStartWireMessage[] = [];
    let clockCalibrated = true;
    let controller!: YouTubeZeroStartController;
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: true });
    player.__onStateChange = ({ data }) => controller.handlePlayerStateChange(data);
    controller = new YouTubeZeroStartController({
      getRole: () => 'guest',
      getLocalPeerId: () => GUEST_ID,
      getHostPeerId: () => HOST_ID,
      getLiveGuestPeerIds: () => [],
      getPlayer: () => player as YouTubeZeroStartPlayer,
      isPlayerReady: () => true,
      isAudioUnlocked: () => true,
      isClockCalibrated: () => clockCalibrated,
      getHostNow: () => Date.now(),
      getClockOffsetMs: () => 0,
      getLocalPlatform: () => 'other',
      sendToPeer: () => false,
      sendToHost: (message) => {
        outbound.push(message);
        return true;
      },
      onFallbackRequired: fallback,
      onBusyChange: busy,
    });
    const prepareAtHost = Date.now();

    expect(
      controller.handlePrepare(HOST_ID, {
        type: 'youtube-zero-start-prepare',
        version: 1,
        runId: 'uncalibrated-guest-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);
    vi.advanceTimersByTime(620);
    expect(outbound.some((message) => message.type === 'youtube-zero-start-armed')).toBe(true);
    expect(controller.getSnapshot().phase).toBe('armed');
    clockCalibrated = false;

    expect(
      controller.handleCommit(HOST_ID, {
        type: 'youtube-zero-start-commit',
        version: 1,
        runId: 'uncalibrated-guest-run',
        sequence: 1,
        queueItemId: QUEUE_ITEM_ID,
        videoId: VIDEO_ID,
        startAtHost: prepareAtHost + 3_000,
        reason: 'all-ready',
        cohort: [HOST_ID, GUEST_ID],
      }),
    ).toBe(true);

    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'uncalibrated-guest-run',
        reason: 'clock-uncalibrated',
      }),
    );
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(controller.isInFlight()).toBe(false);
    expect(controller.isProtocolActive()).toBe(false);
  });

  it('keeps fixed audible output delay separate from YouTube timeline bias', () => {
    expect(getYouTubeZeroStartRelativeLead('android', 'other')).toEqual({
      audibleBaseLeadMs: 250,
      timelineLeadMs: 0,
      totalLeadMs: 250,
    });
    expect(getYouTubeZeroStartRelativeLead('ios', 'other')).toEqual({
      audibleBaseLeadMs: 0,
      timelineLeadMs: 270,
      totalLeadMs: 270,
    });
    expect(getYouTubeZeroStartRelativeLead('ios', 'android')).toEqual({
      audibleBaseLeadMs: -250,
      timelineLeadMs: 270,
      totalLeadMs: 20,
    });
    expect(getYouTubeZeroStartRelativeLead('ios', 'android', 10_000)).toEqual({
      audibleBaseLeadMs: -250,
      timelineLeadMs: 600,
      totalLeadMs: 350,
    });
  });
});
