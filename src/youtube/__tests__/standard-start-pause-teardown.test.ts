/**
 * @vitest-environment jsdom
 *
 * Standard-room start pause and teardown pins (pinned 2026-10-30): what a
 * local pause, a headset or Media Session pause, and leaving the room do to
 * the YouTube start owners today, while each owner still holds the iframe.
 *
 * Real: initYouTube's wiring, youtube/iframe.ts behind a scripted IFrame API,
 * core/timers, the protocol dispatcher, the zero-start controller and
 * network/peer.ts's leaveSession (a partial mock spies on the sends only, so
 * leaveSession's own order runs as in production; core/wake-lock.ts is
 * mocked as in peer.test.ts). The remote participant is the real zero-start
 * controller on its own fake iframe (standard-start-harness.ts).
 *
 * A pause reaches the App two ways, and the rows keep them apart: the page's
 * Media Session handler (media-session.ts, which calls togglePlay), and the
 * iframe's own PAUSE (a headset or lock-screen control that iOS routes to the
 * iframe, or the iframe's own pause button), which the native-control
 * authority classifies and promotes. Those rows start the authority with the
 * Media Session stub before the iframe handshake, as the App does at boot, so
 * the handshake instruments the iframe the way it instruments a real one.
 *
 * A row marked "Looks like a defect" pins today's behaviour, not claimed right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { broadcast, leaveSession, safeSend, sendToHost } from '../../network/peer.ts';
import { initMediaSession } from '../../player/media-session.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { isStandardHostYouTubeLocalStartPending } from '../local-offset.ts';
import { stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import { getYouTubeZeroStartPendingCanonicalPosition } from '../zero-start.ts';
import {
  createFakeClockStarter,
  frameRoutes,
  makeMediaCommandsSlow,
  makeReleaseStall,
  opTrace,
  predicateFlags,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
  type StandardRigOptions,
} from './__helpers__/standard-start-harness.ts';

const wakeLock = vi.hoisted(() => ({ deactivateNoSleep: vi.fn() }));
vi.mock('../../core/wake-lock.ts', () => ({ deactivateNoSleep: wakeLock.deactivateNoSleep }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer.ts')>()),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
}));

const IDENTITY = {
  queueItemId: '90000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'pauseTeard1',
  nextQueueItemId: '90000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'pauseTeard2',
};
const SCENARIOS = standardScenarios(IDENTITY);
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));
let rig: StandardRig | null = null;
let restoreMediaSession: (() => void) | null = null;

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  rig?.dispose();
  rig = null;
  restoreMediaSession?.();
  restoreMediaSession = null;
  cancelYouTubeAuthorityPreparation();
  stopYouTubeMode({ silent: true });
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  bus.clear();
  resetState();
  document.body.innerHTML = '';
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete window.onYouTubeIframeAPIReady;
});

async function startRig(
  role: 'host' | 'guest',
  extra: Partial<StandardRigOptions> = {},
): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: '100001',
    ...IDENTITY,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...extra,
  });
  return rig;
}

function after(current: StandardRig, opIndex: number, frameIndex: number) {
  return {
    ops: opTrace(current.iframe(), current.t0, opIndex),
    routes: frameRoutes(current.sent.slice(frameIndex)).map((route, index) => {
      const state = current.sent[frameIndex + index]!.frame.state;
      return typeof state === 'number' ? `${route} state ${state}` : route;
    }),
    flags: predicateFlags(),
  };
}

/**
 * A Media Session stub whose action handlers the App registers. initMediaSession
 * also starts the native-control authority; call this before startRig, as the
 * App's boot does, so the iframe handshake instruments the iframe. afterEach
 * restores navigator.mediaSession.
 */
function installMediaSession() {
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: Record<string, unknown> = {}) {
        Object.assign(this, init);
      }
    },
  );
  const actions = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaSession');
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) =>
        actions.set(action, handler),
    },
  });
  restoreMediaSession = () => {
    if (descriptor) Object.defineProperty(navigator, 'mediaSession', descriptor);
    else Reflect.deleteProperty(navigator, 'mediaSession');
  };
  initMediaSession();
  return {
    trigger(action: MediaSessionAction) {
      expect(actions.has(action)).toBe(true);
      actions.get(action)?.({ action });
    },
  };
}

/** '+<ms> <route>[ state <n> at <s> s]' for every frame sent from frameIndex on. */
function framesAt(current: StandardRig, frameIndex: number): string[] {
  return current.sent.slice(frameIndex).map((sent) => {
    const [route] = frameRoutes([sent]);
    const { state, time } = sent.frame;
    const detail =
      typeof state === 'number' && typeof time === 'number'
        ? ` state ${state} at ${Math.round(time * 1_000) / 1_000} s`
        : '';
    return `+${sent.at} ${route}${detail}`;
  });
}

