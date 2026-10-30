/**
 * @vitest-environment jsdom
 *
 * C2-0 start-owner boundary (design increment 0), pinned 2026-10-30: what the
 * YouTube start owners do today, observed only at public seams, so later
 * Phase 6 increments can move the owners without changing any row.
 *
 * Real: initYouTube's wiring, youtube/iframe.ts's state dispatch behind a
 * scripted IFrame API, core/timers, the protocol dispatcher, the zero-start
 * controller, and for PRO the ProRoomPlaybackController with the playlist
 * media endpoint (initPlaylist). Fakes at the edges only: the iframe
 * (fake-yt-player.ts), the network sends (recorded), the shared clock and
 * the PRO server clock (calibrated, reading Date.now()), log and toasts. The
 * remote Standard participant is the real zero-start controller on its own
 * fake iframe (standard-start-harness.ts), so no wire timing is retyped.
 *
 * Each row asserts only public observations: the App iframe's op log with
 * instants relative to t0 (the iframe handshake), the frames sent (type,
 * recipient, order), youtube:sync-loading for the 'zero-start' owner with its
 * instants, and the zero-start phase with the four public predicates
 * (owned = isYouTubeZeroStartSyncOwned, inFlight = isYouTubeZeroStartInFlight,
 * protocol = isYouTubeZeroStartProtocolActive, fallback =
 * isYouTubeZeroStartExternalFallbackActiveFromIframe), sampled every 10 ms and
 * listed where they change. No managed-timer name or module-private flag is
 * read.
 *
 * A row marked "Looks like a defect" pins today's behaviour, not claimed
 * right. The Standard to PRO mid-run switch is trace T1 in
 * youtube-room-switch-trace.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { initProtocol, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState, setYtPrimed } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import { canUseYouTubeZeroStart } from '../zero-start.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  frameRoutes,
  opTrace,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  syntheticConnection,
  type StandardRig,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

const clockUnderTest = vi.hoisted(() => ({ calibrated: true }));
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
  isClockCalibrated: () => clockUnderTest.calibrated,
}));
// A calibrated PRO server clock that reads this device's own time.
vi.mock('../../pro-room/network-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pro-room/network-bridge.ts')>();
  const snapshot = () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: 0,
    rttMs: 10,
    sampledAtMs: performance.now(),
    roundId: 1,
    source: 'ready' as const,
  });
  return {
    ...actual,
    getProRoomServerNow: () => Date.now(),
    isProRoomServerClockCalibrated: () => true,
    captureProRoomServerClockSnapshot: () => snapshot(),
    isProRoomClockSnapshotCurrent: () => true,
    acquireProRoomServerClock: async (options: {
      serverDeadlineAtMs?: number;
      signal?: AbortSignal;
    }) =>
      !options.signal?.aborted && Date.now() <= (options.serverDeadlineAtMs ?? Infinity)
        ? snapshot()
        : null,
  };
});

/** A synthetic Standard room code (isActiveStandardRoomCoordinator needs a leading 1-9). */
const STANDARD_ROOM_CODE = '100001';
const HOST_PEER_ID = 'host-1';
const GUEST_PEER_ID = 'guest-1';
const IDENTITY = {
  queueItemId: '70000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'zeroStartA1',
  nextQueueItemId: '70000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'zeroStartB2',
};
const SCENARIOS = standardScenarios(IDENTITY);

const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '60000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'proVideoA01',
  transitionId: `transition_${'b'.repeat(22)}`,
});

let rig: StandardRig | null = null;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  resetProPlaybackAuthorityHooks();
  resetProStartObservations();
  registerProPlaybackMediaEndpoint(null);
  clockUnderTest.calibrated = true;
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  rig?.dispose();
  rig = null;
  PRO.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
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

async function startRig(scenario: StandardScenario): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role: scenario.role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: STANDARD_ROOM_CODE,
    ...IDENTITY,
    hostPeerId: HOST_PEER_ID,
    guestPeerId: GUEST_PEER_ID,
    ...scenario.rig,
  });
  return rig;
}

async function project(scenario: StandardScenario) {
  const current = await startRig(scenario);
  const marks = await runStandardScenario(current, scenario);
  return {
    ops: opTrace(current.iframe(), current.t0),
    routes: frameRoutes(current.sent),
    loading: current.loading
      .filter(({ owner }) => owner === 'zero-start')
      .map(({ busy, at }) => `+${at} ${busy ? 'busy' : 'idle'}`),
    marks,
  };
}

// ─── Expected observations (today's values) ────────────────────────

/** A Standard host's hard-muted warm-up of the resident video after play at +100 ms. */
const HOST_WARM_UP = [
  '+100 mute()',
  '+100 setVolume(100)',
  '+100 mute()',
  '+100 playVideo()',
  '+360 pauseVideo()',
  '+440 seekTo(0,true)',
];
/** The same warm-up on a guest that receives the remote host's PREPARE at +100 ms. */
const GUEST_WARM_UP = [
  '+100 mute()',
  '+101 setVolume(100)',
  '+101 mute()',
  '+101 playVideo()',
  '+361 pauseVideo()',
  '+441 seekTo(0,true)',
];
/** A guest that starts the remote host's next occurrence: replace-media, load issued. */
const GUEST_LOAD = [
  '+100 mute()',
  '+101 setVolume(100)',
  '+101 mute()',
  '+101 loadVideoById(zeroStartB2,0)',
  // The host's COMMIT excludes the guest; the controller stops the warm-up.
  '+2401 pauseVideo()',
];
const TIMELINE_SAMPLES = Array.from(
  { length: 10 },
  () => `peer:${GUEST_PEER_ID} youtube-zero-start-timeline`,
);
const HOST_MARKS = [
  '0 idle - - - -',
  '100 muting owned inFlight protocol -',
  '110 warming owned inFlight protocol -',
  '360 settling owned inFlight protocol -',
  '600 restoring-audio owned inFlight protocol -',
  '720 armed owned inFlight protocol -',
  '730 scheduled owned inFlight protocol -',
  '1430 playing owned - protocol -',
  '4180 idle - - - -',
];
const GUEST_MARKS = [
  '0 idle - - - -',
  '110 warming owned inFlight protocol -',
  '370 settling owned inFlight protocol -',
  '610 restoring-audio owned inFlight protocol -',
  '730 scheduled owned inFlight protocol -',
  '1430 playing owned - protocol -',
  '4180 idle - - - -',
];
const EXCLUDED_MARKS_BEFORE_START = [
  '0 idle - - - -',
  '110 warming owned inFlight protocol -',
  '2410 error owned - - fallback',
  '3100 error owned - - -',
  '3110 error - - - -',
];
/** After the guest fallback settles (+2702) it holds the target muted until startAtHost (+3100). */
const EXCLUDED_HOLD_AND_RELEASE = (volume: number) => [
  '+2702 pauseVideo()',
  '+2702 seekTo(0,true)',
  '+2752 mute()',
  '+2752 pauseVideo()',
  '+2752 seekTo(0,true)',
  `+3100 setVolume(${volume})`,
  '+3100 unMute()',
  '+3100 pauseVideo()',
  '+3100 seekTo(0,true)',
  `+3100 setVolume(${volume})`,
  '+3100 unMute()',
  '+3100 playVideo()',
];