/**
 * youtube:auto-play intents from now on: the room action the native-control
 * authority promotes an iframe PAUSE or PLAY to (native-control-authority.ts
 * routeNativeAction).
 */
function recordRoomActions(current: StandardRig): string[] {
  const actions: string[] = [];
  bus.on('youtube:auto-play', (intent) => {
    if (typeof intent !== 'object') {
      actions.push(`+${current.now()} ${String(intent)}`);
      return;
    }
    const target =
      intent.targetTime === undefined ? '-' : `${Math.round(intent.targetTime * 1_000) / 1_000} s`;
    actions.push(
      `+${current.now()} state ${intent.state ?? '-'} at ${target}` +
        `${intent.zeroStart ? ' zero-start' : ''}${intent.skipSeek ? ' skip-seek' : ''}`,
    );
  });
  return actions;
}

/** The two speaker holds now: the legacy slot and the zero-start hold. */
function holds(): string {
  const position = getYouTubeZeroStartPendingCanonicalPosition();
  return `legacy ${isStandardHostYouTubeLocalStartPending()} zero-start ${
    position === null ? 'null' : position.toFixed(3)
  }`;
}

describe('Standard host at a -5 s local offset in a zero-start run (pinned 2026-10-30)', () => {
  /** The host's release (+6422, after its 5 s speaker hold) buffers and never reports PLAYING. */
  async function heldReleaseHost(): Promise<StandardRig> {
    const current = await startRig('host', { localOffsetSeconds: -5 });
    makeReleaseStall(current.iframe(), 2);
    await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: 6_600 });
    return current;
  }

  it("lets BUFFERING during 'starting' through to the ordinary iframe path, which reads only the legacy hold", async () => {
    const current = await heldReleaseHost();
    // zero-start.ts:820 returns false for BUFFERING in 'starting', and
    // iframe.ts:3122 reads only the legacy slot, so nothing holds the event.
    expect({
      holds: holds(),
      flags: predicateFlags(),
      state: current.iframe().getPlayerState(),
    }).toEqual({
      holds: 'legacy false zero-start 5.178',
      flags: 'owned inFlight protocol -',
      state: 3,
    });
  });

  it("restarts the room from 0.178 s on a Media Session pause during 'starting'", async () => {
    const session = installMediaSession();
    const current = await heldReleaseHost();
    const opIndex = current.iframe().__log.length;
    const frameIndex = current.sent.length;
    session.trigger('pause');
    await current.advanceTo(14_000);
    // Looks like a defect: the pause reaches togglePlay, which sees a
    // BUFFERING iframe and no legacy hold (the zero-start hold is not in
    // that slot), so it starts the room again from 0.178 s instead.
    expect(after(current, opIndex, frameIndex)).toEqual({
      ops: [
        '+6600 pauseVideo()',
        '+6600 setVolume(100)',
        '+6600 unMute()',
        '+6600 seekTo(0.178,true)',
        '+6600 playVideo()',
      ],
      routes: [
        'peer:guest-1 youtube-zero-start-abort',
        'broadcast:* youtube-state state 1',
        'broadcast:* youtube-state state 1',
        'broadcast:* youtube-sync state 1',
        'broadcast:* youtube-sync state 1',
      ],
      flags: '- - - -',
    });
  });
});

describe('Standard host at a -5 s local offset, Media Session pause during the zero-start speaker hold (pinned 2026-10-30)', () => {
  it("reads a Media Session pause during 'scheduled' as a new held start at the room position", async () => {
    const session = installMediaSession();
    const current = await startRig('host', { localOffsetSeconds: -5 });
    await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: 3_000 });
    const holdsBefore = holds();
    const opIndex = current.iframe().__log.length;
    const frameIndex = current.sent.length;
    session.trigger('pause');
    await current.advanceTo(6_000);
    // Looks like a defect: togglePlay reads the room position (1.578 s)
    // and starts a new legacy rendezvous there, held 3.4 s for the
    // offset, instead of pausing.
    expect({ holdsBefore, ...after(current, opIndex, frameIndex) }).toEqual({
      holdsBefore: 'legacy false zero-start 1.578',
      ops: [
        '+3000 pauseVideo()',
        '+3000 setVolume(100)',
        '+3000 unMute()',
        '+3000 pauseVideo()',
        '+3000 seekTo(0,true)',
      ],
      routes: ['peer:guest-1 youtube-zero-start-abort', 'broadcast:* youtube-state state 1'],
      flags: '- - - -',
    });
  });
});