describe('C2-0 start-owner boundary: Standard room scenarios (pinned 2026-10-30)', () => {
  it('host all-ready release', async () => {
    expect(await project(SCENARIOS.hostAllReady)).toEqual({
      ops: [
        ...HOST_WARM_UP,
        '+600 setVolume(100)',
        '+600 unMute()',
        // COMMIT at +722 (both armed), start 700 ms later; unMute on PLAYING.
        '+1422 playVideo()',
        '+1422 unMute()',
      ],
      routes: [
        `peer:${GUEST_PEER_ID} youtube-zero-start-prepare`,
        `peer:${GUEST_PEER_ID} youtube-zero-start-commit`,
        ...TIMELINE_SAMPLES,
        // The heartbeat at +3000 is held back while the run owns sync.
        'broadcast:* youtube-sync',
        'broadcast:* youtube-sync',
      ],
      loading: ['+100 busy', '+1422 idle'],
      marks: HOST_MARKS,
    });
  });

  it('guest all-ready release', async () => {
    expect(await project(SCENARIOS.guestAllReady)).toEqual({
      ops: [
        ...GUEST_WARM_UP,
        '+601 setVolume(100)',
        '+601 unMute()',
        '+1422 playVideo()',
        '+1422 unMute()',
      ],
      routes: [`peer:${HOST_PEER_ID} youtube-zero-start-armed`],
      loading: ['+100 busy', '+1422 idle'],
      marks: GUEST_MARKS,
    });
  });

  it('guest cohort-excluded with the load issued, released before startAtHost', async () => {
    // The host decides at +2400 without this guest; its load is ready at +2701.
    expect(await project(SCENARIOS.guestCohortExcluded(2_600))).toEqual({
      ops: [...GUEST_LOAD, ...EXCLUDED_HOLD_AND_RELEASE(100)],
      routes: [],
      loading: ['+100 busy', '+2401 idle'],
      marks: EXCLUDED_MARKS_BEFORE_START,
    });
  });

  it('guest cohort-excluded with the load issued, released after startAtHost', async () => {
    // The load is ready at +4101, 1 s after startAtHost (+3100): the release
    // seeks to the room position there (1.052 s) and plays at once.
    expect(await project(SCENARIOS.guestCohortExcluded(4_000))).toEqual({
      ops: [
        ...GUEST_LOAD,
        '+4102 pauseVideo()',
        '+4102 seekTo(0,true)',
        '+4152 setVolume(100)',
        '+4152 unMute()',
        '+4152 pauseVideo()',
        '+4152 seekTo(1.052,true)',
        '+4152 setVolume(100)',
        '+4152 unMute()',
        '+4152 playVideo()',
      ],
      routes: [],
      loading: ['+100 busy', '+2401 idle'],
      marks: [
        '0 idle - - - -',
        '110 warming owned inFlight protocol -',
        '2410 error owned - - fallback',
        '4160 error - - - -',
      ],
    });
  });

  it('guest clock uncalibrated', async () => {
    const scenario = SCENARIOS.guestClockUncalibrated((calibrated) => {
      clockUnderTest.calibrated = calibrated;
    });
    // Looks like a defect: the guest cannot report ARMED without a clock, so
    // the host commits without it; its fallback then releases from 0:00 at
    // +2452, as soon as it settles, while the room starts at startAtHost
    // (+3100). This guest plays about 0.65 s ahead of the room.
    expect(await project(scenario)).toEqual({
      ops: [
        ...GUEST_WARM_UP,
        '+601 setVolume(100)',
        '+601 unMute()',
        '+2401 pauseVideo()',
        '+2402 pauseVideo()',
        '+2402 seekTo(0,true)',
        '+2452 setVolume(100)',
        '+2452 unMute()',
        '+2452 pauseVideo()',
        '+2452 seekTo(0,true)',
        '+2452 setVolume(100)',
        '+2452 unMute()',
        '+2452 playVideo()',
      ],
      // Only the readiness downgrade; no ARMED.
      routes: [`peer:${HOST_PEER_ID} youtube-zero-start-capability`],
      loading: ['+100 busy', '+2401 idle'],
      marks: [
        '0 idle - - - -',
        '110 warming owned inFlight protocol -',
        '370 settling owned inFlight protocol -',
        '610 restoring-audio owned inFlight protocol -',
        '730 armed owned inFlight protocol -',
        '2410 error owned - - fallback',
        '2460 error - - - -',
      ],
    });
  });

  it('guest release-ack timeout', async () => {
    // The release at +1422 buffers without PLAYING; 1.8 s later the external
    // fallback rejoins the room position (1.851 s) and plays.
    expect(await project(SCENARIOS.guestReleaseAckTimeout)).toEqual({
      ops: [
        ...GUEST_WARM_UP,
        '+601 setVolume(100)',
        '+601 unMute()',
        '+1422 playVideo()',
        '+3222 pauseVideo()',
        '+3223 pauseVideo()',
        '+3223 seekTo(0,true)',
        '+3273 setVolume(100)',
        '+3273 unMute()',
        '+3273 pauseVideo()',
        '+3273 seekTo(1.851,true)',
        '+3273 setVolume(100)',
        '+3273 unMute()',
        '+3273 playVideo()',
      ],
      routes: [`peer:${HOST_PEER_ID} youtube-zero-start-armed`],
      loading: ['+100 busy', '+3222 idle'],
      marks: [
        '0 idle - - - -',
        '110 warming owned inFlight protocol -',
        '370 settling owned inFlight protocol -',
        '610 restoring-audio owned inFlight protocol -',
        '730 scheduled owned inFlight protocol -',
        '1430 starting owned inFlight protocol -',
        '3230 error owned - - fallback',
        '3280 error - - - -',
      ],
    });
  });

  it('host prepare failure, legacy recovery, Stage-1 YOUTUBE_STATE and Stage-2 YOUTUBE_SYNC', async () => {
    expect(await project(SCENARIOS.hostPrepareFailure)).toEqual({
      ops: [
        // Twelve hard-mute attempts, 30 ms apart, none confirmed.
        '+100 mute()',
        '+100 mute()',
        '+130 mute()',
        '+160 mute()',
        '+190 mute()',
        '+220 mute()',
        '+250 mute()',
        '+280 mute()',
        '+310 mute()',
        '+340 mute()',
        '+370 mute()',
        '+400 mute()',
        '+430 pauseVideo()',
        // The legacy recovery reloads, settles at 0:00, restores audio, plays.
        '+431 mute()',
        '+431 loadVideoById(zeroStartA1,0)',
        '+431 pauseVideo()',
        '+431 seekTo(0,true)',
        '+481 setVolume(100)',
        '+481 unMute()',
        '+481 playVideo()',
      ],
      routes: [
        `peer:${GUEST_PEER_ID} youtube-zero-start-prepare`,
        `peer:${GUEST_PEER_ID} youtube-zero-start-abort`,
        // The iframe's own PLAYING broadcast leaves first, then Stage 1.
        'broadcast:* youtube-state',
        'broadcast:* youtube-state',
        // Stage 2 (4 s later), then the heartbeats at +6000 and +9000.
        'broadcast:* youtube-sync',
        'broadcast:* youtube-sync',
        'broadcast:* youtube-sync',
      ],
      loading: ['+100 busy', '+430 idle'],
      marks: [
        '0 idle - - - -',
        '100 muting owned inFlight protocol -',
        '430 idle owned - - fallback',
        '490 idle - - - -',
      ],
    });
  });

  it('host peer connection replaced, then the 1.5 s replacement fallback', async () => {
    expect(await project(SCENARIOS.hostPeerReplaced)).toEqual({
      ops: [
        '+100 mute()',
        '+100 setVolume(100)',
        '+100 mute()',
        '+100 playVideo()',
        '+360 pauseVideo()',
        // The replacement at +400 cancels the run, which restores audio on
        // the paused iframe; 1.5 s later the legacy recovery owns the start.
        '+400 pauseVideo()',
        '+400 setVolume(100)',
        '+400 unMute()',
        '+1901 mute()',
        '+1901 loadVideoById(zeroStartA1,0)',
        '+1901 pauseVideo()',
        '+1901 seekTo(0,true)',
        '+1951 setVolume(100)',
        '+1951 unMute()',
        '+1951 playVideo()',
      ],
      routes: [
        `peer:${GUEST_PEER_ID} youtube-zero-start-prepare`,
        `peer:${GUEST_PEER_ID} youtube-zero-start-abort`,
        'broadcast:* youtube-state',
        'broadcast:* youtube-state',
        'broadcast:* youtube-sync',
        'broadcast:* youtube-sync',
      ],
      loading: ['+100 busy', '+400 idle'],
      marks: [
        '0 idle - - - -',
        '100 muting owned inFlight protocol -',
        '110 warming owned inFlight protocol -',
        '360 settling owned inFlight protocol -',
        '400 idle - - - -',
        '1900 idle owned - - fallback',
        '1960 idle - - - -',
      ],
    });
  });
});

describe('C2-0 start-owner boundary: a volume change while an owner holds hard mute (pinned 2026-10-30)', () => {
  function withVolumeChange(base: StandardScenario, at: number): StandardScenario {
    return {
      ...base,
      steps: [...base.steps, { at, run: () => bus.emit('youtube:set-volume', 40) }],
    };
  }

  it.each([
    ['warm-up', 200, ['+200 setVolume(40)', ...HOST_WARM_UP.slice(4)]],
    ['settle', 450, [...HOST_WARM_UP.slice(4), '+450 setVolume(40)']],
  ] as const)(
    'Standard host: keeps hard mute through a change during %s and restores 40',
    async (_window, at, middle) => {
      const result = await project(withVolumeChange(SCENARIOS.hostAllReady, at));
      expect(result.ops).toEqual([
        ...HOST_WARM_UP.slice(0, 4),
        ...middle,
        '+600 setVolume(40)',
        '+600 unMute()',
        '+1422 playVideo()',
        '+1422 unMute()',
      ]);
      expect(result.marks).toEqual(HOST_MARKS);
    },
  );

  it.each([
    ['warm-up', 200, ['+200 setVolume(40)', ...GUEST_WARM_UP.slice(4)]],
    ['settle', 450, [...GUEST_WARM_UP.slice(4), '+450 setVolume(40)']],
  ] as const)(
    'Standard guest: keeps hard mute through a change during %s and restores 40',
    async (_window, at, middle) => {
      const result = await project(withVolumeChange(SCENARIOS.guestAllReady, at));
      expect(result.ops).toEqual([
        ...GUEST_WARM_UP.slice(0, 4),
        ...middle,
        '+601 setVolume(40)',
        '+601 unMute()',
        '+1422 playVideo()',
        '+1422 unMute()',
      ]);
      expect(result.marks).toEqual(GUEST_MARKS);
    },
  );

  it.each([
    ['the load wait', 2_500, ['+2500 setVolume(40)']],
    ['the settle', 2_720, []],
  ] as const)(
    'guest fallback: keeps hard mute through a change during %s and releases at 40',
    async (_window, at, beforeSettle) => {
      const result = await project(withVolumeChange(SCENARIOS.guestCohortExcluded(2_600), at));
      const release = EXCLUDED_HOLD_AND_RELEASE(40);
      expect(result.ops).toEqual([
        ...GUEST_LOAD,
        ...beforeSettle,
        ...release.slice(0, 2),
        ...(at === 2_720 ? ['+2720 setVolume(40)'] : []),
        ...release.slice(2),
      ]);
      expect(result.marks).toEqual(EXCLUDED_MARKS_BEFORE_START);
    },
  );
});