describe("Standard host, the iframe's own PAUSE while a zero-start start holds the iframe (pinned 2026-10-31)", () => {
  // The iframe's own PAUSE is a PAUSED state change that no App command
  // caused (fake __setState(2)). The native-control authority classifies it
  // (native-control-origin.ts) and a Standard host promotes it to a room
  // pause: youtube:auto-play with state 2 (native-control-authority.ts:466).

  it("-5 s host: the iframe's own PAUSE during 'starting' is respected and pauses the room at 5.178 s", async () => {
    installMediaSession();
    const current = await startRig('host', { localOffsetSeconds: -5 });
    // The release (+6422) buffers and never reports PLAYING; BUFFERING
    // reaches the ordinary path, as the row above pins.
    makeReleaseStall(current.iframe(), 2);
    await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: 6_600 });
    const roomActions = recordRoomActions(current);
    const holdsBefore = holds();
    const opIndex = current.iframe().__log.length;
    const frameIndex = current.sent.length;
    current.iframe().__setState(2);
    await current.advanceTo(14_000);
    expect({
      holdsBefore,
      roomActions,
      ops: opTrace(current.iframe(), current.t0, opIndex),
      frames: framesAt(current, frameIndex),
      flags: predicateFlags(),
    }).toEqual({
      holdsBefore: 'legacy false zero-start 5.178',
      roomActions: ['+6600 state 2 at 5.178 s'],
      // The room pause cancels the run (its abort restores the audio), then
      // holds the host's iframe at its own offset position (5.178 - 5 s).
      ops: [
        '+6600 pauseVideo()',
        '+6600 setVolume(100)',
        '+6600 unMute()',
        '+6600 seekTo(0.178,true)',
        '+6600 pauseVideo()',
      ],
      frames: [
        '+6600 peer:guest-1 youtube-zero-start-abort',
        '+6600 broadcast:* youtube-state state 2 at 5.178 s',
        '+6600 broadcast:* youtube-state state 2 at 5.178 s',
        '+9000 broadcast:* youtube-sync state 2 at 5.178 s',
        '+12000 broadcast:* youtube-sync state 2 at 5.178 s',
      ],
      flags: '- - - -',
    });
  });

  // A 0 s host: the release PLAYING at +1422 starts the run's 2.75 s
  // calibration window, which ends at +4172. The warm-up's own pauseVideo
  // (+360) left a 'paused' record that lives 4 s (to +4360,
  // native-control-origin.ts EXPECTED_STATE_TTL_MS): zero-start consumed that
  // PAUSED callback (iframe.ts:3117) before the native-control path
  // (iframe.ts:3127), so nothing consumed the record.
  const ZERO_OFFSET_ROWS: Record<number, unknown> = {
    // Looks like a defect: inside the calibration window the authority reads
    // the iframe's own PAUSE as the warm-up's pause and does not promote it,
    // and the ordinary host YOUTUBE_STATE is held while the run owns sync
    // (iframe.ts:3368). Only the host's iframe stops; the room plays on until
    // the first heartbeat after the window (+6000) carries state 2.
    2_422: {
      flagsBefore: 'owned - protocol -',
      roomActions: [],
      ops: [],
      frames: [
        '+2672 peer:guest-1 youtube-zero-start-timeline',
        '+2922 peer:guest-1 youtube-zero-start-timeline',
        '+3172 peer:guest-1 youtube-zero-start-timeline',
        '+3422 peer:guest-1 youtube-zero-start-timeline',
        '+3672 peer:guest-1 youtube-zero-start-timeline',
        '+3922 peer:guest-1 youtube-zero-start-timeline',
        '+6000 broadcast:* youtube-sync state 2 at 1 s',
        '+9000 broadcast:* youtube-sync state 2 at 1 s',
      ],
    },
    // After the window, the record still reads the PAUSE as the warm-up's,
    // but the ordinary host YOUTUBE_STATE now pauses the room at once.
    4_300: {
      flagsBefore: '- - - -',
      roomActions: [],
      ops: [],
      frames: [
        '+4300 broadcast:* youtube-state state 2 at 2.878 s',
        '+6000 broadcast:* youtube-sync state 2 at 2.878 s',
        '+9000 broadcast:* youtube-sync state 2 at 2.878 s',
      ],
    },
    // After the record expires, the authority promotes the PAUSE to a room pause.
    5_000: {
      flagsBefore: '- - - -',
      roomActions: ['+5000 state 2 at 3.578 s'],
      ops: ['+5000 seekTo(3.578,true)', '+5000 pauseVideo()'],
      frames: [
        '+5000 broadcast:* youtube-state state 2 at 3.578 s',
        '+5000 broadcast:* youtube-state state 2 at 3.578 s',
        '+6000 broadcast:* youtube-sync state 2 at 3.578 s',
        '+9000 broadcast:* youtube-sync state 2 at 3.578 s',
      ],
    },
  };

  it.each([
    [2_422, 'inside the calibration window (1 s after the release)'],
    [4_300, "after the window, while the warm-up pause's record lives"],
    [5_000, 'after the window and the record'],
  ] as const)("0 s host: the iframe's own PAUSE at +%i, %s", async (at, _when) => {
    installMediaSession();
    const current = await startRig('host');
    await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: at });
    const roomActions = recordRoomActions(current);
    const flagsBefore = predicateFlags();
    const opIndex = current.iframe().__log.length;
    const frameIndex = current.sent.length;
    current.iframe().__setState(2);
    await current.advanceTo(10_000);
    expect({
      flagsBefore,
      roomActions,
      ops: opTrace(current.iframe(), current.t0, opIndex),
      frames: framesAt(current, frameIndex),
    }).toEqual(ZERO_OFFSET_ROWS[at]);
    expect(predicateFlags()).toBe('- - - -');
  });
});

describe('the legacy hold and the zero-start hold never coexist (pinned 2026-10-30)', () => {
  it('retires a pending legacy hold when zero-start begins, and cancels zero-start when a legacy start follows', async () => {
    const current = await startRig('host', { localOffsetSeconds: -5 });
    const samples: string[] = [`${current.now()} ${holds()}`];
    await current.advanceTo(100);
    // A legacy start at 0:00: the speaker waits 5 s (player.ts scheduleYtAutoSync).
    scheduleYtAutoSyncFromApp();
    samples.push(`${current.now()} ${holds()}`);
    await current.advanceTo(1_000);
    // A fresh 0:00 start asks for zero-start (player.ts:650 retires the hold).
    bus.emit('youtube:auto-play', {
      zeroStart: true,
      targetTime: 0,
      state: 1,
      videoId: IDENTITY.videoId,
    });
    samples.push(`${current.now()} ${holds()}`);
    await current.advanceTo(2_000);
    samples.push(`${current.now()} ${holds()}`);
    // A seek is a legacy start: it cancels the zero-start run (player.ts:704).
    bus.emit('youtube:seek-to', 0);
    samples.push(`${current.now()} ${holds()}`);
    await current.advanceTo(3_000);
    samples.push(`${current.now()} ${holds()}`);
    expect(samples).toEqual([
      '0 legacy false zero-start null',
      '100 legacy true zero-start null',
      '1000 legacy false zero-start null',
      '2000 legacy false zero-start 0.000',
      '2000 legacy true zero-start null',
      '3000 legacy true zero-start null',
    ]);
  });

  function scheduleYtAutoSyncFromApp(): void {
    bus.emit('youtube:auto-play', { targetTime: 0, state: 1, videoId: IDENTITY.videoId });
  }
});