describe('C2-0 start-owner boundary: a volume change in the legacy start machines (pinned 2026-10-31)', () => {
  it('host legacy recovery: keeps its reload hard-muted through a change during the settle and restores 40 at release', async () => {
    // The prepare failure hands the start to the legacy recovery at +430; its
    // reload settles hard-muted from +431 and releases at +481.
    const result = await project({
      ...SCENARIOS.hostPrepareFailure,
      steps: [
        ...SCENARIOS.hostPrepareFailure.steps,
        { at: 450, run: () => bus.emit('youtube:set-volume', 40) },
      ],
    });
    expect(result.ops).toEqual([
      '+100 mute()',
      '+100 mute()',
      '+130 mute()',
      '+160 mute()',
      '+190 mute()',
      '+220 mute()',
      '+250 mute()',
      '+280 mute()',
      '+310 mute()',
      '+340 mute()',
      '+370 mute()',
      '+400 mute()',
      '+430 pauseVideo()',
      '+431 mute()',
      '+431 loadVideoById(zeroStartA1,0)',
      '+431 pauseVideo()',
      '+431 seekTo(0,true)',
      // The change writes the volume and leaves the hard mute in place.
      '+450 setVolume(40)',
      '+481 setVolume(40)',
      '+481 unMute()',
      '+481 playVideo()',
    ]);
  });

  it('host legacy rendezvous at a -5 s offset: holds its speaker paused, not hard-muted, so a change during the hold writes the volume and unMute at once', async () => {
    const result = await project({
      name: 'host legacy rendezvous held 5 s',
      role: 'host',
      rig: { localOffsetSeconds: -5 },
      steps: [
        // A legacy start at 0:00 (no zero-start): pause, seek, play 5 s later.
        {
          at: 100,
          run: () =>
            bus.emit('youtube:auto-play', { targetTime: 0, state: 1, videoId: IDENTITY.videoId }),
        },
        { at: 1_000, run: () => bus.emit('youtube:set-volume', 40) },
      ],
      endAt: 9_000,
    });
    expect(result).toEqual({
      ops: [
        '+100 pauseVideo()',
        '+100 seekTo(0,true)',
        '+1000 setVolume(40)',
        '+1000 unMute()',
        '+5100 playVideo()',
      ],
      routes: ['broadcast:* youtube-state', 'broadcast:* youtube-sync', 'broadcast:* youtube-sync'],
      loading: [],
      marks: ['0 idle - - - -'],
    });
  });
});

describe('C2-0 start-owner boundary: Standard teardown (pinned 2026-10-30)', () => {
  it('parks a primed iframe when stopYouTubeMode runs mid-warm-up, with no detached unMute after', async () => {
    const scenario: StandardScenario = {
      ...SCENARIOS.hostAllReady,
      prepare: () => setYtPrimed(true),
      steps: [...SCENARIOS.hostAllReady.steps, { at: 250, run: () => stopYouTubeMode() }],
      endAt: 3_000,
    };
    expect(await project(scenario)).toEqual({
      ops: [
        ...HOST_WARM_UP.slice(0, 4),
        // Teardown transfers the hard mute and parks on the silent prime video.
        '+250 pauseVideo()',
        '+250 mute()',
        '+250 pauseVideo()',
        '+250 cueVideoById(r7M_P0FAOtw,0)',
      ],
      routes: [
        `peer:${GUEST_PEER_ID} youtube-zero-start-prepare`,
        `peer:${GUEST_PEER_ID} youtube-zero-start-abort`,
        'broadcast:* youtube-stop',
      ],
      loading: ['+100 busy', '+250 idle'],
      marks: [
        '0 idle - - - -',
        '100 muting owned inFlight protocol -',
        '110 warming owned inFlight protocol -',
        '250 idle - - - -',
      ],
    });
  });
});