describe('the two managed-timer cleanup loops stop on a local pause or leaveSession (pinned 2026-10-30)', () => {
  /**
   * Host: the iframe ignores every unMute, so the run's audio restore times
   * out, the legacy recovery times out after 3 s, and its verified cleanup
   * ('yt-zero-start-host-fallback') retries every 120 ms from +4561.
   */
  async function hostCleanupLoop(): Promise<StandardRig> {
    const current = await startRig('host', { iframeInit: { __unMuteIgnoreCount: 1_000 } });
    await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: 4_700 });
    return current;
  }

  /**
   * Guest: a cohort-excluded guest whose load never completes abandons at
   * its 7.7 s deadline; its verified cleanup ('yt-zero-start-external-fallback')
   * retries every 120 ms from +10102 because the iframe ignores every unMute.
   */
  async function guestCleanupLoop(): Promise<StandardRig> {
    const current = await startRig('guest', { iframeInit: { __unMuteIgnoreCount: 1_000 } });
    await runStandardScenario(current, { ...SCENARIOS.guestCohortExcluded(60_000), endAt: 10_300 });
    return current;
  }

  const CLEANUP_LOOP_STOPS: Record<string, unknown> = {
    'host a local pause': {
      flagsBefore: 'owned - - fallback',
      ops: [],
      // The ownership flag is down, so the next heartbeat goes out.
      routes: ['broadcast:* youtube-sync state 2'],
      flags: '- - - -',
    },
    'host leaveSession': {
      flagsBefore: 'owned - - fallback',
      ops: ['+4700 mute()', '+4700 pauseVideo()', '+4700 stopVideo()', '+4700 destroy()'],
      routes: ['broadcast:* youtube-stop', 'broadcast:* pause'],
      flags: '- - - -',
    },
    // Looks like a defect: the pause stops the fallback's cleanup loop, but
    // cancelling the zero-start run starts its own detached audio restore
    // (zero-start.ts:1979-2052), which keeps writing setVolume and unMute
    // every 120 ms, eight times, after the user paused.
    'guest a local pause': {
      flagsBefore: 'owned - - fallback',
      ops: [10_300, 10_420, 10_540, 10_660, 10_780, 10_900, 11_020, 11_140].flatMap((at) => [
        `+${at} setVolume(100)`,
        `+${at} unMute()`,
      ]),
      routes: [],
      flags: '- - - -',
    },
    'guest leaveSession': {
      flagsBefore: 'owned - - fallback',
      ops: ['+10300 mute()', '+10300 pauseVideo()', '+10300 stopVideo()', '+10300 destroy()'],
      routes: ['peer:host-1 youtube-zero-start-capability'],
      flags: '- - - -',
    },
  };

  const stops = {
    'a local pause': () => bus.emit('youtube:set-local-paused', true),
    leaveSession: () => leaveSession(),
  } as const;

  it.each([
    ['host', 'a local pause'],
    ['host', 'leaveSession'],
    ['guest', 'a local pause'],
    ['guest', 'leaveSession'],
  ] as const)(
    '%s cleanup loop: %s stops every later pause, seek, unMute and setVolume',
    async (role, stop) => {
      const current = role === 'host' ? await hostCleanupLoop() : await guestCleanupLoop();
      const flagsBefore = predicateFlags();
      const opIndex = current.iframe().__log.length;
      const frameIndex = current.sent.length;
      stops[stop]();
      await current.advanceTo(current.now() + 3_000);
      expect({ flagsBefore, ...after(current, opIndex, frameIndex) }).toEqual(
        CLEANUP_LOOP_STOPS[`${role} ${stop}`],
      );
    },
  );
});

describe('leaveSession while a start recovery is in flight (pinned 2026-10-30)', () => {
  it('ends the guest local recovery: no later op or frame, predicates false', async () => {
    const current = await startRig('guest');
    await runStandardScenario(current, { ...SCENARIOS.guestCohortExcluded(60_000), endAt: 3_000 });
    const flagsBefore = predicateFlags();
    const opIndex = current.iframe().__log.length;
    const frameIndex = current.sent.length;
    leaveSession();
    await current.advanceTo(15_000);
    expect({ flagsBefore, ...after(current, opIndex, frameIndex) }).toEqual({
      flagsBefore: 'owned - - fallback',
      // Only the teardown's own destroy; the recovery issues nothing later.
      ops: ['+3000 mute()', '+3000 pauseVideo()', '+3000 stopVideo()', '+3000 destroy()'],
      // stopYouTubeMode re-advertises readiness while hostConn is still set.
      routes: ['peer:host-1 youtube-zero-start-capability'],
      flags: '- - - -',
    });
  });

  it('ends the host legacy recovery: no later op or frame, predicates false', async () => {
    const current = await startRig('host', { iframeInit: { __hardMuteFails: true } });
    // The recovery's reload never reports a cueable target: UNSTARTED until it lands.
    const fake = current.iframe();
    makeMediaCommandsSlow(fake, 60_000);
    const slowLoad = fake.loadVideoById;
    fake.loadVideoById = (videoId: string, startSeconds?: number) => {
      slowLoad(videoId, startSeconds);
      fake.__setState(-1, false);
    };
    await runStandardScenario(current, { ...SCENARIOS.hostPrepareFailure, endAt: 1_000 });
    const flagsBefore = predicateFlags();
    const opIndex = current.iframe().__log.length;
    const frameIndex = current.sent.length;
    leaveSession();
    await current.advanceTo(9_000);
    expect({ flagsBefore, ...after(current, opIndex, frameIndex) }).toEqual({
      flagsBefore: 'owned - - fallback',
      ops: ['+1000 mute()', '+1000 pauseVideo()', '+1000 stopVideo()', '+1000 destroy()'],
      routes: ['broadcast:* youtube-stop', 'broadcast:* pause'],
      flags: '- - - -',
    });
  });
});