describe('C2-0 start-owner boundary: PRO participant (pinned 2026-10-30)', () => {
  async function setUpPro(options: { localOffsetSeconds?: number } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ title: 'Synthetic video' })),
    );
    initPlayback();
    initYouTube();
    initPlaylist();
    initProtocol();
    setState('room.context', {
      kind: 'pro',
      roomId: PRO.identity.roomCode,
      role: 'member',
      coordinatorId: null,
      epoch: PRO.identity.roomEpoch,
      snapshotRevision: 1,
      capabilities: [],
    });
    setState('setup.sessionStarted', true);
    setState('audio.masterVolume', 1);
    setState('playlist.items', [
      {
        queueItemId: PRO.identity.queueItemId,
        type: 'youtube',
        name: 'Synthetic video',
        videoId: PRO.identity.videoId,
        playlistId: null,
      },
    ]);
    const api = installScriptedIframeApi();
    const fake = await loadResidentIframe(api, {
      queueItemId: PRO.identity.queueItemId,
      videoId: PRO.identity.videoId,
      positionSeconds: 0,
    });
    if (options.localOffsetSeconds) {
      setState('sync.youtubeLocalOffset', options.localOffsetSeconds);
    }
    return { fake, from: fake.__log.length, t0: Date.now(), participant: PRO.createParticipant() };
  }

  function releases(): unknown[] {
    return getProStartObservations()
      .filter(({ kind }) => kind === 'youtube-release')
      .map(({ detail }) => {
        const release = detail as Record<string, unknown>;
        return {
          path: release.path,
          timingMode: release.timingMode,
          releasedTargetSeconds: release.releasedTargetSeconds,
          localStartDelayMs: release.localStartDelayMs,
        };
      });
  }

  /** The PRO arm's hard-muted warm-up of the resident video at 0:00, PREPARE at +0. */
  const PRO_WARM_UP = [
    '+0 mute()',
    '+0 setVolume(100)',
    '+0 mute()',
    '+0 pauseVideo()',
    '+0 seekTo(0,true)',
    '+0 playVideo()',
  ];

  it('prepares a resident iframe, reports READY and applies the zero-start COMMIT', async () => {
    const { fake, from, t0, participant } = await setUpPro();
    const readyAt: number[] = [];
    participant.reportReady.mockImplementation(async () => {
      readyAt.push(Date.now() - t0);
      return 'waiting';
    });
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_000);
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect({ ops: opTrace(fake, t0, from), readyAt, releases: releases() }).toEqual({
      ops: [
        ...PRO_WARM_UP,
        '+260 pauseVideo()',
        '+340 seekTo(0,true)',
        '+500 setVolume(100)',
        '+500 unMute()',
        // COMMIT received at +1000, executeAt 700 ms later.
        '+1700 playVideo()',
      ],
      readyAt: [620],
      releases: [
        {
          path: 'prepared',
          timingMode: 'zero-start',
          releasedTargetSeconds: 0,
          localStartDelayMs: 0,
        },
      ],
    });
  });

  it('holds a direct COMMIT at a -2 s manual offset for 2 s, then plays from 0:00', async () => {
    const { fake, from, t0, participant } = await setUpPro({ localOffsetSeconds: -2 });
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'scheduled-control', null));
    await vi.advanceTimersByTimeAsync(4_000);
    expect({ ops: opTrace(fake, t0, from), releases: releases() }).toEqual({
      ops: [
        '+700 pauseVideo()',
        '+700 seekTo(0,true)',
        '+2700 seekTo(0,true)',
        '+2700 setVolume(100)',
        '+2700 unMute()',
        '+2700 playVideo()',
      ],
      releases: [
        {
          path: 'direct',
          timingMode: 'scheduled-control',
          releasedTargetSeconds: 0,
          localStartDelayMs: 2000,
        },
      ],
    });
  });

  it.each([
    ['warm-up', 100, ['+100 setVolume(40)', '+260 pauseVideo()', '+340 seekTo(0,true)']],
    ['settle', 300, ['+260 pauseVideo()', '+300 setVolume(40)', '+340 seekTo(0,true)']],
  ] as const)(
    'keeps the PRO arm hard-muted through a volume change during %s and restores 40',
    async (_window, at, middle) => {
      const { fake, from, t0, participant } = await setUpPro();
      participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
      await vi.advanceTimersByTimeAsync(at);
      bus.emit('youtube:set-volume', 40);
      await vi.advanceTimersByTimeAsync(1_000 - at);
      participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opTrace(fake, t0, from)).toEqual([
        ...PRO_WARM_UP,
        ...middle,
        '+500 setVolume(40)',
        '+500 unMute()',
        '+1700 playVideo()',
      ]);
    },
  );

  it('keeps a PRO pause gate that opens during PREPARE closed through COMMIT until it settles', async () => {
    const { fake, from, t0, participant } = await setUpPro();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(100);
    bus.emit('pro-playback:ui-control-pending', {
      token: 301,
      kind: 'pause',
      queueItemId: PRO.identity.queueItemId,
      targetSeconds: 0,
      wasPlaying: false,
    });
    await vi.advanceTimersByTimeAsync(900);
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_500);
    bus.emit('pro-playback:ui-control-settled', {
      token: 301,
      kind: 'pause',
      queueItemId: PRO.identity.queueItemId,
      status: 'applied',
      positionSeconds: 0,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(opTrace(fake, t0, from)).toEqual([
      ...PRO_WARM_UP,
      '+100 mute()',
      '+260 pauseVideo()',
      '+340 seekTo(0,true)',
      // The arm restores the gate's mute, not the app's unmuted volume.
      '+500 setVolume(100)',
      '+500 mute()',
      // The release plays silently; only the settlement unmutes.
      '+1700 playVideo()',
      '+2500 setVolume(100)',
      '+2500 unMute()',
    ]);
    expect(fake.isMuted()).toBe(false);
  });

  /** A Standard zero-start PREPARE from sender, prepared now, deciding 2.3 s later. */
  function deliverStandardPrepare(sender: ReturnType<typeof syntheticConnection>): void {
    const prepareAtHost = Date.now();
    bus.emit(
      'network:data',
      {
        type: MSG.YOUTUBE_ZERO_START_PREPARE,
        version: 1,
        runId: 'synthetic-run',
        sequence: 1,
        queueItemId: PRO.identity.queueItemId,
        videoId: PRO.identity.videoId,
        subIndex: 0,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_100,
        hostPlatform: 'other',
      },
      sender,
    );
  }

  it('cannot begin a Standard zero-start in a PRO room, and drops a PREPARE whose sender is not its Standard host link', async () => {
    const { fake, from } = await setUpPro();
    const sender = syntheticConnection('pro-peer-1');
    expect(canUseYouTubeZeroStart()).toBe(false);
    deliverStandardPrepare(sender);
    await vi.advanceTimersByTimeAsync(3_000);
    // A PRO member reads as a zero-start guest whose Standard host peer is
    // null (no network.hostConn), so handlePrepare refuses this sender
    // (zero-start.ts:561-562). On its own the row does not show that the
    // room kind separates the two controllers; the next row adds the link.
    expect(fake.__log.slice(from)).toEqual([]);
    expect(vi.mocked(safeSend)).not.toHaveBeenCalled();
    expect(vi.mocked(sendToHost)).not.toHaveBeenCalled();
    expect(canUseYouTubeZeroStart()).toBe(false);
  });

  it('arms for a PREPARE from a Standard host link even in a PRO room: zero-start.ts has no room-kind gate (synthetic state, no known production path)', async () => {
    const { fake, from, t0 } = await setUpPro();
    // Expected today: no production path is known to a PRO member that also
    // holds a Standard host link. Given one, with its queue authority ready,
    // the Standard controller takes the PREPARE like a Standard guest. So
    // what keeps a PRO room on the PRO arm is that it has no Standard host
    // link, not a room-kind check in the zero-start controller.
    const sender = syntheticConnection('pro-peer-1');
    setState('network.appRole', 'guest');
    setState('network.hostConn', sender);
    markQueueAuthorityReady(sender);
    resetInboundRateLimit(sender.peer);
    deliverStandardPrepare(sender);
    await vi.advanceTimersByTimeAsync(1_000);
    expect({
      ops: opTrace(fake, t0, from),
      // The link also receives readiness re-advertisements (CAPABILITY),
      // which the Standard wire golden pins; this row reads the rest.
      sent: vi
        .mocked(safeSend)
        .mock.calls.map(([conn, frame]) => ({
          to: (conn as { peer: string }).peer,
          type: (frame as { type: string }).type,
        }))
        .filter(({ type }) => type !== MSG.YOUTUBE_ZERO_START_CAPABILITY)
        .map(({ to, type }) => `${to} ${type}`),
      canBegin: canUseYouTubeZeroStart(),
    }).toEqual({
      // The Standard guest's hard-muted warm-up and settle of the resident video.
      ops: [
        '+0 mute()',
        '+0 setVolume(100)',
        '+0 mute()',
        '+0 playVideo()',
        '+260 pauseVideo()',
        '+340 seekTo(0,true)',
        '+500 setVolume(100)',
        '+500 unMute()',
      ],
      sent: ['pro-peer-1 youtube-zero-start-armed'],
      canBegin: false,
    });
  });
});
